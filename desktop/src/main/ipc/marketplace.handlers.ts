import {
  deriveCloneDirName,
  FormatDetector,
  getAvailableAgents,
  getAgentsWithCapability,
  assertSafeCloneTarget,
  GitOperations,
  MarketplaceInstaller,
  MarketplaceIntegrityError,
  MarketplaceIntegrityInstaller,
  MarketplaceTransaction,
  MarketplaceRegistry,
  validateSourceUrl,
  type DetectedPlugin,
  type InstallSelection,
  type MarketplaceInstallMode,
  type MarketplaceInstallPreview,
  type MarketplaceSource,
  type MarketplaceTransactionalResult,
  type NativeMarketplaceConfig,
} from 'aumx/core';
import { app } from 'electron';
import { existsSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import { IPC } from '../../shared/ipc-channels.js';
import type {
  MarketplaceBrowseRequest,
  MarketplaceBrowseResponse,
  MarketplaceInstallRequest,
  MarketplaceInstallResponse,
  MarketplacePreviewRequest,
  MarketplacePreviewResponse,
  MarketplaceSourceAddRequest,
  MarketplaceSourceAddResponse,
  MarketplaceSourceRemoveRequest,
  MarketplaceSourceUpdateRequest,
  MarketplaceUninstallRequest,
  MarketplaceUninstallResponse,
} from '../../shared/ipc-types.js';
import { log } from '../services/Logger.js';
import { formatError } from '../utils/formatError.js';
import { secureHandle } from './ipc-security.js';

const CLONES_DIR = path.join(os.homedir(), '.aumx', 'marketplaces');

// Singleton — one registry per app lifetime, backed by Electron's userData dir
// (cross-platform: macOS ~/Library/Application Support/Amux, Windows %APPDATA%/Amux, Linux ~/.config/Amux)
let registryInstance: MarketplaceRegistry | null = null;
let recoveryFailure: Error | null = null;
let recoverySucceeded = false;

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
  const hasAnySelection = Array.isArray(request.selectedSkills)
    || Array.isArray(request.selectedMcpServers)
    || Array.isArray(request.selectedAgents);
  const mode = request.mode ?? (hasAnySelection ? 'selected' : 'full');
  return {
    mode,
    ...(mode === 'selected'
      ? { selection: { skills: request.selectedSkills, mcpServers: request.selectedMcpServers, agents: request.selectedAgents } }
      : {}),
  };
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

      const source: MarketplaceSource = {
        url: request.url,
        name,
        clonePath,
        detectedFormat,
        headSha,
        lastUpdated: new Date().toISOString(),
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
      getRegistry().updateSource(request.url, {
        lastUpdated: new Date().toISOString(),
        detectedFormat,
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
      return { success: false, error: formatError(error) };
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
      const integrityError = error as {
        affectedPaths?: string[];
        artifactPath?: string;
        code?: MarketplaceInstallResponse['errorCode'];
      };
      if (integrityError.code === 'ROLLBACK_FAILED' && error instanceof Error) recoveryFailure = error;
      return {
        success: false,
        error: formatError(error),
        ...(integrityError.code ? { errorCode: integrityError.code } : {}),
        ...(integrityError.affectedPaths?.length
          ? { affectedPaths: integrityError.affectedPaths }
          : integrityError.artifactPath ? { affectedPaths: [integrityError.artifactPath] } : {}),
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
      const integrityError = error as {
        affectedPaths?: string[];
        artifactPath?: string;
        code?: MarketplaceInstallResponse['errorCode'];
      };
      if (integrityError.code === 'ROLLBACK_FAILED' && error instanceof Error) recoveryFailure = error;
      return {
        success: false,
        error: formatError(error),
        ...(integrityError.code ? { errorCode: integrityError.code } : {}),
        ...(integrityError.affectedPaths?.length
          ? { affectedPaths: integrityError.affectedPaths }
          : integrityError.artifactPath ? { affectedPaths: [integrityError.artifactPath] } : {}),
      };
    }
  });

  secureHandle(IPC.MARKETPLACE_INSTALLED_LIST, () => {
    return getRegistry().getData().installed;
  });
}
