import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import type { AgentName } from '../../utils/agentLaunch.js';
import { loadJson, safeResolveUnder } from './utils.js';

export interface NativeMarketplaceConfig {
  marketplaceUrl: string;
  marketplaceName: string;
  pluginId: string;
  sourceFormat?: string;
  clonePath?: string;
  pluginVersion?: string;
  /** True iff this is the last installed plugin from this marketplace source.
   *  When false/undefined, uninstall only removes the per-plugin enabled/cache
   *  entries; marketplace-level registration and clone stay so sibling plugins
   *  from the same source keep working. */
  isLastPluginFromMarketplace?: boolean;
}

export interface NativeCopyOperation {
  name: string;
  sourcePath: string;
  destinationPath: string;
}

const UNKNOWN_VERSION = 'unknown';

export class NativeInstaller {
  supportsNative(agent: AgentName, sourceFormat?: string): boolean {
    if (agent === 'claude') return !sourceFormat || sourceFormat === 'claude-marketplace';
    if (agent === 'codex') return !sourceFormat || sourceFormat === 'codex-plugin';
    return false;
  }

  install(config: NativeMarketplaceConfig, agent: AgentName, home = os.homedir()): string {
    switch (agent) {
      case 'claude': return this.installForClaude(config, home);
      case 'codex': return this.installForCodex(config, home);
      default: throw new Error(`Native install not supported for ${agent}`);
    }
  }

  uninstall(config: NativeMarketplaceConfig, agent: AgentName, home = os.homedir()): void {
    switch (agent) {
      case 'claude': this.uninstallFromClaude(config, home); break;
      case 'codex': this.uninstallFromCodex(config, home); break;
    }
  }

  getNativeCopyOperations(
    config: NativeMarketplaceConfig,
    agent: AgentName,
    home = os.homedir(),
  ): NativeCopyOperation[] {
    if (agent !== 'claude' || !config.clonePath) return [];

    const operations: NativeCopyOperation[] = [{
      name: 'marketplace clone',
      sourcePath: config.clonePath,
      destinationPath: path.join(home, '.claude', 'plugins', 'marketplaces', config.marketplaceName),
    }];
    const pluginSourceDir = this.findPluginSourceDir(config);
    if (pluginSourceDir) {
      const version = config.pluginVersion ?? UNKNOWN_VERSION;
      operations.push({
        name: 'plugin cache',
        sourcePath: pluginSourceDir,
        destinationPath: path.join(
          home,
          '.claude',
          'plugins',
          'cache',
          config.marketplaceName,
          config.pluginId,
          version,
        ),
      });
    }
    return operations;
  }

  getNativeConfigurationPaths(_config: NativeMarketplaceConfig, agent: AgentName, home = os.homedir()): string[] {
    if (agent === 'codex') return [path.join(home, '.codex', 'config.toml')];
    if (agent === 'claude') {
      return [
        path.join(home, '.claude', 'settings.json'),
        path.join(home, '.claude', 'plugins', 'known_marketplaces.json'),
        path.join(home, '.claude', 'plugins', 'installed_plugins.json'),
      ];
    }
    return [];
  }

  private installForClaude(config: NativeMarketplaceConfig, home: string): string {
    const settingsPath = path.join(home, '.claude', 'settings.json');
    mkdirSync(path.dirname(settingsPath), { recursive: true });

    // Seed clone and cache first — if they fail, settings.json stays untouched
    if (config.clonePath) {
      const timestamp = new Date().toISOString();
      this.seedClaudeMarketplaceClone(config, home);
      this.seedClaudePluginCache(config, home);
      this.writeClaudeKnownMarketplaces(config, home, timestamp);
      this.writeClaudeInstalledPlugins(config, home, timestamp);
    }

    // Write settings.json only after all side-effects succeed
    const settings = loadJson(settingsPath);
    if (!settings.extraKnownMarketplaces) settings.extraKnownMarketplaces = {};
    (settings.extraKnownMarketplaces as Record<string, unknown>)[config.marketplaceName] = {
      source: { source: 'git', url: config.marketplaceUrl },
      autoUpdate: true,
    };
    if (!settings.enabledPlugins) settings.enabledPlugins = {};
    (settings.enabledPlugins as Record<string, unknown>)[this.pluginKey(config)] = true;
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');

    return settingsPath;
  }

  private seedClaudeMarketplaceClone(config: NativeMarketplaceConfig, home: string): void {
    const targetDir = path.join(home, '.claude', 'plugins', 'marketplaces', config.marketplaceName);
    if (!existsSync(targetDir)) {
      mkdirSync(path.dirname(targetDir), { recursive: true });
      cpSync(config.clonePath!, targetDir, { recursive: true });
    }
  }

  private seedClaudePluginCache(config: NativeMarketplaceConfig, home: string): void {
    const version = config.pluginVersion ?? UNKNOWN_VERSION;
    const cacheDir = path.join(home, '.claude', 'plugins', 'cache', config.marketplaceName, config.pluginId, version);
    if (existsSync(cacheDir)) return;
    const pluginSourceDir = this.findPluginSourceDir(config);
    if (!pluginSourceDir) return;
    mkdirSync(cacheDir, { recursive: true });
    cpSync(pluginSourceDir, cacheDir, { recursive: true });
  }

  private findPluginSourceDir(config: NativeMarketplaceConfig): string | null {
    if (!config.clonePath) return null;
    const clonePath = config.clonePath;
    const manifestPath = path.join(clonePath, '.claude-plugin', 'marketplace.json');
    if (existsSync(manifestPath)) {
      try {
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as { plugins?: unknown[] };
        for (const entry of manifest.plugins ?? []) {
          const name = typeof entry === 'string' ? entry : (entry as Record<string, unknown>).name as string;
          if (name !== config.pluginId) continue;
          const source = typeof entry === 'string' ? undefined : (entry as Record<string, unknown>).source as string | undefined;
          if (source === undefined) {
            return path.join(clonePath, 'plugins', name);
          }
          // Reject sources that escape the clone (mirrors FormatDetector). A malicious
          // marketplace can list the same plugin twice — first with `../../...`, then safely —
          // so keep scanning rather than returning on the first match.
          const resolved = safeResolveUnder(clonePath, source);
          if (!resolved) continue;
          if (!existsSync(resolved)) continue;
          return resolved;
        }
      } catch { /* fall through */ }
    }
    const fallback = path.join(clonePath, 'plugins', config.pluginId);
    return existsSync(fallback) ? fallback : null;
  }

  private writeClaudeKnownMarketplaces(config: NativeMarketplaceConfig, home: string, timestamp: string): void {
    const knownPath = path.join(home, '.claude', 'plugins', 'known_marketplaces.json');
    mkdirSync(path.dirname(knownPath), { recursive: true });
    const known = loadJson(knownPath);
    if (Object.hasOwn(known, config.marketplaceName)) return;
    known[config.marketplaceName] = {
      source: { source: 'git', url: config.marketplaceUrl },
      installLocation: path.join(home, '.claude', 'plugins', 'marketplaces', config.marketplaceName),
      lastUpdated: timestamp,
      autoUpdate: true,
    };
    writeFileSync(knownPath, JSON.stringify(known, null, 2), 'utf-8');
  }

  private writeClaudeInstalledPlugins(config: NativeMarketplaceConfig, home: string, timestamp: string): void {
    const installedPath = path.join(home, '.claude', 'plugins', 'installed_plugins.json');
    mkdirSync(path.dirname(installedPath), { recursive: true });
    const version = config.pluginVersion ?? UNKNOWN_VERSION;
    const cachePath = path.join(home, '.claude', 'plugins', 'cache', config.marketplaceName, config.pluginId, version);
    const data = loadJson(installedPath);
    if (!data.version) data.version = 2;
    if (!data.plugins) data.plugins = {};
    (data.plugins as Record<string, unknown>)[this.pluginKey(config)] = [{
      scope: 'user',
      installPath: cachePath,
      version,
      installedAt: timestamp,
      lastUpdated: timestamp,
    }];
    writeFileSync(installedPath, JSON.stringify(data, null, 2), 'utf-8');
  }

  private installForCodex(config: NativeMarketplaceConfig, home: string): string {
    const configPath = path.join(home, '.codex', 'config.toml');
    mkdirSync(path.dirname(configPath), { recursive: true });
    let content = existsSync(configPath) ? readFileSync(configPath, 'utf-8') : '';
    const marketplaceSection = `[marketplaces.${config.marketplaceName}]`;
    if (!content.includes(marketplaceSection)) {
      content = content.trimEnd() + `\n\n${marketplaceSection}\nsource_type = "git"\nsource = ${JSON.stringify(config.marketplaceUrl)}\n`;
    }
    const pluginSection = `[plugins."${this.pluginKey(config)}"]`;
    if (!content.includes(pluginSection)) {
      content = content.trimEnd() + `\n\n${pluginSection}\nenabled = true\n`;
    }
    writeFileSync(configPath, content, 'utf-8');
    return configPath;
  }

  private uninstallFromClaude(config: NativeMarketplaceConfig, home: string): void {
    const settingsPath = path.join(home, '.claude', 'settings.json');
    if (!existsSync(settingsPath)) return;

    const settings = loadJson(settingsPath);
    const key = this.pluginKey(config);
    if (settings.enabledPlugins) delete (settings.enabledPlugins as Record<string, unknown>)[key];
    // Marketplace-level registration is shared by all plugins from this source — only drop it
    // when this is the last plugin being uninstalled, otherwise siblings lose their marketplace.
    if (config.isLastPluginFromMarketplace && settings.extraKnownMarketplaces) {
      delete (settings.extraKnownMarketplaces as Record<string, unknown>)[config.marketplaceName];
    }
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');

    this.updateJsonFile(
      path.join(home, '.claude', 'plugins', 'installed_plugins.json'),
      (d) => { if (d.plugins) delete (d.plugins as Record<string, unknown>)[key]; },
    );
    if (config.isLastPluginFromMarketplace) {
      this.updateJsonFile(
        path.join(home, '.claude', 'plugins', 'known_marketplaces.json'),
        (d) => { delete d[config.marketplaceName]; },
      );
    }

    const version = config.pluginVersion ?? UNKNOWN_VERSION;
    const cacheDir = path.join(home, '.claude', 'plugins', 'cache', config.marketplaceName, config.pluginId, version);
    if (existsSync(cacheDir)) rmSync(cacheDir, { recursive: true, force: true });
    this.removeIfEmpty(path.join(home, '.claude', 'plugins', 'cache', config.marketplaceName, config.pluginId));
    if (config.isLastPluginFromMarketplace) {
      this.removeIfEmpty(path.join(home, '.claude', 'plugins', 'cache', config.marketplaceName));
      const clone = path.join(home, '.claude', 'plugins', 'marketplaces', config.marketplaceName);
      if (existsSync(clone)) rmSync(clone, { recursive: true, force: true });
    }
  }

  private uninstallFromCodex(config: NativeMarketplaceConfig, home: string): void {
    const configPath = path.join(home, '.codex', 'config.toml');
    if (!existsSync(configPath)) return;
    let content = readFileSync(configPath, 'utf-8');
    content = this.removeTomlSection(content, `[plugins."${this.pluginKey(config)}"]`);
    if (config.isLastPluginFromMarketplace) {
      content = this.removeTomlSection(content, `[marketplaces.${config.marketplaceName}]`);
    }
    writeFileSync(configPath, content, 'utf-8');
  }

  private pluginKey(config: NativeMarketplaceConfig): string {
    return `${config.pluginId}@${config.marketplaceName}`;
  }

  private updateJsonFile(filePath: string, updater: (data: Record<string, unknown>) => void): void {
    if (!existsSync(filePath)) return;
    const data = loadJson(filePath);
    updater(data);
    writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
  }

  private removeTomlSection(content: string, sectionHeader: string): string {
    const lines = content.split('\n');
    const result: string[] = [];
    let skipping = false;
    for (const line of lines) {
      if (line.trim() === sectionHeader) { skipping = true; continue; }
      if (skipping && line.trim().startsWith('[')) skipping = false;
      if (!skipping) result.push(line);
    }
    return result.join('\n').replace(/\n{3,}/g, '\n\n');
  }

  private removeIfEmpty(dir: string): void {
    try {
      if (readdirSync(dir).length === 0) rmSync(dir, { recursive: true, force: true });
    } catch { /* ignore */ }
  }
}
