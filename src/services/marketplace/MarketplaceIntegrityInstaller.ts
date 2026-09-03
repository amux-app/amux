import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentName } from '../../utils/agentLaunch.js';
import { AgentTranslator } from './AgentTranslator.js';
import { HookTranslator, isMarketplaceHookOwnedBy } from './HookTranslator.js';
import {
  MarketplaceIntegrityError,
  MarketplaceTransaction,
  digestPath,
  type MarketplaceMutation,
} from './MarketplaceTransaction.js';
import type { PreparedMarketplaceRegistryMutation } from './MarketplaceRegistry.js';
import { McpTranslator } from './McpTranslator.js';
import { NativeInstaller, type NativeMarketplaceConfig } from './NativeInstaller.js';
import { SkillTranslator } from './SkillTranslator.js';
import type {
  DetectedPlugin,
  InstallResult,
  MarketplaceOwnedArtifact,
  MarketplaceOwnershipManifest,
} from './types.js';
import type { InstallSelection, MarketplaceInstallMode } from './MarketplaceInstaller.js';

interface Candidate {
  actualPath: string;
  agent: AgentName;
  desiredPath: string;
  type: 'config-entry' | 'directory' | 'file';
  selectors?: string[];
  scope?: 'plugin' | 'source';
}

export interface MarketplaceTransactionalOptions {
  homeDir?: string;
  journalDir: string;
  ownershipManifest?: MarketplaceOwnershipManifest;
  /** A legacy record can be adopted only when every candidate is byte-identical. */
  legacyRecord?: boolean;
  prepareRegistryMutation?: (result: MarketplaceTransactionalResult) => PreparedMarketplaceRegistryMutation;
  /** Ownership manifests of installed sibling plugins from the same source. */
  sharedOwnershipManifests?: MarketplaceOwnershipManifest[];
  transactionId?: string;
}

export interface MarketplaceTransactionalResult extends InstallResult {
  ownershipManifest: MarketplaceOwnershipManifest;
}

export interface MarketplaceTransactionalUninstallResult {
  preservedArtifacts: string[];
}

function isLocalScript(server: { type?: string; command?: string; args?: string[] }): boolean {
  if (server.type === 'http' || server.type === 'sse') return false;
  if (!server.command || server.command === 'npx' || server.command === 'uvx') return false;
  const firstArg = server.args?.[0] ?? '';
  return firstArg.endsWith('.js') || firstArg.endsWith('.ts') || firstArg.endsWith('.py') || firstArg.startsWith('/');
}

function relativeToHome(homeDir: string, targetPath: string): string {
  const relative = path.relative(homeDir, targetPath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Marketplace destination is outside the selected home: ${targetPath}`);
  }
  return relative;
}

function pathInHome(homeDir: string, relativePath: string): string {
  return path.join(homeDir, relativePath);
}

function configPaths(homeDir: string, agent: AgentName, native: NativeInstaller, nativeConfig?: NativeMarketplaceConfig): string[] {
  const common = (() => {
    switch (agent) {
      case 'claude': return [path.join(homeDir, '.claude', 'settings.json')];
      case 'codex': return [path.join(homeDir, '.codex', 'config.toml'), path.join(homeDir, '.codex', 'hooks.json')];
      case 'opencode': return [path.join(homeDir, '.config', 'opencode', 'opencode.json')];
      case 'pi': return [];
    }
  })();
  return [...new Set([...common, ...(nativeConfig ? native.getNativeConfigurationPaths(nativeConfig, agent, homeDir) : [])])];
}

function mcpConfigPath(homeDir: string, agent: AgentName): string | null {
  switch (agent) {
    case 'claude': return path.join(homeDir, '.claude', 'settings.json');
    case 'codex': return path.join(homeDir, '.codex', 'config.toml');
    case 'opencode': return path.join(homeDir, '.config', 'opencode', 'opencode.json');
    case 'pi': return null;
  }
}

function copyExistingFile(actualPath: string, stagedPath: string): void {
  if (!existsSync(actualPath)) return;
  mkdirSync(path.dirname(stagedPath), { recursive: true });
  copyFileSync(actualPath, stagedPath);
}

function findOwnedArtifact(
  manifest: MarketplaceOwnershipManifest | undefined,
  candidate: Candidate,
): MarketplaceOwnedArtifact | undefined {
  return manifest?.artifacts.find((artifact) => (
    artifact.path === candidate.actualPath
    && artifact.agent === candidate.agent
    && artifact.type === candidate.type
  ));
}

function findSharedArtifact(
  manifests: MarketplaceOwnershipManifest[] | undefined,
  candidate: Candidate,
): MarketplaceOwnedArtifact | undefined {
  return manifests?.flatMap((manifest) => manifest.artifacts).find((artifact) => (
    artifact.path === candidate.actualPath
    && artifact.agent === candidate.agent
    && artifact.type === candidate.type
    && artifact.scope === 'source'
  ));
}

function findSharedArtifacts(
  manifests: MarketplaceOwnershipManifest[] | undefined,
  candidate: Candidate,
): MarketplaceOwnedArtifact[] {
  return manifests?.flatMap((manifest) => manifest.artifacts).filter((artifact) => (
    artifact.path === candidate.actualPath
    && artifact.agent === candidate.agent
    && artifact.type === candidate.type
    && artifact.scope === 'source'
  )) ?? [];
}

function findOwnedConfig(
  manifest: MarketplaceOwnershipManifest | undefined,
  candidate: Candidate,
  selector: string,
): MarketplaceOwnedArtifact | undefined {
  return manifest?.artifacts.find((artifact) => (
    artifact.type === 'config-entry'
    && artifact.path === candidate.actualPath
    && artifact.agent === candidate.agent
    && artifact.selector === selector
  ));
}

function findSharedConfig(
  manifests: MarketplaceOwnershipManifest[] | undefined,
  candidate: Candidate,
  selector: string,
): MarketplaceOwnedArtifact | undefined {
  return manifests?.flatMap((manifest) => manifest.artifacts).find((artifact) => (
    artifact.type === 'config-entry'
    && artifact.path === candidate.actualPath
    && artifact.agent === candidate.agent
    && artifact.selector === selector
    && artifact.scope === 'source'
  ));
}

function findSharedConfigs(
  manifests: MarketplaceOwnershipManifest[] | undefined,
  candidate: Candidate,
  selector: string,
): MarketplaceOwnedArtifact[] {
  return manifests?.flatMap((manifest) => manifest.artifacts).filter((artifact) => (
    artifact.type === 'config-entry'
    && artifact.path === candidate.actualPath
    && artifact.agent === candidate.agent
    && artifact.selector === selector
    && artifact.scope === 'source'
  )) ?? [];
}

function isSourceScopedSelector(selector: string): boolean {
  return selector.startsWith('claude-marketplace:')
    || selector.startsWith('claude-known-marketplace:')
    || selector.startsWith('codex-marketplace:');
}

function canonicalConfigEntryDigest(filePath: string, agent: AgentName, selector: string): string | null {
  if (!existsSync(filePath)) return null;
  const content = readFileSync(filePath, 'utf-8');
  const [kind, name] = selector.split(':', 2);
  if (!kind || !name) return null;
  if (agent === 'codex' && (kind === 'mcp' || kind === 'codex-marketplace' || kind === 'codex-plugin')) {
    const header = kind === 'mcp'
      ? `[mcp_servers.${name}]`
      : kind === 'codex-marketplace'
        ? `[marketplaces.${name}]`
        : `[plugins."${name}"]`;
    return canonicalTomlSectionDigest(content, header);
  }
  try {
    const json = JSON.parse(content) as Record<string, unknown>;
    const value = configSelectorValue(json, agent, kind, name);
    return value === undefined ? null : digestPathFromText(JSON.stringify(stableValue(value)));
  } catch {
    return null;
  }
}

function canonicalTomlSectionDigest(content: string, header: string): string | null {
  const lines = content.split('\n');
  const start = lines.findIndex((line) => line.trim() === header);
  if (start < 0) return null;
  const end = lines.findIndex((line, index) => index > start && line.trim().startsWith('['));
  return digestPathFromText(lines.slice(start, end < 0 ? undefined : end).join('\n'));
}

function configSelectorValue(
  json: Record<string, unknown>,
  agent: AgentName,
  kind: string,
  name: string,
): unknown {
  if (kind === 'mcp') {
    const collection = agent === 'claude' ? json.mcpServers : json.mcp;
    return collection && typeof collection === 'object' && Object.hasOwn(collection, name)
      ? (collection as Record<string, unknown>)[name]
      : undefined;
  }
  if (kind === 'hook') {
    const hooks = agent === 'claude' ? json.hooks : json;
    if (!hooks || typeof hooks !== 'object') return undefined;
    const matching = Object.fromEntries(Object.entries(hooks as Record<string, unknown>)
      .flatMap(([event, entries]) => Array.isArray(entries)
        ? [[event, entries.filter((entry) => isMarketplaceHookOwnedBy(entry, name, event))] as const]
        : [])
      .filter(([, entries]) => entries.length > 0));
    return Object.keys(matching).length > 0 ? matching : undefined;
  }
  if (agent !== 'claude') return undefined;
  if (kind === 'claude-marketplace') {
    return json.extraKnownMarketplaces && typeof json.extraKnownMarketplaces === 'object'
      ? (json.extraKnownMarketplaces as Record<string, unknown>)[name]
      : undefined;
  }
  if (kind === 'claude-plugin') {
    return json.enabledPlugins && typeof json.enabledPlugins === 'object'
      ? (json.enabledPlugins as Record<string, unknown>)[name]
      : undefined;
  }
  if (kind === 'claude-known-marketplace') return json[name];
  if (kind === 'claude-installed-plugin') {
    return json.plugins && typeof json.plugins === 'object'
      ? (json.plugins as Record<string, unknown>)[name]
      : undefined;
  }
  return undefined;
}

function digestPathFromText(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, stableValue(child)]),
  );
}

function removeConfigSelectors(filePath: string, agent: AgentName, selectors: string[]): void {
  if (!existsSync(filePath)) return;
  if (agent === 'codex') {
    let content = readFileSync(filePath, 'utf-8');
    for (const selector of selectors) {
      const [kind, name] = selector.split(':', 2);
      if (!name) continue;
      const header = kind === 'mcp'
        ? `[mcp_servers.${name}]`
        : kind === 'codex-marketplace'
          ? `[marketplaces.${name}]`
          : kind === 'codex-plugin'
            ? `[plugins."${name}"]`
            : undefined;
      if (header) content = removeTomlSection(content, header);
    }
    writeFileSync(filePath, content, 'utf-8');
    return;
  }
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(readFileSync(filePath, 'utf-8')) as Record<string, unknown>;
  } catch {
    return;
  }
  for (const selector of selectors) {
    const [kind, name] = selector.split(':', 2);
    if (!name) continue;
    if (kind === 'mcp') {
      const collection = agent === 'claude' ? json.mcpServers : json.mcp;
      if (collection && typeof collection === 'object') delete (collection as Record<string, unknown>)[name];
      continue;
    }
    if (kind === 'hook') {
      const hooks = agent === 'claude' ? json.hooks : json;
      if (!hooks || typeof hooks !== 'object') continue;
      for (const [event, entries] of Object.entries(hooks as Record<string, unknown>)) {
        if (!Array.isArray(entries)) continue;
        const retained = entries.filter((entry) => !isMarketplaceHookOwnedBy(entry, name, event));
        if (retained.length === 0) delete (hooks as Record<string, unknown>)[event];
        else (hooks as Record<string, unknown>)[event] = retained;
      }
      if (agent === 'claude' && Object.keys(hooks as Record<string, unknown>).length === 0) delete json.hooks;
      continue;
    }
    if (agent !== 'claude') continue;
    if (kind === 'claude-marketplace' && json.extraKnownMarketplaces && typeof json.extraKnownMarketplaces === 'object') {
      delete (json.extraKnownMarketplaces as Record<string, unknown>)[name];
    } else if (kind === 'claude-plugin' && json.enabledPlugins && typeof json.enabledPlugins === 'object') {
      delete (json.enabledPlugins as Record<string, unknown>)[name];
    } else if (kind === 'claude-known-marketplace') {
      delete json[name];
    } else if (kind === 'claude-installed-plugin' && json.plugins && typeof json.plugins === 'object') {
      delete (json.plugins as Record<string, unknown>)[name];
    }
  }
  writeFileSync(filePath, JSON.stringify(json, null, 2), 'utf-8');
}

function removeTomlSection(content: string, header: string): string {
  const lines = content.split('\n');
  const result: string[] = [];
  let skipping = false;
  for (const line of lines) {
    if (line.trim() === header) {
      skipping = true;
      continue;
    }
    if (skipping && line.trim().startsWith('[')) skipping = false;
    if (!skipping) result.push(line);
  }
  return result.join('\n');
}

function applySelection(plugin: DetectedPlugin, agent: AgentName, selection?: InstallSelection): DetectedPlugin {
  return {
    ...plugin,
    agents: Array.isArray(selection?.agents) ? plugin.agents.filter((entry) => selection.agents!.includes(entry.name)) : plugin.agents,
    mcpServers: agent === 'codex'
      ? []
      : Array.isArray(selection?.mcpServers)
        ? plugin.mcpServers.filter((entry) => selection.mcpServers!.includes(entry.name))
        : plugin.mcpServers,
    skills: Array.isArray(selection?.skills) ? plugin.skills.filter((entry) => selection.skills!.includes(entry.name)) : plugin.skills,
  };
}

/**
 * Builds desired agent state in an isolated temporary home, then moves it into
 * place using the durable transaction executor. The legacy translators are
 * intentionally used only against that temporary home; they never mutate the
 * user's configuration on this path.
 */
export class MarketplaceIntegrityInstaller {
  install(
    plugin: DetectedPlugin,
    agents: AgentName[],
    nativeConfig: NativeMarketplaceConfig | undefined,
    selection: InstallSelection | undefined,
    mode: MarketplaceInstallMode,
    options: MarketplaceTransactionalOptions,
  ): MarketplaceTransactionalResult {
    const homeDir = options.homeDir ?? os.homedir();
    const planningRoot = mkdtempSync(path.join(os.tmpdir(), 'muxbase-marketplace-plan-'));
    const planningHome = path.join(planningRoot, 'home');
    const native = new NativeInstaller();
    const candidates = new Map<string, Candidate>();
    const selectorsByConfigPath = new Map<string, Set<string>>();
    const result: InstallResult = { agents: {}, pluginId: plugin.id };

    try {
      for (const agent of agents) {
        const effectiveNativeConfig = nativeConfig
          && mode === 'full'
          && native.supportsNative(agent, nativeConfig.sourceFormat)
          ? nativeConfig
          : undefined;
        for (const configPath of configPaths(homeDir, agent, native, effectiveNativeConfig)) {
          copyExistingFile(configPath, pathInHome(planningHome, relativeToHome(homeDir, configPath)));
        }
      }

      const stagedSkills = new SkillTranslator(planningHome);
      const stagedAgents = new AgentTranslator(planningHome);
      const stagedHooks = new HookTranslator(planningHome);
      const stagedMcp = new McpTranslator(planningHome);

      for (const agent of agents) {
        const filtered = applySelection(plugin, agent, mode === 'full' ? undefined : selection);
        const skipped: string[] = [];
        let installPath = '';
        const effectiveNativeConfig = nativeConfig
          && mode === 'full'
          && native.supportsNative(agent, nativeConfig.sourceFormat)
          ? nativeConfig
          : undefined;
        const useNative = Boolean(effectiveNativeConfig);
        if (effectiveNativeConfig) {
          installPath = native.install(effectiveNativeConfig, agent, planningHome);
          this.addNativeSelectors(selectorsByConfigPath, homeDir, agent, effectiveNativeConfig);
          for (const operation of native.getNativeCopyOperations(effectiveNativeConfig, agent, planningHome)) {
            this.addCandidate(
              candidates,
              homeDir,
              planningHome,
              agent,
              operation.destinationPath,
              'directory',
              operation.name === 'marketplace clone' ? 'source' : 'plugin',
            );
          }
        }

        for (const skill of filtered.skills) {
          const stagedPath = stagedSkills.installForAgent(skill, agent, nativeConfig?.clonePath);
          this.addCandidate(candidates, homeDir, planningHome, agent, stagedPath, 'directory');
          if (!installPath) installPath = stagedPath;
        }
        for (const entry of filtered.agents) {
          const stagedPath = stagedAgents.installForAgent(entry, agent, plugin.id);
          if (stagedPath) {
            this.addCandidate(candidates, homeDir, planningHome, agent, path.join(stagedPath, `${plugin.id}__${entry.name}.md`), 'file');
            if (!installPath) installPath = stagedPath;
          }
        }
        for (const hookResult of stagedHooks.translateAllForAgent(filtered.hooks, agent, plugin.id)) {
          if (hookResult.status === 'partial') skipped.push(...hookResult.skipped);
          if (hookResult.path) {
            if (agent === 'opencode') {
              this.addCandidate(candidates, homeDir, planningHome, agent, hookResult.path, 'file');
            } else {
              const actualConfigPath = pathInHome(homeDir, relativeToHome(planningHome, hookResult.path));
              const selectors = selectorsByConfigPath.get(actualConfigPath) ?? new Set<string>();
              selectors.add(`hook:${plugin.id}`);
              selectorsByConfigPath.set(actualConfigPath, selectors);
            }
            if (!installPath) installPath = hookResult.path;
          }
        }
        for (const server of filtered.mcpServers) {
          if (!useNative || isLocalScript(server)) {
            const stagedPath = stagedMcp.installForAgent(server, agent);
            const actualConfigPath = mcpConfigPath(homeDir, agent);
            if (actualConfigPath) {
              const selectors = selectorsByConfigPath.get(actualConfigPath) ?? new Set<string>();
              selectors.add(`mcp:${server.name}`);
              selectorsByConfigPath.set(actualConfigPath, selectors);
            }
            if (!installPath) installPath = stagedPath;
          }
        }
        if (agent === 'opencode') {
          for (const jsPlugin of filtered.jsPlugins) {
            if (jsPlugin.path.endsWith('.ts')) {
              skipped.push(`${jsPlugin.name}: TypeScript plugins must be pre-compiled to .js before install`);
              continue;
            }
            const stagedPath = path.join(planningHome, '.config', 'opencode', 'plugins', `marketplace-${plugin.id}-${jsPlugin.name}.js`);
            mkdirSync(path.dirname(stagedPath), { recursive: true });
            copyFileSync(jsPlugin.path, stagedPath);
            this.addCandidate(candidates, homeDir, planningHome, agent, stagedPath, 'file');
            if (!installPath) installPath = stagedPath;
          }
        } else if (filtered.jsPlugins.length > 0) {
          skipped.push('JS runtime plugins cannot be translated');
        }

        for (const actualConfigPath of configPaths(homeDir, agent, native, effectiveNativeConfig)) {
          const stagedConfigPath = pathInHome(planningHome, relativeToHome(homeDir, actualConfigPath));
          const selectors = [...(selectorsByConfigPath.get(actualConfigPath) ?? [])];
          if (selectors.length > 0 && existsSync(stagedConfigPath)) {
            candidates.set(actualConfigPath, {
              actualPath: actualConfigPath,
              agent,
              desiredPath: stagedConfigPath,
              selectors,
              type: 'config-entry',
            });
          }
        }
        result.agents[agent] = {
          skipped,
          status: skipped.length > 0 ? 'partial' : 'full',
        };
      }

      const mutations: MarketplaceMutation[] = [];
      const artifacts: MarketplaceOwnedArtifact[] = [];
      for (const candidate of candidates.values()) {
        const desiredDigest = digestPath(candidate.desiredPath);
        const currentDigest = digestPath(candidate.actualPath);
        if (!desiredDigest) continue;
        const owned = findOwnedArtifact(options.ownershipManifest, candidate);
        const shared = candidate.scope === 'source'
          ? findSharedArtifact(options.sharedOwnershipManifests, candidate)
          : undefined;
        const sharedArtifacts = candidate.scope === 'source'
          ? findSharedArtifacts(options.sharedOwnershipManifests, candidate)
          : [];
        if (
          candidate.type !== 'config-entry'
          && candidate.scope === 'source'
          && sharedArtifacts.some((artifact) => artifact.installedDigest !== desiredDigest)
        ) {
          throw new MarketplaceIntegrityError(
            'ARTIFACT_MODIFIED',
            `Shared marketplace artifact requires a coordinated sibling update: ${candidate.actualPath}`,
            candidate.actualPath,
          );
        }
        if (candidate.type !== 'config-entry' && currentDigest !== null && !owned) {
          const matchesSharedArtifact = shared
            && shared.installedDigest === currentDigest
            && currentDigest === desiredDigest;
          if (!(options.legacyRecord && currentDigest === desiredDigest) && !matchesSharedArtifact) {
            throw new MarketplaceIntegrityError('DESTINATION_CONFLICT', `Destination is not owned by this plugin: ${candidate.actualPath}`, candidate.actualPath);
          }
        }
        if (candidate.type !== 'config-entry' && currentDigest !== null && currentDigest !== desiredDigest) {
          if (!owned || owned.installedDigest !== currentDigest) {
            throw new MarketplaceIntegrityError('ARTIFACT_MODIFIED', `Owned destination was modified: ${candidate.actualPath}`, candidate.actualPath);
          }
        }
        if (candidate.type === 'config-entry') {
          const selectors = candidate.selectors ?? [];
          for (const selector of selectors) {
            const currentEntryDigest = canonicalConfigEntryDigest(candidate.actualPath, candidate.agent, selector);
            const desiredEntryDigest = canonicalConfigEntryDigest(candidate.desiredPath, candidate.agent, selector);
            const ownedConfig = findOwnedConfig(options.ownershipManifest, candidate, selector)
              ?? (isSourceScopedSelector(selector)
                ? findSharedConfig(options.sharedOwnershipManifests, candidate, selector)
                : undefined);
            const sharedConfigs = isSourceScopedSelector(selector)
              ? findSharedConfigs(options.sharedOwnershipManifests, candidate, selector)
              : [];
            if (!ownedConfig && options.legacyRecord && currentEntryDigest !== desiredEntryDigest) {
              throw new MarketplaceIntegrityError('ARTIFACT_MODIFIED', `Legacy configuration cannot be adopted safely: ${candidate.actualPath} (${selector})`, candidate.actualPath);
            }
            if (currentEntryDigest !== null && !ownedConfig) {
              if (!(options.legacyRecord && currentEntryDigest === desiredEntryDigest)) {
                throw new MarketplaceIntegrityError('DESTINATION_CONFLICT', `Configuration entry is not owned by this plugin: ${candidate.actualPath} (${selector})`, candidate.actualPath);
              }
            }
            if (ownedConfig && ownedConfig.installedDigest !== currentEntryDigest) {
              throw new MarketplaceIntegrityError('ARTIFACT_MODIFIED', `Owned configuration entry was modified: ${candidate.actualPath} (${selector})`, candidate.actualPath);
            }
            if (
              isSourceScopedSelector(selector)
              && currentEntryDigest !== desiredEntryDigest
              && sharedConfigs.some((artifact) => artifact.installedDigest !== desiredEntryDigest)
            ) {
              throw new MarketplaceIntegrityError(
                'ARTIFACT_MODIFIED',
                `Shared marketplace configuration requires a coordinated sibling update: ${candidate.actualPath} (${selector})`,
                candidate.actualPath,
              );
            }
          }
        }
        if (currentDigest !== desiredDigest) {
          mutations.push({
            expectedDigest: currentDigest,
            kind: candidate.type === 'directory' ? 'directory' : 'file',
            path: candidate.actualPath,
            sourcePath: candidate.desiredPath,
          });
        }
        if (candidate.type === 'config-entry') {
          const selectors = candidate.selectors ?? [];
          for (const selector of selectors) {
            const selectorDigest = canonicalConfigEntryDigest(candidate.desiredPath, candidate.agent, selector) ?? desiredDigest;
            artifacts.push({
              agent: candidate.agent,
              installedDigest: selectorDigest,
              path: candidate.actualPath,
              selector,
              ...(isSourceScopedSelector(selector) ? { scope: 'source' as const } : {}),
              type: 'config-entry',
            });
          }
        } else {
          artifacts.push({
            agent: candidate.agent,
            installedDigest: desiredDigest,
            path: candidate.actualPath,
            ...(candidate.scope === 'source' ? { scope: 'source' as const } : {}),
            type: candidate.type,
          });
        }
      }

      const transactionalResult: MarketplaceTransactionalResult = {
        ...result,
        ownershipManifest: {
          artifacts,
          transactionId: options.transactionId ?? '',
          version: 1,
        },
      };
      const transaction = new MarketplaceTransaction({ journalDir: options.journalDir, transactionId: options.transactionId });
      const committedResult: MarketplaceTransactionalResult = {
        ...transactionalResult,
        ownershipManifest: { ...transactionalResult.ownershipManifest, transactionId: transaction.id },
      };
      const registryMutation = options.prepareRegistryMutation?.(committedResult);
      if (registryMutation) mutations.push(registryMutation.mutation);
      transaction.execute(mutations);
      registryMutation?.applyInMemory();
      return committedResult;
    } finally {
      rmSync(planningRoot, { force: true, recursive: true });
    }
  }

  uninstall(
    plugin: DetectedPlugin,
    agents: AgentName[],
    nativeConfig: NativeMarketplaceConfig | undefined,
    selection: InstallSelection | undefined,
    options: Omit<MarketplaceTransactionalOptions, 'prepareRegistryMutation'> & {
      prepareRegistryMutation?: (result: MarketplaceTransactionalUninstallResult) => PreparedMarketplaceRegistryMutation;
    },
  ): MarketplaceTransactionalUninstallResult {
    const manifest = options.ownershipManifest;
    if (!manifest) {
      throw new MarketplaceIntegrityError('ARTIFACT_MODIFIED', 'Legacy marketplace installation has no ownership manifest and will be preserved');
    }
    const homeDir = options.homeDir ?? os.homedir();
    const planningRoot = mkdtempSync(path.join(os.tmpdir(), 'muxbase-marketplace-uninstall-'));
    const planningHome = path.join(planningRoot, 'home');
    const native = new NativeInstaller();
    try {
      for (const agent of agents) {
        for (const configPath of configPaths(homeDir, agent, native, nativeConfig)) {
          copyExistingFile(configPath, pathInHome(planningHome, relativeToHome(homeDir, configPath)));
        }
      }
      const stagedSkills = new SkillTranslator(planningHome);
      const stagedAgents = new AgentTranslator(planningHome);
      const stagedHooks = new HookTranslator(planningHome);
      const stagedMcp = new McpTranslator(planningHome);
      for (const agent of agents) {
        const filtered = applySelection(plugin, agent, selection);
        if (nativeConfig && native.supportsNative(agent, nativeConfig.sourceFormat)) {
          native.uninstall(nativeConfig, agent, planningHome);
        }
        for (const skill of filtered.skills) stagedSkills.uninstallForAgent(skill.name, agent);
        for (const entry of filtered.agents) stagedAgents.uninstallForAgent(entry.name, agent, plugin.id);
        if (agent !== 'codex') {
          for (const server of filtered.mcpServers) stagedMcp.uninstallForAgent(server.name, agent);
        }
        stagedHooks.uninstallForAgent(plugin.id, agent);
        if (agent === 'opencode') {
          const pluginsDir = path.join(planningHome, '.config', 'opencode', 'plugins');
          for (const entry of filtered.jsPlugins) {
            rmSync(path.join(pluginsDir, `marketplace-${plugin.id}-${entry.name}.js`), { force: true });
          }
        }
      }

      const preservedArtifacts = new Set<string>();
      const mutations: MarketplaceMutation[] = [];
      const configArtifacts = new Map<string, Array<Extract<MarketplaceOwnedArtifact, { type: 'config-entry' }>>>();
      for (const artifact of manifest.artifacts) {
        if (artifact.type === 'config-entry') {
          const grouped = configArtifacts.get(artifact.path) ?? [];
          grouped.push(artifact);
          configArtifacts.set(artifact.path, grouped);
          continue;
        }
        if (artifact.scope === 'source' && !nativeConfig?.isLastPluginFromMarketplace) continue;
        const currentDigest = digestPath(artifact.path);
        if (currentDigest !== artifact.installedDigest) {
          preservedArtifacts.add(artifact.path);
          continue;
        }
        mutations.push({
          expectedDigest: currentDigest,
          kind: artifact.type,
          path: artifact.path,
        });
      }

      for (const [configPath, artifacts] of configArtifacts) {
        const modified = artifacts.filter((artifact) => (
          canonicalConfigEntryDigest(configPath, artifact.agent, artifact.selector) !== artifact.installedDigest
        ));
        if (modified.length > 0) preservedArtifacts.add(configPath);

        const removable = artifacts.filter((artifact) => (
          !modified.includes(artifact)
          && (artifact.scope !== 'source' || nativeConfig?.isLastPluginFromMarketplace)
        ));
        if (removable.length === 0) continue;
        const agent = removable[0].agent;
        const desiredPath = pathInHome(planningHome, relativeToHome(homeDir, configPath));
        copyExistingFile(configPath, desiredPath);
        removeConfigSelectors(desiredPath, agent, removable.map((artifact) => artifact.selector));

        const currentFileDigest = digestPath(configPath);
        const desiredFileDigest = digestPath(desiredPath);
        if (currentFileDigest === desiredFileDigest) continue;
        mutations.push({
          expectedDigest: currentFileDigest,
          kind: 'file',
          path: configPath,
          ...(desiredFileDigest ? { sourcePath: desiredPath } : {}),
        });
      }
      const result = { preservedArtifacts: [...preservedArtifacts] };
      const registryMutation = options.prepareRegistryMutation?.(result);
      if (registryMutation) mutations.push(registryMutation.mutation);
      new MarketplaceTransaction({ journalDir: options.journalDir, transactionId: options.transactionId })
        .execute(mutations);
      registryMutation?.applyInMemory();
      return result;
    } finally {
      rmSync(planningRoot, { force: true, recursive: true });
    }
  }

  private addCandidate(
    candidates: Map<string, Candidate>,
    actualHome: string,
    planningHome: string,
    agent: AgentName,
    stagedPath: string,
    type: Candidate['type'],
    scope: Candidate['scope'] = 'plugin',
  ): void {
    const relative = relativeToHome(planningHome, stagedPath);
    const actualPath = pathInHome(actualHome, relative);
    candidates.set(actualPath, { actualPath, agent, desiredPath: stagedPath, scope, type });
  }

  private addNativeSelectors(
    selectorsByConfigPath: Map<string, Set<string>>,
    homeDir: string,
    agent: AgentName,
    config: NativeMarketplaceConfig,
  ): void {
    const add = (configPath: string, ...selectors: string[]) => {
      const existing = selectorsByConfigPath.get(configPath) ?? new Set<string>();
      selectors.forEach((selector) => existing.add(selector));
      selectorsByConfigPath.set(configPath, existing);
    };
    const pluginKey = `${config.pluginId}@${config.marketplaceName}`;
    if (agent === 'claude') {
      add(
        path.join(homeDir, '.claude', 'settings.json'),
        `claude-marketplace:${config.marketplaceName}`,
        `claude-plugin:${pluginKey}`,
      );
      add(
        path.join(homeDir, '.claude', 'plugins', 'known_marketplaces.json'),
        `claude-known-marketplace:${config.marketplaceName}`,
      );
      add(
        path.join(homeDir, '.claude', 'plugins', 'installed_plugins.json'),
        `claude-installed-plugin:${pluginKey}`,
      );
      return;
    }
    if (agent === 'codex') {
      add(
        path.join(homeDir, '.codex', 'config.toml'),
        `codex-marketplace:${config.marketplaceName}`,
        `codex-plugin:${pluginKey}`,
      );
    }
  }
}
