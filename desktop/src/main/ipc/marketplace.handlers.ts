import {
  assertSafeCloneTarget,
  deriveCloneDirName,
  FormatDetector,
  getAvailableAgents,
  getAgentsWithCapability,
  GitOperations,
  isMarketplaceErrorCode,
  InstalledScanner,
  MarketplaceInstaller,
  MarketplaceIntegrityError,
  MarketplaceIntegrityInstaller,
  MarketplaceRegistry,
  MarketplaceTransaction,
  AgentTranslator,
  HookTranslator,
  McpTranslator,
  SkillTranslator,
  buildSnapshot,
  diffAgainstSnapshot,
  validateSourceUrl,
  type AgentName,
  type DetectedPlugin,
  type InstalledPlugin,
  type InstallSelection,
  type MarketplaceInstallMode,
  type MarketplaceInstallPreview,
  type MarketplaceSource,
  type MarketplaceTransactionalResult,
  type NativeMarketplaceConfig,
  type NewArtifact,
  type SourceUpdate,
} from 'muxbase/core';
import { app } from 'electron';
import { existsSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import { IPC } from '../../shared/ipc-channels.js';
import type {
  MarketplaceBrowseRequest,
  MarketplaceBrowseResponse,
  MarketplaceCheckUpdatesResponse,
  MarketplaceAckUpdatesRequest,
  MarketplaceInstallItemRequest,
  MarketplaceInstallRequest,
  MarketplaceInstallResponse,
  MarketplacePreviewRequest,
  MarketplacePreviewResponse,
  MarketplaceScanResponse,
  MarketplaceSourceAddRequest,
  MarketplaceSourceAddResponse,
  MarketplaceSourceRemoveRequest,
  MarketplaceSourceUpdateRequest,
  MarketplaceUninstallItemRequest,
  MarketplaceUninstallRequest,
  MarketplaceUninstallResponse,
} from '../../shared/ipc-types.js';
import { log } from '../services/Logger.js';
import { formatError } from '../utils/formatError.js';
import { secureHandle } from './ipc-security.js';

const CLONES_DIR = path.join(os.homedir(), '.muxbase', 'marketplaces');

// Singleton — one registry per app lifetime, backed by Electron's userData dir
// (cross-platform: macOS ~/Library/Application Support/MuxBase, Windows %APPDATA%/MuxBase, Linux ~/.config/MuxBase)
let registryInstance: MarketplaceRegistry | null = null;
let recoveryFailure: Error | null = null;
let recoverySucceeded = false;

function structuredMarketplaceError(error: unknown): {
  affectedPaths?: string[];
  errorCode?: MarketplaceInstallResponse['errorCode'];
} {
  if (typeof error !== 'object' || error === null || !('code' in error)) return {};
  const code = error.code;
  if (!isMarketplaceErrorCode(code)) return {};

  const affectedPaths = 'affectedPaths' in error && Array.isArray(error.affectedPaths)
    ? error.affectedPaths.filter((entry): entry is string => typeof entry === 'string')
    : [];
  const artifactPath = 'artifactPath' in error && typeof error.artifactPath === 'string'
    ? error.artifactPath
    : undefined;
  return {
    errorCode: code,
    ...(affectedPaths.length > 0
      ? { affectedPaths }
      : artifactPath ? { affectedPaths: [artifactPath] } : {}),
  };
}

function marketplaceJournalDir(): string {
  return path.join(app.getPath('userData'), 'marketplace-transactions');
}

function ensureMarketplaceRecovery(): void {
  if (recoveryFailure) throw recoveryFailure;
  if (recoverySucceeded) return;
  const recovery = MarketplaceTransaction.recover(marketplaceJournalDir());
  if (recovery.rollbackFailures.length > 0) {
    recoveryFailure = new MarketplaceIntegrityError(
      'ROLLBACK_FAILED',
      'A previous marketplace transaction could not be recovered safely',
      recovery.rollbackFailures[0],
      recovery.rollbackFailures,
    );
    throw recoveryFailure;
  }
  recoverySucceeded = true;
}

function getRegistry(): MarketplaceRegistry {
  ensureMarketplaceRecovery();
  if (!registryInstance) {
    const registryPath = path.join(app.getPath('userData'), 'marketplace-registry.json');
    registryInstance = new MarketplaceRegistry(registryPath);
  }
  return registryInstance;
}

type ResolvedPlugin = {
  source: MarketplaceSource;
  plugin: DetectedPlugin;
  nativeConfig: NativeMarketplaceConfig;
};

function resolvePlugin(
  sourceUrl: string,
  pluginId: string,
  detector: FormatDetector,
): { ok: true; data: ResolvedPlugin } | { ok: false; error: string } {
  const source = getRegistry().getData().sources.find((s) => s.url === sourceUrl);
  if (!source || !source.detectedFormat) return { ok: false, error: 'Source not found' };
  if (!existsSync(source.clonePath)) return { ok: false, error: 'Source clone not found on disk — try removing and re-adding the source' };

  const plugin = detector.detectPlugins(source.clonePath, source.detectedFormat).find((p) => p.id === pluginId);
  if (!plugin) return { ok: false, error: `Plugin "${pluginId}" not found in source` };

  return {
    ok: true,
    data: {
      source,
      plugin,
      nativeConfig: {
        marketplaceUrl: source.url,
        marketplaceName: source.name,
        pluginId: plugin.id,
        sourceFormat: source.detectedFormat,
        clonePath: source.clonePath,
        pluginVersion: plugin.version,
      },
    },
  };
}

function getSelection(request: MarketplacePreviewRequest | MarketplaceInstallRequest): {
  mode: MarketplaceInstallMode;
  selection?: InstallSelection;
} {
  if (request.mode === 'full') return { mode: 'full' };
  return {
    mode: 'selected',
    selection: {
      skills: request.selectedSkills,
      mcpServers: request.selectedMcpServers,
      agents: request.selectedAgents,
      hooks: request.selectedHooks,
      jsPlugins: request.selectedJsPlugins,
    },
  };
}

// Check whether a specific item still exists on disk for a given agent after removal.
// Uses the same path logic as InstalledScanner so there is one source of truth.
function itemExistsOnDisk(
  type: 'skill' | 'mcpServer' | 'agent' | 'hook',
  name: string,
  agent: AgentName,
  pluginId?: string,
): boolean {
  switch (type) {
    case 'skill':
      return existsSync(path.join(SkillTranslator.skillsDir(agent), name));
    case 'mcpServer':
      return McpTranslator.listServerNames(agent).includes(name);
    case 'agent': {
      const scopedName = pluginId ? `${pluginId}__${name}` : name;
      return existsSync(path.join(AgentTranslator.agentsDir(agent), `${scopedName}.md`));
    }
    case 'hook':
      return HookTranslator.listInstalled(agent).some((h) => h.event === name && h.pluginId === pluginId);
  }
}

export function registerMarketplaceHandlers(): void {
  const git = new GitOperations();
  const detector = new FormatDetector();
  const installer = new MarketplaceInstaller();
  const integrityInstaller = new MarketplaceIntegrityInstaller();

  secureHandle(IPC.MARKETPLACE_SOURCES_LIST, () => {
    return getRegistry().getData().sources;
  });

  secureHandle(IPC.MARKETPLACE_SOURCE_ADD, async (_event, request: MarketplaceSourceAddRequest): Promise<MarketplaceSourceAddResponse> => {
    const urlError = validateSourceUrl(request.url);
    if (urlError) return { success: false, error: urlError };

    try {
      ensureMarketplaceRecovery();
      const name = deriveCloneDirName(request.url);
      const clonePath = path.join(CLONES_DIR, name);

      const headSha = await git.ensureClone(request.url, clonePath);
      const detectedFormat = detector.detectFormat(clonePath);

      // Snapshot the items present at add time so the first update check has a real
      // baseline to diff against. Without this, items pushed to the remote between
      // adding the source and the first check would silently fold into the baseline
      // and never be reported as new.
      const initialArtifacts = detectedFormat
        ? buildSnapshot(detector.detectPlugins(clonePath, detectedFormat))
        : {};

      const source: MarketplaceSource = {
        url: request.url,
        name,
        clonePath,
        detectedFormat,
        headSha,
        lastUpdated: new Date().toISOString(),
        lastSeenArtifacts: initialArtifacts,
      };

      getRegistry().addSource(source);
      log.info('ipc:marketplace', 'Source added', { url: request.url, format: detectedFormat });
      return { success: true, source };
    } catch (error) {
      log.error('ipc:marketplace', 'Failed to add source', error);
      return { success: false, error: formatError(error) };
    }
  });

  secureHandle(IPC.MARKETPLACE_SOURCE_REMOVE, (_event, request: MarketplaceSourceRemoveRequest) => {
    try {
      const registry = getRegistry();
      const source = registry.getData().sources.find((s: MarketplaceSource) => s.url === request.url);

      // Block removal when installed plugins from this source still exist — removing the clone
      // first would orphan their artifacts in agent configs with no way to uninstall them later.
      const installedFromSource = registry.getData().installed.filter((i) => i.sourceUrl === request.url);
      if (installedFromSource.length > 0) {
        const names = installedFromSource.map((i) => i.pluginId).join(', ');
        return { success: false, error: `Uninstall all plugins first: ${names}` };
      }

      registry.removeSource(request.url);
      // Clean up the local clone so disk doesn't accumulate orphaned repos
      if (source?.clonePath && existsSync(source.clonePath)) {
        try { rmSync(source.clonePath, { recursive: true, force: true }); } catch { /* non-fatal */ }
      }
      log.info('ipc:marketplace', 'Source removed', { url: request.url });
      return { success: true };
    } catch (error) {
      log.error('ipc:marketplace', 'Failed to remove source', error);
      return { success: false, error: formatError(error) };
    }
  });

  secureHandle(IPC.MARKETPLACE_SOURCE_UPDATE, async (_event, request: MarketplaceSourceUpdateRequest) => {
    const urlError = validateSourceUrl(request.url);
    if (urlError) return { success: false, error: urlError };

    try {
      const registry = getRegistry();
      const source = registry.getData().sources.find((s: MarketplaceSource) => s.url === request.url);
      if (!source) return { success: false, error: 'Source not found' };

      // pull re-fetches from origin — re-run the DNS-resolution guard on the current host.
      await assertSafeCloneTarget(request.url);
      await git.pull(source.clonePath);
      const headSha = await git.getHeadSha(source.clonePath);
      // Invalidate description cache so updated SKILL.md/agent frontmatter is reflected
      detector.clearDescriptionCache();
      const detectedFormat = detector.detectFormat(source.clonePath);
      // Rebaseline the snapshot to the freshly pulled state. A manual sync happens in
      // Settings where the user already sees the refreshed plugin list, so we update
      // silently (no popup) and keep lastSeenArtifacts in step with reality — otherwise
      // the next project-entry check would re-flag items the user just looked at.
      const lastSeenArtifacts = detectedFormat
        ? buildSnapshot(detector.detectPlugins(source.clonePath, detectedFormat))
        : {};
      // Re-check recovery health before mutating: an install that ran concurrently while
      // the pull was in flight may have poisoned the registry with a rollback failure.
      ensureMarketplaceRecovery();
      registry.updateSource(request.url, {
        lastUpdated: new Date().toISOString(),
        detectedFormat,
        lastSeenArtifacts,
        headSha,
      });

      log.info('ipc:marketplace', 'Source updated', { url: request.url });
      return { success: true };
    } catch (error) {
      log.error('ipc:marketplace', 'Failed to update source', error);
      return { success: false, error: formatError(error) };
    }
  });

  secureHandle(IPC.MARKETPLACE_BROWSE, (_event, request: MarketplaceBrowseRequest): MarketplaceBrowseResponse => {
    try {
      const source = getRegistry().getData().sources.find((s: MarketplaceSource) => s.url === request.sourceUrl);
      if (!source || !source.detectedFormat) {
        return { plugins: [], error: 'Source not found or format not detected' };
      }
      const plugins = detector.detectPlugins(source.clonePath, source.detectedFormat);
      return { plugins };
    } catch (error) {
      return { plugins: [], error: formatError(error) };
    }
  });

  const buildPreview = async (
    request: MarketplacePreviewRequest | MarketplaceInstallRequest,
  ): Promise<{
    nativeConfig: NativeMarketplaceConfig;
    plugin: DetectedPlugin;
    preview: MarketplaceInstallPreview;
    selection?: InstallSelection;
    mode: MarketplaceInstallMode;
  }> => {
    const resolved = resolvePlugin(request.sourceUrl, request.pluginId, detector);
    if (!resolved.ok) throw new Error(resolved.error);
    const sourceHeadSha = await git.getHeadSha(resolved.data.source.clonePath);
    const allAgents = getAgentsWithCapability(await getAvailableAgents(), 'marketplaceMcp');
    const { mode, selection } = getSelection(request);
    const preview = installer.preview(
      resolved.data.plugin,
      allAgents,
      resolved.data.nativeConfig,
      selection,
      { sourceUrl: request.sourceUrl, headSha: sourceHeadSha },
      mode,
    );
    return {
      nativeConfig: resolved.data.nativeConfig,
      plugin: resolved.data.plugin,
      preview,
      mode,
      selection,
    };
  };

  secureHandle(IPC.MARKETPLACE_PREVIEW, async (_event, request: MarketplacePreviewRequest): Promise<MarketplacePreviewResponse> => {
    try {
      const { preview } = await buildPreview(request);
      return { success: true, preview };
    } catch (error) {
      log.error('ipc:marketplace', 'Failed to preview plugin installation', error);
      return {
        success: false,
        error: formatError(error),
        ...structuredMarketplaceError(error),
      };
    }
  });

  secureHandle(IPC.MARKETPLACE_INSTALL, async (_event, request: MarketplaceInstallRequest): Promise<MarketplaceInstallResponse> => {
    try {
      const journalDir = marketplaceJournalDir();
      const { nativeConfig, plugin, preview, selection, mode } = await buildPreview(request);
      if (preview.digest !== request.previewDigest) {
        return { success: false, error: 'Marketplace source changed; review the installation again' };
      }
      const allAgents = getAgentsWithCapability(await getAvailableAgents(), 'marketplaceMcp');
      const registry = getRegistry();
      const previousRecord = registry.getInstalled(request.pluginId, request.sourceUrl);
      const sharedOwnershipManifests = registry.getData().installed
        .filter((installed) => installed.sourceUrl === request.sourceUrl && installed.pluginId !== request.pluginId)
        .flatMap((installed) => installed.ownershipManifest ? [installed.ownershipManifest] : []);
      const result = integrityInstaller.install(
        plugin,
        allAgents,
        nativeConfig,
        selection,
        mode,
        {
          journalDir,
          legacyRecord: Boolean(previousRecord && !previousRecord.ownershipManifest),
          sharedOwnershipManifests,
          prepareRegistryMutation: (transactionalResult: MarketplaceTransactionalResult) => getRegistry().prepareAddInstalled({
            pluginId: plugin.id,
            sourceUrl: request.sourceUrl,
            installedAt: new Date().toISOString(),
            agents: transactionalResult.agents,
            ownershipManifest: transactionalResult.ownershipManifest,
            selectedArtifacts: {
              skills: selection?.skills ?? plugin.skills.map((s) => s.name),
              mcpServers: selection?.mcpServers ?? plugin.mcpServers.map((s) => s.name),
              agentNames: selection?.agents ?? plugin.agents.map((a) => a.name),
              hookEvents: plugin.hooks.map((h) => h.event),
              jsPluginNames: plugin.jsPlugins.map((j) => j.name),
              usedNativeRegistration: mode === 'full' && !!nativeConfig,
            },
          }),
          ownershipManifest: previousRecord?.ownershipManifest,
        },
      );

      log.info('ipc:marketplace', 'Plugin installed', { pluginId: plugin.id, agents: Object.keys(result.agents) });
      return { success: true, result };
    } catch (error) {
      log.error('ipc:marketplace', 'Failed to install plugin', error);
      const structuredError = structuredMarketplaceError(error);
      if (structuredError.errorCode === 'ROLLBACK_FAILED' && error instanceof Error) recoveryFailure = error;
      return {
        success: false,
        error: formatError(error),
        ...structuredError,
      };
    }
  });

  secureHandle(IPC.MARKETPLACE_UNINSTALL, async (_event, request: MarketplaceUninstallRequest): Promise<MarketplaceUninstallResponse> => {
    try {
      const journalDir = marketplaceJournalDir();
      const resolved = resolvePlugin(request.sourceUrl, request.pluginId, detector);
      if (!resolved.ok) return { success: false, error: resolved.error };

      const { plugin, nativeConfig } = resolved.data;
      const allAgents = getAgentsWithCapability(await getAvailableAgents(), 'marketplaceMcp');

      // Restrict uninstall to only the artifacts that were actually installed
      const record = getRegistry().getInstalled(request.pluginId, request.sourceUrl);
      const uninstallSelection: InstallSelection | undefined = record?.selectedArtifacts
        ? { skills: record.selectedArtifacts.skills, mcpServers: record.selectedArtifacts.mcpServers, agents: record.selectedArtifacts.agentNames }
        : undefined;

      // Only invoke native unregistration when native registration was used at install time.
      // Partial installs bypassed native registration, so nativeConfig must not be passed.
      // Marketplace-level cleanup (extraKnownMarketplaces, known_marketplaces, clone,
      // [marketplaces.*]) is shared by all plugins from the same source — only request it
      // when no native sibling plugins from this marketplace remain installed.
      //
      // Partial-only siblings (usedNativeRegistration === false) never touched the native
      // marketplace config, so they must NOT block its cleanup when the last native sibling
      // is uninstalled — otherwise the registration would be orphaned (uninstalling those
      // partial siblings later skips native cleanup entirely). Legacy records without
      // selectedArtifacts default to "native" to preserve pre-selection behavior.
      const remainingNativeSiblings = getRegistry()
        .getData()
        .installed
        .filter((i) =>
          i.sourceUrl === request.sourceUrl
          && i.pluginId !== request.pluginId
          && i.selectedArtifacts?.usedNativeRegistration !== false,
        )
        .length;
      const effectiveNativeConfig = record?.selectedArtifacts?.usedNativeRegistration === false
        ? undefined
        : nativeConfig
          ? { ...nativeConfig, isLastPluginFromMarketplace: remainingNativeSiblings === 0 }
          : undefined;

      const uninstallResult = integrityInstaller.uninstall(
        plugin,
        allAgents,
        effectiveNativeConfig,
        uninstallSelection,
        {
          journalDir,
          prepareRegistryMutation: () => getRegistry().prepareRemoveInstalled(request.pluginId, request.sourceUrl),
          ownershipManifest: record?.ownershipManifest,
        },
      );

      log.info('ipc:marketplace', 'Plugin uninstalled', { pluginId: request.pluginId });
      return { success: true, preservedArtifacts: uninstallResult.preservedArtifacts };
    } catch (error) {
      log.error('ipc:marketplace', 'Failed to uninstall plugin', error);
      const structuredError = structuredMarketplaceError(error);
      if (structuredError.errorCode === 'ROLLBACK_FAILED' && error instanceof Error) recoveryFailure = error;
      return {
        success: false,
        error: formatError(error),
        ...structuredError,
      };
    }
  });

  secureHandle(IPC.MARKETPLACE_INSTALLED_LIST, () => {
    return getRegistry().getData().installed;
  });

  secureHandle(IPC.MARKETPLACE_SCAN_INSTALLED, async (): Promise<MarketplaceScanResponse> => {
    try {
      const agents = await getAvailableAgents();
      const registry = getRegistry();
      const installed = registry.getData().installed;
      const scanner = new InstalledScanner();
      const items = scanner.scan(agents, installed);

      // Reconcile items whose registry attribution is missing or incomplete. This covers
      // three cases in one pass:
      //   - skills/mcp: no on-disk marker, so they show as 'external' when the registry
      //     record is gone. Attribute by content-hash match (skills) or name match (mcp).
      //   - agents: pluginId is embedded in the filename so the scanner sets source='amux'
      //     but sourceUrl is absent when no registry record exists (e.g. after reinstall).
      //     Attribute by pluginId match — no hash needed.
      // For all types: scan every known source clone, find any plugin that owns the item,
      // and upsert a registry record so the item appears under its plugin group.
      const needsAttribution = items.filter(
        (i) => i.source === 'external' || (i.source === 'amux' && !i.sourceUrl),
      );
      let needsRescan = false;
      if (needsAttribution.length > 0) {
        const { createHash } = await import('crypto');
        const { readFileSync: readFile } = await import('fs');
        const hashFile = (filePath: string): string => {
          try {
            if (!existsSync(filePath)) return 'missing';
            return createHash('sha1').update(readFile(filePath, 'utf-8')).digest('hex');
          } catch { return 'unreadable'; }
        };

        for (const source of registry.getData().sources) {
          if (!source.detectedFormat || !existsSync(source.clonePath)) continue;
          const plugins = detector.detectPlugins(source.clonePath, source.detectedFormat);
          for (const plugin of plugins) {
            const existing = registry.getInstalled(plugin.id, source.url);
            const sel = existing?.selectedArtifacts ?? {
              skills: [], mcpServers: [], agentNames: [],
              hookEvents: [], jsPluginNames: [], usedNativeRegistration: false,
            };
            let updatedSel = { ...sel };
            let changed = false;

            for (const item of needsAttribution) {
              if (item.type === 'skill') {
                const sourceSkill = plugin.skills.find((s) => s.name === item.name);
                if (!sourceSkill || updatedSel.skills.includes(item.name)) continue;
                // Content-hash guard: prevent a hand-installed skill with the same name
                // as a plugin skill from being incorrectly claimed.
                const sourceHash = hashFile(sourceSkill.path);
                const contentMatches = item.agents.some((agent) => {
                  const installedPath = path.join(SkillTranslator.skillsDir(agent), item.name, 'SKILL.md');
                  return hashFile(installedPath) === sourceHash;
                });
                if (contentMatches) {
                  updatedSel = { ...updatedSel, skills: [...updatedSel.skills, item.name] };
                  changed = true;
                }
              } else if (item.type === 'mcpServer') {
                const sourceMcp = plugin.mcpServers.find((s) => s.name === item.name);
                if (!sourceMcp || updatedSel.mcpServers.includes(item.name)) continue;
                updatedSel = { ...updatedSel, mcpServers: [...updatedSel.mcpServers, item.name] };
                changed = true;
              } else if (item.type === 'agent') {
                // Agents carry pluginId on disk — only attribute to the matching plugin.
                if (item.pluginId !== plugin.id) continue;
                const sourceAgent = plugin.agents.find((a) => a.name === item.name);
                if (!sourceAgent || updatedSel.agentNames.includes(item.name)) continue;
                updatedSel = { ...updatedSel, agentNames: [...updatedSel.agentNames, item.name] };
                changed = true;
              }
            }

            if (changed) {
              registry.addInstalled({
                pluginId: plugin.id,
                sourceUrl: source.url,
                installedAt: existing?.installedAt ?? new Date().toISOString(),
                agents: existing?.agents ?? {},
                selectedArtifacts: updatedSel,
              });
              needsRescan = true;
            }
          }
        }
      }

      const finalItems = needsRescan
        ? scanner.scan(agents, registry.getData().installed)
        : items;

      return { items: finalItems };
    } catch (error) {
      log.error('ipc:marketplace', 'Failed to scan installed items', error);
      return { items: [], error: formatError(error) };
    }
  });

  secureHandle(IPC.MARKETPLACE_UNINSTALL_ITEM, async (_event, request: MarketplaceUninstallItemRequest) => {
    try {
      const skillTranslator = new SkillTranslator();
      const mcpTranslator = new McpTranslator();
      const agentTranslator = new AgentTranslator();
      const hookTranslator = new HookTranslator();

      for (const agent of request.agents) {
        switch (request.type) {
          case 'skill':
            skillTranslator.uninstallForAgent(request.name, agent);
            break;
          case 'mcpServer':
            mcpTranslator.uninstallForAgent(request.name, agent);
            break;
          case 'agent':
            agentTranslator.uninstallForAgent(request.name, agent, request.pluginId);
            break;
          case 'hook':
            if (request.pluginId) {
              hookTranslator.uninstallEventForAgent(request.pluginId, request.name, agent);
            }
            break;
        }
      }

      // Sync selectedArtifacts only when the item is fully gone from disk (no remaining
      // agent still has it). If the item was removed from a subset of agents but still
      // exists on others, leave selectedArtifacts untouched — the scanner still needs it
      // there to attribute the item to this plugin and keep it in its plugin group.
      //
      // Do NOT touch the agents map — it is plugin-level presence metadata maintained
      // only by MARKETPLACE_INSTALL / MARKETPLACE_INSTALL_ITEM.
      if (request.pluginId && request.sourceUrl) {
        const registry = getRegistry();
        const record = registry.getInstalled(request.pluginId, request.sourceUrl);
        if (record && !record.selectedArtifacts) {
          // Legacy record with no selectedArtifacts — remove it entirely so the source
          // can be deleted once the user has uninstalled all plugins from it.
          const removedSet = new Set(request.agents);
          const allAgents = await getAvailableAgents();
          const remainingAgents = allAgents.filter((a) => !removedSet.has(a));
          const stillOnDisk = remainingAgents.some((agent) => itemExistsOnDisk(request.type, request.name, agent, request.pluginId));
          if (!stillOnDisk) registry.removeInstalled(request.pluginId, request.sourceUrl);
        }
        if (record?.selectedArtifacts) {
          const removedSet = new Set(request.agents);
          const allAgents = await getAvailableAgents();
          const remainingAgents = allAgents.filter((a) => !removedSet.has(a));
          const stillOnDisk = remainingAgents.some((agent) => itemExistsOnDisk(request.type, request.name, agent, request.pluginId));

          if (!stillOnDisk) {
            const sel = record.selectedArtifacts;
            let updated = { ...sel };
            switch (request.type) {
              case 'skill':
                updated = { ...updated, skills: updated.skills.filter((s) => s !== request.name) };
                break;
              case 'mcpServer':
                updated = { ...updated, mcpServers: updated.mcpServers.filter((s) => s !== request.name) };
                break;
              case 'agent':
                updated = { ...updated, agentNames: updated.agentNames.filter((s) => s !== request.name) };
                break;
              case 'hook':
                updated = { ...updated, hookEvents: updated.hookEvents.filter((s) => s !== request.name) };
                break;
            }
            const isEmpty =
              updated.skills.length === 0 &&
              updated.mcpServers.length === 0 &&
              updated.agentNames.length === 0 &&
              updated.hookEvents.length === 0 &&
              updated.jsPluginNames.length === 0;
            if (isEmpty) {
              registry.removeInstalled(request.pluginId, request.sourceUrl);
            } else {
              registry.addInstalled({ ...record, selectedArtifacts: updated });
            }
          }
        }
      }

      log.info('ipc:marketplace', 'Item uninstalled', { type: request.type, name: request.name, agents: request.agents });
      return { success: true };
    } catch (error) {
      log.error('ipc:marketplace', 'Failed to uninstall item', error);
      return { success: false, error: formatError(error) };
    }
  });

  secureHandle(IPC.MARKETPLACE_INSTALL_ITEM, async (_event, request: MarketplaceInstallItemRequest) => {
    try {
      const resolved = resolvePlugin(request.sourceUrl, request.pluginId, detector);
      if (!resolved.ok) return { success: false, error: resolved.error };

      const { plugin } = resolved.data;
      const skillTranslator = new SkillTranslator();
      const mcpTranslator = new McpTranslator();
      const agentTranslator = new AgentTranslator();

      for (const agent of request.agents) {
        switch (request.type) {
          case 'skill': {
            const entry = plugin.skills.find((s) => s.name === request.name);
            if (entry) skillTranslator.installForAgent(entry, agent);
            break;
          }
          case 'mcpServer': {
            const entry = plugin.mcpServers.find((s) => s.name === request.name);
            if (entry) mcpTranslator.installForAgent(entry, agent);
            break;
          }
          case 'agent': {
            const entry = (plugin.agents ?? []).find((a) => a.name === request.name);
            if (entry) agentTranslator.installForAgent(entry, agent, request.pluginId);
            break;
          }
          case 'hook':
            // Hooks are all-or-nothing per plugin; per-item hook install is not supported.
            break;
        }
      }

      // Update registry: ensure the item's name is recorded in selectedArtifacts so the
      // scanner can attribute it correctly.
      const registry = getRegistry();
      const record = registry.getInstalled(request.pluginId, request.sourceUrl);
      if (record) {
        const sel = record.selectedArtifacts ?? {
          skills: [],
          mcpServers: [],
          agentNames: [],
          hookEvents: [],
          jsPluginNames: [],
          usedNativeRegistration: false,
        };
        let updatedSel = { ...sel };
        switch (request.type) {
          case 'skill':
            if (!updatedSel.skills.includes(request.name))
              updatedSel = { ...updatedSel, skills: [...updatedSel.skills, request.name] };
            break;
          case 'mcpServer':
            if (!updatedSel.mcpServers.includes(request.name))
              updatedSel = { ...updatedSel, mcpServers: [...updatedSel.mcpServers, request.name] };
            break;
          case 'agent':
            if (!updatedSel.agentNames.includes(request.name))
              updatedSel = { ...updatedSel, agentNames: [...updatedSel.agentNames, request.name] };
            break;
          case 'hook':
            break;
        }
        registry.addInstalled({ ...record, selectedArtifacts: updatedSel });
      }

      log.info('ipc:marketplace', 'Item installed', { type: request.type, name: request.name, agents: request.agents });
      return { success: true };
    } catch (error) {
      log.error('ipc:marketplace', 'Failed to install item', error);
      return { success: false, error: formatError(error) };
    }
  });

  secureHandle(IPC.MARKETPLACE_CHECK_UPDATES, async (): Promise<MarketplaceCheckUpdatesResponse> => {
    const registry = getRegistry();
    const sources = registry.getData().sources;
    const allUpdates: SourceUpdate[] = [];
    // Snapshots keyed by sourceUrl — returned to the renderer so it can pass them back
    // via MARKETPLACE_ACK_UPDATES once updates are installed or dismissed.
    const snapshots: Record<string, ReturnType<typeof buildSnapshot>> = {};

    // Invalidate cached descriptions once so freshly pulled SKILL.md/frontmatter is reflected.
    detector.clearDescriptionCache();

    for (const source of sources) {
      if (!source.detectedFormat || !existsSync(source.clonePath)) continue;
      try {
        // Best-effort pull — a failed fetch shouldn't abort checking other sources.
        await git.pull(source.clonePath).catch((error) => {
          log.warn('ipc:marketplace', 'check-updates: pull failed', { url: source.url, error: formatError(error) });
        });

        const detectedFormat = detector.detectFormat(source.clonePath);
        if (!detectedFormat) continue;

        const plugins = detector.detectPlugins(source.clonePath, detectedFormat);
        const snapshot = buildSnapshot(plugins);
        snapshots[source.url] = snapshot;

        // First check (no prior snapshot) establishes the baseline silently — we don't
        // surface every existing item as "new" the first time a source is checked.
        const isFirstCheck = source.lastSeenArtifacts === undefined;
        if (!isFirstCheck) {
          const raw = diffAgainstSnapshot(source, plugins, source.lastSeenArtifacts);
          // 'new' items surface regardless (discovery). 'updated' items only matter when
          // the user actually installed that item — an uninstalled item's local clone
          // just tracks the marketplace, so there is nothing stale to reinstall.
          const filtered = filterUpdatesByInstalled(raw, source.url, registry.getData().installed);
          // Replace the check-time changedAt stamp with the artifact's real git commit
          // date from the repo, so the UI shows when it actually changed upstream.
          await stampCommitDates(filtered, plugins, source.clonePath, git);
          allUpdates.push(...filtered);
        }

        // Only advance detectedFormat and lastUpdated here. lastSeenArtifacts is
        // advanced by MARKETPLACE_ACK_UPDATES after the user installs or dismisses —
        // advancing it now would make unacknowledged updates invisible on the next check.
        registry.updateSource(source.url, {
          detectedFormat,
          lastUpdated: new Date().toISOString(),
          ...(isFirstCheck ? { lastSeenArtifacts: snapshot } : {}),
        });
      } catch (error) {
        log.warn('ipc:marketplace', 'check-updates: source failed', { url: source.url, error: formatError(error) });
      }
    }

    log.info('ipc:marketplace', 'Checked for updates', { sources: sources.length, updates: allUpdates.length });
    return { updates: allUpdates, snapshots };
  });

  secureHandle(IPC.MARKETPLACE_ACK_UPDATES, (_event, request: MarketplaceAckUpdatesRequest): void => {
    const registry = getRegistry();
    for (const { sourceUrl, snapshot } of request.entries) {
      registry.updateSource(sourceUrl, { lastSeenArtifacts: snapshot });
    }
  });
}

// Replace each artifact's check-time changedAt with the file's real committer date so the
// UI shows when it changed upstream. MCP servers and hooks have no single backing file, so
// they fall back to the repo's latest commit; unresolvable paths keep the check-time stamp.
async function stampCommitDates(
  updates: SourceUpdate[],
  plugins: DetectedPlugin[],
  clonePath: string,
  git: GitOperations,
): Promise<void> {
  if (updates.length === 0) return;

  const pluginsById = new Map(plugins.map((p) => [p.id, p]));

  const pathFor = (pluginId: string, artifact: NewArtifact): string | undefined => {
    const plugin = pluginsById.get(pluginId);
    if (!plugin) return undefined;
    switch (artifact.type) {
      case 'skill': return plugin.skills.find((s) => s.name === artifact.name)?.path;
      case 'agent': return plugin.agents.find((a) => a.name === artifact.name)?.path;
      case 'jsPlugin': return plugin.jsPlugins.find((j) => j.name === artifact.name)?.path;
      default: return undefined; // mcpServer / hook have no single file
    }
  };

  // Cache per-path lookups so shared files aren't queried twice.
  const cache = new Map<string, string>();
  const commitDate = async (filePath: string): Promise<string> => {
    const cached = cache.get(filePath);
    if (cached !== undefined) return cached;
    const date = await git.getFileCommitDate(clonePath, filePath);
    cache.set(filePath, date);
    return date;
  };

  let repoDate: string | undefined;
  const repoFallback = async (): Promise<string> => {
    if (repoDate === undefined) repoDate = await git.getLastCommitDate(clonePath).catch(() => '');
    return repoDate;
  };

  for (const update of updates) {
    for (const artifact of update.newArtifacts) {
      const filePath = pathFor(update.pluginId, artifact);
      const date = filePath ? await commitDate(filePath) : await repoFallback();
      if (date) artifact.changedAt = date;
    }
  }
}

// Keep every 'new' artifact, but drop 'updated' artifacts the user has not installed:
// an uninstalled item has no stale local copy, so its update is a no-op for the user.
// An item counts as installed if any installed plugin from the same source+plugin lists
// it in the matching selectedArtifacts bucket. Records without selectedArtifacts (legacy
// / native full installs) are treated as "installed everything from that plugin".
function filterUpdatesByInstalled(
  updates: SourceUpdate[],
  sourceUrl: string,
  installed: InstalledPlugin[],
): SourceUpdate[] {
  const bucketFor = (
    type: NewArtifact['type'],
  ): 'skills' | 'mcpServers' | 'agentNames' | 'jsPluginNames' | 'hookEvents' => {
    switch (type) {
      case 'skill': return 'skills';
      case 'mcpServer': return 'mcpServers';
      case 'agent': return 'agentNames';
      case 'jsPlugin': return 'jsPluginNames';
      case 'hook': return 'hookEvents';
    }
  };

  const result: SourceUpdate[] = [];
  for (const update of updates) {
    const records = installed.filter((i) => i.sourceUrl === sourceUrl && i.pluginId === update.pluginId);

    const isInstalled = (artifact: NewArtifact): boolean =>
      records.some((r) => {
        // No selectedArtifacts → full native install → everything counts as installed.
        if (!r.selectedArtifacts) return true;
        return r.selectedArtifacts[bucketFor(artifact.type)].includes(artifact.name);
      });

    const kept = update.newArtifacts.filter((a) => a.changeType === 'new' || isInstalled(a));
    if (kept.length > 0) result.push({ ...update, newArtifacts: kept });
  }
  return result;
}
