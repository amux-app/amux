import { createHash } from 'crypto';
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import type { AgentName } from '../../utils/agentLaunch.js';
import { AgentTranslator } from './AgentTranslator.js';
import { HookTranslator } from './HookTranslator.js';
import { McpTranslator } from './McpTranslator.js';
import { NativeInstaller, type NativeMarketplaceConfig } from './NativeInstaller.js';
import {
  collectMarketplaceSourceTreeEntries,
  type MarketplaceSourceTreeEntry,
} from './MarketplaceSourceTree.js';
import { SkillTranslator } from './SkillTranslator.js';
import type {
  AgentInstallResult,
  DetectedPlugin,
  InstallResult,
  JsPluginEntry,
  MarketplaceInstallPreview,
  MarketplacePreviewAgent,
  MarketplacePreviewArtifact,
  McpServerEntry,
} from './types.js';

export interface InstallSelection {
  skills?: string[];
  mcpServers?: string[];
  agents?: string[];
  hooks?: string[];
  jsPlugins?: string[];
}

export type MarketplaceInstallMode = 'full' | 'selected';

export interface MarketplaceSourceSnapshot {
  sourceUrl: string;
  headSha: string;
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

function formatArtifactEntries(entries: MarketplaceSourceTreeEntry[]): string[] {
  return entries.map((entry) => [
    entry.entryType,
    entry.relativePath,
    entry.contentHash ?? '',
  ].join(':'));
}

function isPathWithin(rootPath: string, candidatePath: string): boolean {
  const relativePath = path.relative(rootPath, candidatePath);
  return relativePath === '' || (!relativePath.startsWith(`..${path.sep}`) && relativePath !== '..' && !path.isAbsolute(relativePath));
}

function localMcpSourcePaths(server: McpServerEntry, clonePath?: string): string[] {
  if (!clonePath || server.type === 'http' || server.type === 'sse') return [];

  const rootPath = path.resolve(clonePath);
  const references = server.args.filter((value) => (
    path.isAbsolute(value) || /\.(?:cjs|js|mjs|py|ts)$/.test(value)
  ));

  return [...new Set(references.flatMap((reference) => {
    const sourcePath = path.resolve(rootPath, reference);
    if (!isPathWithin(rootPath, sourcePath)) {
      throw new Error(`Marketplace MCP executable is outside the source clone: ${reference}`);
    }
    // Option-like values such as --output=result.js also end in a script
    // extension without naming a real file — skip rather than crash.
    if (!existsSync(sourcePath)) {
      try {
        if (lstatSync(sourcePath).isSymbolicLink()) return [sourcePath];
      } catch { /* genuinely absent */ }
      return [];
    }
    return [sourcePath];
  }))];
}

function formatMcpEnvironmentLines(env: Record<string, string> | undefined): string[] {
  if (!env) return [];
  return Object.keys(env)
    .sort()
    .map((key) => `${key}=${JSON.stringify(env[key])}`);
}

function agentSkillsDir(agent: AgentName): string {
  const home = os.homedir();
  switch (agent) {
    case 'claude': return path.join(home, '.claude', 'skills');
    case 'codex': return path.join(home, '.codex', 'skills');
    case 'opencode': return path.join(home, '.config', 'opencode', 'skills');
    case 'pi': return path.join(home, '.pi', 'skills');
  }
}

function agentDir(agent: AgentName): string {
  const home = os.homedir();
  switch (agent) {
    case 'claude': return path.join(home, '.claude', 'agents');
    case 'codex': return path.join(home, '.codex', 'agents');
    case 'opencode': return path.join(home, '.config', 'opencode', 'agents');
    case 'pi': return path.join(home, '.pi', 'agents');
  }
}

function hookDestination(agent: AgentName): string {
  const home = os.homedir();
  switch (agent) {
    case 'claude': return path.join(home, '.claude', 'settings.json');
    case 'codex': return path.join(home, '.codex', 'hooks.json');
    case 'opencode': return path.join(home, '.config', 'opencode', 'plugins');
    case 'pi': return path.join(home, '.pi', 'hooks.json');
  }
}

function mcpDestination(agent: AgentName): string {
  const home = os.homedir();
  switch (agent) {
    case 'claude': return path.join(home, '.claude', 'settings.json');
    case 'codex': return path.join(home, '.codex', 'config.toml');
    case 'opencode': return path.join(home, '.config', 'opencode', 'opencode.json');
    case 'pi': return path.join(home, '.pi', 'mcp.json');
  }
}

function artifact(
  name: string,
  sourcePaths: string[],
  destinationPaths: string[],
  executable: boolean,
  containmentRoot?: string,
  detail?: string,
): MarketplacePreviewArtifact {
  const entries = sourcePaths.flatMap((sourcePath) => containmentRoot
    ? collectMarketplaceSourceTreeEntries(sourcePath, containmentRoot)
    : collectMarketplaceSourceTreeEntries(sourcePath));
  return {
    contentHashes: formatArtifactEntries(entries),
    destinationPaths,
    executable,
    name,
    sourcePaths,
    ...(detail ? { detail } : {}),
  };
}

function nativeArtifact(
  name: string,
  sourcePath: string,
  destinationPath: string,
  containmentRoot: string,
): MarketplacePreviewArtifact {
  const entries = collectMarketplaceSourceTreeEntries(sourcePath, containmentRoot);
  return {
    contentHashes: formatArtifactEntries(entries),
    destinationPaths: [destinationPath],
    executable: true,
    name,
    sourcePaths: [sourcePath],
    detail: 'Native installer recursively copies this tree before registration.',
  };
}

export class MarketplaceInstaller {
  private skillTranslator = new SkillTranslator();
  private agentTranslator = new AgentTranslator();
  private hookTranslator = new HookTranslator();
  private mcpTranslator = new McpTranslator();
  private nativeInstaller = new NativeInstaller();

  preview(
    plugin: DetectedPlugin,
    agents: AgentName[],
    nativeConfig?: NativeMarketplaceConfig,
    selection?: InstallSelection,
    source: MarketplaceSourceSnapshot = { headSha: 'unknown', sourceUrl: '' },
    mode: MarketplaceInstallMode = selection === undefined ? 'full' : 'selected',
  ): MarketplaceInstallPreview {
    const effectiveSelection = mode === 'full' ? undefined : selection ?? {};
    const previewAgents: MarketplacePreviewAgent[] = agents.map((agent) => {
      const filtered = this.applySelection(plugin, agent, effectiveSelection);
      const artifacts: MarketplacePreviewArtifact[] = [];

      for (const skill of filtered.skills) {
        const sourceDir = path.dirname(skill.path);
        artifacts.push(artifact(
          `skill:${skill.name}`,
          [sourceDir],
          [path.join(agentSkillsDir(agent), skill.name)],
          false,
          nativeConfig?.clonePath,
        ));
      }

      for (const subagent of filtered.agents ?? []) {
        if (agent === 'codex' || agent === 'pi') continue;
        artifacts.push(artifact(
          `agent:${subagent.name}`,
          [subagent.path],
          [path.join(agentDir(agent), `${plugin.id}__${subagent.name}.md`)],
          true,
          nativeConfig?.clonePath,
        ));
      }

      if (filtered.hooks.length > 0) {
        const hookSources = filtered.hooks.flatMap((hook) => hook.jsPath ? [hook.jsPath] : []);
        artifacts.push(artifact(
          'hooks',
          hookSources,
          [hookDestination(agent)],
          true,
          nativeConfig?.clonePath,
          filtered.hooks.map((hook) => hook.command ?? `${hook.event}: JS hook`).join('\n'),
        ));
      }

      for (const server of filtered.mcpServers) {
        artifacts.push(artifact(
          `mcp:${server.name}`,
          localMcpSourcePaths(server, nativeConfig?.clonePath),
          [mcpDestination(agent)],
          true,
          nativeConfig?.clonePath,
          [
            server.command ? [server.command, ...server.args].join(' ') : server.url ?? 'remote MCP server',
            ...formatMcpEnvironmentLines(server.env),
          ].join('\n'),
        ));
      }

      if (agent === 'opencode') {
        for (const jsPlugin of filtered.jsPlugins) {
          artifacts.push(artifact(
            `plugin:${jsPlugin.name}`,
            [jsPlugin.path],
            [path.join(os.homedir(), '.config', 'opencode', 'plugins', `marketplace-${plugin.id}-${jsPlugin.name}.js`)],
            true,
            nativeConfig?.clonePath,
          ));
        }
      }

      const useNative = nativeConfig
        && this.nativeInstaller.supportsNative(agent, nativeConfig.sourceFormat)
        && mode === 'full';
      if (useNative) {
        for (const destinationPath of this.nativeInstaller.getNativeConfigurationPaths(nativeConfig, agent)) {
          artifacts.push({
            contentHashes: [],
            destinationPaths: [destinationPath],
            executable: true,
            name: `native:configuration:${path.basename(destinationPath)}`,
            sourcePaths: [],
            detail: 'Native installer writes and enables marketplace configuration.',
          });
        }
        for (const operation of this.nativeInstaller.getNativeCopyOperations(nativeConfig, agent)) {
          artifacts.push(nativeArtifact(
            `native:${operation.name}`,
            operation.sourcePath,
            operation.destinationPath,
            nativeConfig.clonePath ?? operation.sourcePath,
          ));
        }
      }

      return { agent, artifacts };
    });

    const environmentVariableNames = [...new Set(
      plugin.mcpServers.flatMap((server) => Object.keys(server.env ?? {})),
    )].sort();
    const generatedFiles = [...new Set(
      previewAgents.flatMap((entry) => entry.artifacts.flatMap((item) => item.destinationPaths)),
    )].sort();
    const introducesExecutableBehavior = previewAgents.some((entry) =>
      entry.artifacts.some((item) => item.executable),
    );
    const normalized = stableValue({
      agents: previewAgents,
      environmentVariableNames,
      generatedFiles,
      introducesExecutableBehavior,
      plugin,
      pluginId: plugin.id,
      selected: {
        agents: effectiveSelection?.agents ?? null,
        mcpServers: effectiveSelection?.mcpServers ?? null,
        skills: effectiveSelection?.skills ?? null,
      },
      mode,
      sourceHeadSha: source.headSha,
      sourceUrl: source.sourceUrl,
    });
    const digest = createHash('sha256').update(JSON.stringify(normalized)).digest('hex');

    return {
      agents: previewAgents,
      digest,
      mode,
      environmentVariableNames,
      generatedFiles,
      introducesExecutableBehavior,
      pluginId: plugin.id,
      sourceHeadSha: source.headSha,
      sourceUrl: source.sourceUrl,
    };
  }

  async install(
    plugin: DetectedPlugin,
    agents: AgentName[],
    nativeConfig?: NativeMarketplaceConfig,
    selection?: InstallSelection,
    expectedDigest?: string,
    source?: MarketplaceSourceSnapshot,
    mode: MarketplaceInstallMode = selection === undefined ? 'full' : 'selected',
  ): Promise<InstallResult> {
    const effectiveSelection = mode === 'full' ? undefined : selection ?? {};
    const preview = this.preview(plugin, agents, nativeConfig, effectiveSelection, source, mode);
    if (expectedDigest && expectedDigest !== preview.digest) {
      throw new Error('Marketplace source changed; review the installation again');
    }
    for (const entry of preview.agents) {
      for (const artifact of entry.artifacts) {
        for (const sourcePath of artifact.sourcePaths) {
          if (nativeConfig?.clonePath) {
            collectMarketplaceSourceTreeEntries(sourcePath, nativeConfig.clonePath);
          } else {
            collectMarketplaceSourceTreeEntries(sourcePath);
          }
        }
      }
    }
    const agentResults: InstallResult['agents'] = {};

    for (const agent of agents) {
      const filtered = this.applySelection(plugin, agent, effectiveSelection);
      // Use native registration only for full installs. Partial selections bypass native
      // because native (Claude/Codex plugin system) is all-or-nothing — it would enable
      // artifacts the user explicitly deselected.
      const useNative = nativeConfig
        && this.nativeInstaller.supportsNative(agent, nativeConfig.sourceFormat)
        && mode === 'full';
      if (useNative) {
        agentResults[agent] = this.installNativeWithDirectMcp(filtered, nativeConfig!, agent);
      } else {
        agentResults[agent] = this.installDirect(filtered, agent, nativeConfig?.clonePath);
      }
    }

    return { pluginId: plugin.id, agents: agentResults };
  }

  private applySelection(plugin: DetectedPlugin, agent: AgentName, selection?: InstallSelection): DetectedPlugin {
    const skills = Array.isArray(selection?.skills)
      ? plugin.skills.filter((s) => selection!.skills!.includes(s.name))
      : plugin.skills;

    // Codex MCP install disabled until private-registry auth and timeouts are resolved
    const mcpServers = agent === 'codex'
      ? []
      : Array.isArray(selection?.mcpServers)
        ? plugin.mcpServers.filter((s) => selection!.mcpServers!.includes(s.name))
        : plugin.mcpServers;

    const pluginAgents = Array.isArray(selection?.agents)
      ? plugin.agents.filter((a) => selection!.agents!.includes(a.name))
      : plugin.agents;

    const hooks = Array.isArray(selection?.hooks)
      ? plugin.hooks.filter((h) => selection!.hooks!.includes(h.event))
      : plugin.hooks;

    const jsPlugins = Array.isArray(selection?.jsPlugins)
      ? plugin.jsPlugins.filter((j) => selection!.jsPlugins!.includes(j.name))
      : plugin.jsPlugins;

    return { ...plugin, skills, mcpServers, agents: pluginAgents, hooks, jsPlugins };
  }

  async uninstall(plugin: DetectedPlugin, agents: AgentName[], nativeConfig?: NativeMarketplaceConfig, selection?: InstallSelection): Promise<void> {
    for (const agent of agents) {
      // Apply the same selection used at install time so we only remove what was written
      const filtered = this.applySelection(plugin, agent, selection);
      if (nativeConfig && this.nativeInstaller.supportsNative(agent, nativeConfig.sourceFormat)) {
        this.nativeInstaller.uninstall(nativeConfig, agent);
        for (const skill of filtered.skills) {
          this.skillTranslator.uninstallForAgent(skill.name, agent);
        }
        for (const subagent of filtered.agents ?? []) {
          this.agentTranslator.uninstallForAgent(subagent.name, agent, plugin.id);
        }
        this.hookTranslator.uninstallForAgent(plugin.id, agent);
        for (const server of filtered.mcpServers) {
          if (agent !== 'codex' && this.isLocalScript(server)) {
            this.mcpTranslator.uninstallForAgent(server.name, agent);
          }
        }
      } else {
        this.uninstallDirect(filtered, agent, plugin.id);
      }
    }
  }

  private installNativeWithDirectMcp(plugin: DetectedPlugin, config: NativeMarketplaceConfig, agent: AgentName): AgentInstallResult {
    const skipped: string[] = [];
    try {
      this.nativeInstaller.install(config, agent);
    } catch { /* non-fatal — direct installs below provide coverage */ }

    for (const skill of plugin.skills) {
      this.skillTranslator.installForAgent(skill, agent, config.clonePath);
    }
    for (const subagent of plugin.agents ?? []) {
      this.agentTranslator.installForAgent(subagent, agent, plugin.id);
    }
    for (const hookResult of this.hookTranslator.translateAllForAgent(plugin.hooks, agent, plugin.id)) {
      if (hookResult.status === 'partial') { skipped.push(...hookResult.skipped); }
    }
    for (const server of plugin.mcpServers) {
      if (this.isLocalScript(server)) {
        this.mcpTranslator.installForAgent(server, agent);
      }
    }
    return { status: skipped.length > 0 ? 'partial' : 'full', skipped };
  }

  private isLocalScript(server: { type?: string; command?: string; args?: string[] }): boolean {
    if (server.type === 'http' || server.type === 'sse') return false;
    if (!server.command || server.command === 'npx' || server.command === 'uvx') return false;
    const firstArg = server.args?.[0] ?? '';
    return firstArg.endsWith('.js') || firstArg.endsWith('.ts') || firstArg.endsWith('.py') || firstArg.startsWith('/');
  }

  private installDirect(plugin: DetectedPlugin, agent: AgentName, containmentRoot?: string): AgentInstallResult {
    const skipped: string[] = [];
    for (const skill of plugin.skills) {
      this.skillTranslator.installForAgent(skill, agent, containmentRoot);
    }
    for (const subagent of plugin.agents ?? []) {
      this.agentTranslator.installForAgent(subagent, agent, plugin.id);
    }
    for (const hookResult of this.hookTranslator.translateAllForAgent(plugin.hooks, agent, plugin.id)) {
      if (hookResult.status === 'partial') { skipped.push(...hookResult.skipped); }
    }
    for (const server of plugin.mcpServers) {
      this.mcpTranslator.installForAgent(server, agent);
    }
    if (plugin.jsPlugins.length > 0) {
      if (agent === 'opencode') {
        for (const jsPlugin of plugin.jsPlugins) {
          if (!jsPlugin.path.endsWith('.ts')) {
            this.installJsPlugin(jsPlugin, plugin.id);
          }
        }
      } else {
        skipped.push('JS runtime plugins cannot be translated');
      }
    }
    return { status: skipped.length > 0 ? 'partial' : 'full', skipped };
  }

  private uninstallDirect(plugin: DetectedPlugin, agent: AgentName, pluginId: string): void {
    for (const skill of plugin.skills) {
      this.skillTranslator.uninstallForAgent(skill.name, agent);
    }
    for (const subagent of plugin.agents ?? []) {
      this.agentTranslator.uninstallForAgent(subagent.name, agent, pluginId);
    }
    if (agent !== 'codex') {
      for (const server of plugin.mcpServers) {
        this.mcpTranslator.uninstallForAgent(server.name, agent);
      }
    }
    this.hookTranslator.uninstallForAgent(pluginId, agent);
    if (agent === 'opencode') {
      this.uninstallJsPlugins(pluginId);
    }
  }

  private installJsPlugin(jsPlugin: JsPluginEntry, pluginId: string): string {
    const pluginsDir = path.join(os.homedir(), '.config', 'opencode', 'plugins');
    mkdirSync(pluginsDir, { recursive: true });
    const targetPath = path.join(pluginsDir, `marketplace-${pluginId}-${jsPlugin.name}.js`);
    copyFileSync(jsPlugin.path, targetPath);
    return targetPath;
  }

  private uninstallJsPlugins(pluginId: string): void {
    const pluginsDir = path.join(os.homedir(), '.config', 'opencode', 'plugins');
    if (!existsSync(pluginsDir)) return;
    const prefix = `marketplace-${pluginId}-`;
    try {
      for (const f of readdirSync(pluginsDir)) {
        if (f.startsWith(prefix) && f.endsWith('.js')) {
          rmSync(path.join(pluginsDir, f), { force: true });
        }
      }
    } catch { /* ignore */ }
  }
}
