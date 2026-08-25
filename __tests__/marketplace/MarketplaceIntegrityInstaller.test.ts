import { existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MarketplaceIntegrityInstaller } from '../../src/services/marketplace/MarketplaceIntegrityInstaller.js';
import { MarketplaceInstaller } from '../../src/services/marketplace/MarketplaceInstaller.js';
import type { DetectedPlugin } from '../../src/services/marketplace/types.js';

function setup(): { homeDir: string; journalDir: string; plugin: DetectedPlugin; skillPath: string } {
  const root = mkdtempSync(path.join(tmpdir(), 'muxbase-marketplace-integrity-'));
  const sourceDir = path.join(root, 'source-skill');
  const homeDir = path.join(root, 'home');
  mkdirSync(sourceDir);
  writeFileSync(path.join(sourceDir, 'SKILL.md'), '# marketplace skill\n');
  return {
    homeDir,
    journalDir: path.join(root, 'journal'),
    plugin: {
      id: 'marketplace-plugin',
      name: 'Marketplace Plugin',
      skills: [{ name: 'safe-skill', path: path.join(sourceDir, 'SKILL.md') }],
      agents: [],
      hooks: [],
      mcpServers: [],
      jsPlugins: [],
    },
    skillPath: path.join(sourceDir, 'SKILL.md'),
  };
}

describe('MarketplaceIntegrityInstaller', () => {
  it('materializes safe internal symlinks during a full native install', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'muxbase-marketplace-integrity-'));
    const clonePath = path.join(root, 'source');
    const homeDir = path.join(root, 'home');
    mkdirSync(clonePath);
    writeFileSync(path.join(clonePath, 'AGENTS.md'), '# Shared instructions\n');
    symlinkSync('AGENTS.md', path.join(clonePath, 'CLAUDE.md'));
    const plugin: DetectedPlugin = {
      agents: [],
      hooks: [],
      id: 'native-plugin',
      jsPlugins: [],
      mcpServers: [],
      name: 'Native Plugin',
      skills: [],
    };

    const result = new MarketplaceIntegrityInstaller().install(
      plugin,
      ['claude'],
      {
        clonePath,
        marketplaceName: 'native-marketplace',
        marketplaceUrl: 'https://example.test/native-marketplace.git',
        pluginId: plugin.id,
        sourceFormat: 'claude-marketplace',
      },
      undefined,
      'full',
      { homeDir, journalDir: path.join(root, 'journal') },
    );
    const installedLinkPath = path.join(homeDir, '.claude', 'plugins', 'marketplaces', 'native-marketplace', 'CLAUDE.md');

    expect(lstatSync(installedLinkPath).isSymbolicLink()).toBe(false);
    expect(readFileSync(installedLinkPath, 'utf8')).toBe('# Shared instructions\n');
    expect(result.ownershipManifest.artifacts).toContainEqual(expect.objectContaining({
      path: path.dirname(installedLinkPath),
      scope: 'source',
      type: 'directory',
    }));
  });

  it('materializes safe internal symlinks inside directly installed skills', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'muxbase-marketplace-integrity-'));
    const clonePath = path.join(root, 'source');
    const skillDir = path.join(clonePath, 'plugins', 'native-plugin', 'skills', 'safe-skill');
    const homeDir = path.join(root, 'home');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(path.join(skillDir, 'SKILL.md'), '# Marketplace skill\n');
    writeFileSync(path.join(skillDir, 'REFERENCE.md'), '# Shared reference\n');
    symlinkSync('REFERENCE.md', path.join(skillDir, 'REFERENCE-ALIAS.md'));
    const plugin: DetectedPlugin = {
      agents: [],
      hooks: [],
      id: 'native-plugin',
      jsPlugins: [],
      mcpServers: [],
      name: 'Native Plugin',
      skills: [{ name: 'safe-skill', path: path.join(skillDir, 'SKILL.md') }],
    };
    const nativeConfig = {
      clonePath,
      marketplaceName: 'native-marketplace',
      marketplaceUrl: 'https://example.test/native-marketplace.git',
      pluginId: plugin.id,
      sourceFormat: 'claude-marketplace' as const,
    };

    expect(() => new MarketplaceInstaller().preview(
      plugin,
      ['claude'],
      nativeConfig,
      undefined,
      { headSha: 'head-1', sourceUrl: nativeConfig.marketplaceUrl },
      'full',
    )).not.toThrow();

    new MarketplaceIntegrityInstaller().install(
      plugin,
      ['claude'],
      nativeConfig,
      undefined,
      'full',
      { homeDir, journalDir: path.join(root, 'journal') },
    );
    const installedAlias = path.join(homeDir, '.claude', 'skills', 'safe-skill', 'REFERENCE-ALIAS.md');

    expect(lstatSync(installedAlias).isSymbolicLink()).toBe(false);
    expect(readFileSync(installedAlias, 'utf8')).toBe('# Shared reference\n');
  });

  it('rejects a skill symlink that escapes the marketplace clone', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'muxbase-marketplace-integrity-'));
    const clonePath = path.join(root, 'source');
    const skillDir = path.join(clonePath, 'skills', 'unsafe-skill');
    const outsidePath = path.join(root, 'outside.md');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(path.join(skillDir, 'SKILL.md'), '# Marketplace skill\n');
    writeFileSync(outsidePath, '# Outside\n');
    symlinkSync(path.relative(skillDir, outsidePath), path.join(skillDir, 'ESCAPE.md'));
    const plugin: DetectedPlugin = {
      agents: [],
      hooks: [],
      id: 'unsafe-plugin',
      jsPlugins: [],
      mcpServers: [],
      name: 'Unsafe Plugin',
      skills: [{ name: 'unsafe-skill', path: path.join(skillDir, 'SKILL.md') }],
    };

    expect(() => new MarketplaceInstaller().preview(plugin, ['claude'], {
      clonePath,
      marketplaceName: 'unsafe-marketplace',
      marketplaceUrl: 'https://example.test/unsafe-marketplace.git',
      pluginId: plugin.id,
      sourceFormat: 'claude-marketplace',
    })).toThrow('escapes source tree');
  });

  it('installs a skill transactionally and records the directory digest as ownership', () => {
    const { homeDir, journalDir, plugin } = setup();
    const result = new MarketplaceIntegrityInstaller().install(
      plugin,
      ['claude'],
      undefined,
      undefined,
      'full',
      { homeDir, journalDir },
    );
    const installedPath = path.join(homeDir, '.claude', 'skills', 'safe-skill', 'SKILL.md');

    expect(readFileSync(installedPath, 'utf8')).toBe('# marketplace skill\n');
    expect(result.ownershipManifest.artifacts).toEqual([
      expect.objectContaining({
        agent: 'claude',
        path: path.join(homeDir, '.claude', 'skills', 'safe-skill'),
        type: 'directory',
      }),
    ]);
  });

  it('preserves a pre-existing unowned skill directory', () => {
    const { homeDir, journalDir, plugin } = setup();
    const existingPath = path.join(homeDir, '.claude', 'skills', 'safe-skill');
    mkdirSync(existingPath, { recursive: true });
    writeFileSync(path.join(existingPath, 'SKILL.md'), '# user skill\n');

    expect(() => new MarketplaceIntegrityInstaller().install(
      plugin,
      ['claude'],
      undefined,
      undefined,
      'full',
      { homeDir, journalDir },
    )).toThrow('DESTINATION_CONFLICT');
    expect(readFileSync(path.join(existingPath, 'SKILL.md'), 'utf8')).toBe('# user skill\n');
  });

  it('preserves an owned skill that was modified after installation', () => {
    const { homeDir, journalDir, plugin } = setup();
    const first = new MarketplaceIntegrityInstaller().install(
      plugin,
      ['claude'],
      undefined,
      undefined,
      'full',
      { homeDir, journalDir },
    );
    const installedPath = path.join(homeDir, '.claude', 'skills', 'safe-skill', 'SKILL.md');
    writeFileSync(installedPath, '# modified by user\n');
    writeFileSync(plugin.skills[0].path, '# updated marketplace skill\n');

    expect(() => new MarketplaceIntegrityInstaller().install(
      plugin,
      ['claude'],
      undefined,
      undefined,
      'full',
      { homeDir, journalDir, ownershipManifest: first.ownershipManifest },
    )).toThrow('ARTIFACT_MODIFIED');
    expect(readFileSync(installedPath, 'utf8')).toBe('# modified by user\n');
    expect(existsSync(installedPath)).toBe(true);
  });

  it('preserves a same-named unowned MCP configuration entry', () => {
    const { homeDir, journalDir } = setup();
    const settingsPath = path.join(homeDir, '.claude', 'settings.json');
    mkdirSync(path.dirname(settingsPath), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify({
      mcpServers: { existing: { command: 'user-command', args: ['user-server.js'] } },
      unrelated: { keep: true },
    }));
    const plugin: DetectedPlugin = {
      id: 'mcp-plugin',
      name: 'MCP Plugin',
      skills: [],
      agents: [],
      hooks: [],
      mcpServers: [{ name: 'existing', command: 'node', args: ['marketplace-server.js'] }],
      jsPlugins: [],
    };

    expect(() => new MarketplaceIntegrityInstaller().install(
      plugin,
      ['claude'],
      undefined,
      undefined,
      'full',
      { homeDir, journalDir },
    )).toThrow('DESTINATION_CONFLICT');
    expect(JSON.parse(readFileSync(settingsPath, 'utf8'))).toEqual({
      mcpServers: { existing: { command: 'user-command', args: ['user-server.js'] } },
      unrelated: { keep: true },
    });
  });

  it('removes only an unchanged owned skill during uninstall', () => {
    const { homeDir, journalDir, plugin } = setup();
    const installer = new MarketplaceIntegrityInstaller();
    const installed = installer.install(plugin, ['claude'], undefined, undefined, 'full', { homeDir, journalDir });
    const skillDir = path.join(homeDir, '.claude', 'skills', 'safe-skill');

    const result = installer.uninstall(plugin, ['claude'], undefined, undefined, {
      homeDir,
      journalDir,
      ownershipManifest: installed.ownershipManifest,
    });

    expect(existsSync(skillDir)).toBe(false);
    expect(result.preservedArtifacts).toEqual([]);
  });

  it('retains a user-modified owned skill during uninstall', () => {
    const { homeDir, journalDir, plugin } = setup();
    const installer = new MarketplaceIntegrityInstaller();
    const installed = installer.install(plugin, ['claude'], undefined, undefined, 'full', { homeDir, journalDir });
    const skillFile = path.join(homeDir, '.claude', 'skills', 'safe-skill', 'SKILL.md');
    writeFileSync(skillFile, '# user modification\n');

    const result = installer.uninstall(plugin, ['claude'], undefined, undefined, {
      homeDir,
      journalDir,
      ownershipManifest: installed.ownershipManifest,
    });

    expect(readFileSync(skillFile, 'utf8')).toBe('# user modification\n');
    expect(result.preservedArtifacts).toEqual([path.dirname(skillFile)]);
  });

  it('does not claim or remove native configuration during a selected install', () => {
    const { homeDir, journalDir, plugin } = setup();
    const knownMarketplacesPath = path.join(homeDir, '.claude', 'plugins', 'known_marketplaces.json');
    const installedPluginsPath = path.join(homeDir, '.claude', 'plugins', 'installed_plugins.json');
    mkdirSync(path.dirname(knownMarketplacesPath), { recursive: true });
    writeFileSync(knownMarketplacesPath, '{"user-marketplace":{"keep":true}}');
    writeFileSync(installedPluginsPath, '{"version":2,"plugins":{"user-plugin":[]}}');
    const nativeConfig = {
      marketplaceName: 'selected-marketplace',
      marketplaceUrl: 'https://example.test/marketplace.git',
      pluginId: plugin.id,
      sourceFormat: 'claude-marketplace',
    };
    const installer = new MarketplaceIntegrityInstaller();

    const installed = installer.install(
      plugin,
      ['claude'],
      nativeConfig,
      { skills: ['safe-skill'] },
      'selected',
      { homeDir, journalDir },
    );

    expect(installed.ownershipManifest.artifacts.map((artifact) => artifact.path))
      .not.toContain(knownMarketplacesPath);
    expect(installed.ownershipManifest.artifacts.map((artifact) => artifact.path))
      .not.toContain(installedPluginsPath);

    installer.uninstall(plugin, ['claude'], undefined, { skills: ['safe-skill'] }, {
      homeDir,
      journalDir,
      ownershipManifest: installed.ownershipManifest,
    });

    expect(readFileSync(knownMarketplacesPath, 'utf8')).toBe('{"user-marketplace":{"keep":true}}');
    expect(readFileSync(installedPluginsPath, 'utf8')).toBe('{"version":2,"plugins":{"user-plugin":[]}}');
  });

  it('removes multiple unchanged MCP entries with one shared-config mutation', () => {
    const { homeDir, journalDir } = setup();
    const settingsPath = path.join(homeDir, '.claude', 'settings.json');
    mkdirSync(path.dirname(settingsPath), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify({ unrelated: { keep: true } }));
    const plugin: DetectedPlugin = {
      id: 'multi-mcp-plugin',
      name: 'Multi MCP Plugin',
      skills: [],
      agents: [],
      hooks: [],
      mcpServers: [
        { name: 'first', command: 'node', args: ['first.js'] },
        { name: 'second', command: 'node', args: ['second.js'] },
      ],
      jsPlugins: [],
    };
    const installer = new MarketplaceIntegrityInstaller();
    const installed = installer.install(plugin, ['claude'], undefined, undefined, 'full', { homeDir, journalDir });

    const result = installer.uninstall(plugin, ['claude'], undefined, undefined, {
      homeDir,
      journalDir,
      ownershipManifest: installed.ownershipManifest,
    });

    expect(result.preservedArtifacts).toEqual([]);
    expect(JSON.parse(readFileSync(settingsPath, 'utf8'))).toEqual({
      mcpServers: {},
      unrelated: { keep: true },
    });
  });

  it('preserves a modified MCP entry while removing its unchanged sibling', () => {
    const { homeDir, journalDir } = setup();
    const settingsPath = path.join(homeDir, '.claude', 'settings.json');
    const plugin: DetectedPlugin = {
      id: 'modified-mcp-plugin',
      name: 'Modified MCP Plugin',
      skills: [],
      agents: [],
      hooks: [],
      mcpServers: [
        { name: 'modified', command: 'node', args: ['original.js'] },
        { name: 'unchanged', command: 'node', args: ['unchanged.js'] },
      ],
      jsPlugins: [],
    };
    const installer = new MarketplaceIntegrityInstaller();
    const installed = installer.install(plugin, ['claude'], undefined, undefined, 'full', { homeDir, journalDir });
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as {
      mcpServers: Record<string, { command: string; args: string[] }>;
    };
    settings.mcpServers.modified = { command: 'user-command', args: ['user.js'] };
    writeFileSync(settingsPath, JSON.stringify(settings));

    const result = installer.uninstall(plugin, ['claude'], undefined, undefined, {
      homeDir,
      journalDir,
      ownershipManifest: installed.ownershipManifest,
    });

    const remaining = JSON.parse(readFileSync(settingsPath, 'utf8')) as {
      mcpServers: Record<string, { command: string; args: string[] }>;
    };
    expect(remaining.mcpServers.modified).toEqual({ command: 'user-command', args: ['user.js'] });
    expect(remaining.mcpServers).not.toHaveProperty('unchanged');
    expect(result.preservedArtifacts).toEqual([settingsPath]);
  });

  it('installs and uninstalls an OpenCode hook plugin through the transaction path', () => {
    const { homeDir, journalDir } = setup();
    const pluginPath = path.join(homeDir, '.config', 'opencode', 'plugins', 'marketplace-hook-plugin.js');
    const plugin: DetectedPlugin = {
      id: 'hook-plugin',
      name: 'Hook Plugin',
      skills: [],
      agents: [],
      hooks: [{ event: 'PostToolUse', command: 'echo checked', sourceFormat: 'claude' }],
      mcpServers: [],
      jsPlugins: [],
    };
    const installer = new MarketplaceIntegrityInstaller();

    const installed = installer.install(plugin, ['opencode'], undefined, undefined, 'full', { homeDir, journalDir });

    expect(readFileSync(pluginPath, 'utf8')).toContain('echo checked');
    expect(installed.ownershipManifest.artifacts).toContainEqual(expect.objectContaining({
      agent: 'opencode',
      path: pluginPath,
      type: 'file',
    }));

    installer.uninstall(plugin, ['opencode'], undefined, undefined, {
      homeDir,
      journalDir,
      ownershipManifest: installed.ownershipManifest,
    });
    expect(existsSync(pluginPath)).toBe(false);
  });

  it('does not overwrite an owned hook configuration entry modified by the user', () => {
    const { homeDir, journalDir } = setup();
    const settingsPath = path.join(homeDir, '.claude', 'settings.json');
    const plugin: DetectedPlugin = {
      id: 'managed-hook-plugin',
      name: 'Managed Hook Plugin',
      skills: [],
      agents: [],
      hooks: [{ event: 'PostToolUse', command: 'echo marketplace', sourceFormat: 'claude' }],
      mcpServers: [],
      jsPlugins: [],
    };
    const installer = new MarketplaceIntegrityInstaller();
    const installed = installer.install(plugin, ['claude'], undefined, undefined, 'full', { homeDir, journalDir });
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    };
    settings.hooks.PostToolUse[0].hooks[0].command = 'echo user-change';
    writeFileSync(settingsPath, JSON.stringify(settings));

    expect(() => installer.install(plugin, ['claude'], undefined, undefined, 'full', {
      homeDir,
      journalDir,
      ownershipManifest: installed.ownershipManifest,
    })).toThrow('ARTIFACT_MODIFIED');
    expect(readFileSync(settingsPath, 'utf8')).toContain('echo user-change');
  });

  it('removes an unchanged hook without touching unrelated settings added after install', () => {
    const { homeDir, journalDir } = setup();
    const settingsPath = path.join(homeDir, '.claude', 'settings.json');
    const plugin: DetectedPlugin = {
      id: 'precise-hook-plugin',
      name: 'Precise Hook Plugin',
      skills: [],
      agents: [],
      hooks: [{ event: 'PostToolUse', command: 'echo marketplace', sourceFormat: 'claude' }],
      mcpServers: [],
      jsPlugins: [],
    };
    const installer = new MarketplaceIntegrityInstaller();
    const installed = installer.install(plugin, ['claude'], undefined, undefined, 'full', { homeDir, journalDir });
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as Record<string, unknown>;
    settings.userSetting = { keep: true };
    writeFileSync(settingsPath, JSON.stringify(settings));

    const result = installer.uninstall(plugin, ['claude'], undefined, undefined, {
      homeDir,
      journalDir,
      ownershipManifest: installed.ownershipManifest,
    });

    expect(result.preservedArtifacts).toEqual([]);
    expect(JSON.parse(readFileSync(settingsPath, 'utf8'))).toEqual({ userSetting: { keep: true } });
  });

  it('shares native marketplace registration and clone across sibling plugins until the last uninstall', () => {
    const { homeDir, journalDir } = setup();
    const clonePath = path.join(path.dirname(homeDir), 'native-marketplace');
    mkdirSync(clonePath, { recursive: true });
    writeFileSync(path.join(clonePath, 'marketplace.md'), '# source\n');
    const installer = new MarketplaceIntegrityInstaller();
    const firstPlugin: DetectedPlugin = {
      id: 'native-one', name: 'Native One', skills: [], agents: [], hooks: [], mcpServers: [], jsPlugins: [],
    };
    const secondPlugin: DetectedPlugin = {
      id: 'native-two', name: 'Native Two', skills: [], agents: [], hooks: [], mcpServers: [], jsPlugins: [],
    };
    const marketplace = {
      clonePath,
      marketplaceName: 'shared-marketplace',
      marketplaceUrl: 'https://example.test/marketplace.git',
      sourceFormat: 'claude-marketplace',
    };
    const first = installer.install(firstPlugin, ['claude'], { ...marketplace, pluginId: firstPlugin.id }, undefined, 'full', {
      homeDir,
      journalDir,
    });
    const second = installer.install(secondPlugin, ['claude'], { ...marketplace, pluginId: secondPlugin.id }, undefined, 'full', {
      homeDir,
      journalDir,
      sharedOwnershipManifests: [first.ownershipManifest],
    });
    const installedClone = path.join(homeDir, '.claude', 'plugins', 'marketplaces', marketplace.marketplaceName);

    installer.uninstall(firstPlugin, ['claude'], {
      ...marketplace,
      isLastPluginFromMarketplace: false,
      pluginId: firstPlugin.id,
    }, undefined, { homeDir, journalDir, ownershipManifest: first.ownershipManifest });
    expect(existsSync(installedClone)).toBe(true);
    expect(JSON.parse(readFileSync(path.join(homeDir, '.claude', 'settings.json'), 'utf8')).enabledPlugins)
      .toEqual({ 'native-two@shared-marketplace': true });

    installer.uninstall(secondPlugin, ['claude'], {
      ...marketplace,
      isLastPluginFromMarketplace: true,
      pluginId: secondPlugin.id,
    }, undefined, { homeDir, journalDir, ownershipManifest: second.ownershipManifest });
    expect(existsSync(installedClone)).toBe(false);
  });

  it.each([
    { destinationAlreadyUpdated: false, expectedInstalledContent: '# v1\n' },
    { destinationAlreadyUpdated: true, expectedInstalledContent: '# v2\n' },
  ])('rejects a shared native clone update when destinationAlreadyUpdated=$destinationAlreadyUpdated', ({
    destinationAlreadyUpdated,
    expectedInstalledContent,
  }) => {
    const { homeDir, journalDir } = setup();
    const clonePath = path.join(path.dirname(homeDir), 'native-marketplace-update');
    mkdirSync(clonePath, { recursive: true });
    const cloneFile = path.join(clonePath, 'marketplace.md');
    writeFileSync(cloneFile, '# v1\n');
    const installer = new MarketplaceIntegrityInstaller();
    const firstPlugin: DetectedPlugin = {
      id: 'native-update-one', name: 'Native Update One', skills: [], agents: [], hooks: [], mcpServers: [], jsPlugins: [],
    };
    const secondPlugin: DetectedPlugin = {
      id: 'native-update-two', name: 'Native Update Two', skills: [], agents: [], hooks: [], mcpServers: [], jsPlugins: [],
    };
    const marketplace = {
      clonePath,
      marketplaceName: 'shared-update-marketplace',
      marketplaceUrl: 'https://example.test/marketplace.git',
      sourceFormat: 'claude-marketplace',
    };
    const first = installer.install(firstPlugin, ['claude'], { ...marketplace, pluginId: firstPlugin.id }, undefined, 'full', {
      homeDir,
      journalDir,
    });
    const second = installer.install(secondPlugin, ['claude'], { ...marketplace, pluginId: secondPlugin.id }, undefined, 'full', {
      homeDir,
      journalDir,
      sharedOwnershipManifests: [first.ownershipManifest],
    });
    writeFileSync(cloneFile, '# v2\n');
    const installedCloneFile = path.join(
      homeDir,
      '.claude',
      'plugins',
      'marketplaces',
      marketplace.marketplaceName,
      'marketplace.md',
    );
    if (destinationAlreadyUpdated) writeFileSync(installedCloneFile, '# v2\n');

    expect(() => installer.install(firstPlugin, ['claude'], { ...marketplace, pluginId: firstPlugin.id }, undefined, 'full', {
      homeDir,
      journalDir,
      ownershipManifest: first.ownershipManifest,
      sharedOwnershipManifests: [second.ownershipManifest],
    })).toThrow('ARTIFACT_MODIFIED');
    expect(readFileSync(installedCloneFile, 'utf8')).toBe(expectedInstalledContent);
  });

  it('keeps hook ownership exact when one plugin ID prefixes another', () => {
    const { homeDir, journalDir } = setup();
    const firstPlugin: DetectedPlugin = {
      id: 'foo', name: 'Foo', skills: [], agents: [],
      hooks: [{ event: 'PostToolUse', command: 'echo foo', sourceFormat: 'claude' }], mcpServers: [], jsPlugins: [],
    };
    const secondPlugin: DetectedPlugin = {
      id: 'foo__bar', name: 'Foo Bar', skills: [], agents: [],
      hooks: [{ event: 'PostToolUse', command: 'echo foo-bar', sourceFormat: 'claude' }], mcpServers: [], jsPlugins: [],
    };
    const installer = new MarketplaceIntegrityInstaller();
    const first = installer.install(firstPlugin, ['claude'], undefined, undefined, 'full', { homeDir, journalDir });
    installer.install(secondPlugin, ['claude'], undefined, undefined, 'full', { homeDir, journalDir });

    installer.uninstall(firstPlugin, ['claude'], undefined, undefined, {
      homeDir,
      journalDir,
      ownershipManifest: first.ownershipManifest,
    });

    const settings = readFileSync(path.join(homeDir, '.claude', 'settings.json'), 'utf8');
    expect(settings).not.toContain('echo foo"');
    expect(settings).toContain('echo foo-bar');
  });

  it('does not adopt a missing legacy hook as newly owned content', () => {
    const { homeDir, journalDir } = setup();
    const settingsPath = path.join(homeDir, '.claude', 'settings.json');
    mkdirSync(path.dirname(settingsPath), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify({ unrelated: { keep: true } }));
    const plugin: DetectedPlugin = {
      id: 'legacy-hook-plugin',
      name: 'Legacy Hook Plugin',
      skills: [],
      agents: [],
      hooks: [{ event: 'PostToolUse', command: 'echo marketplace', sourceFormat: 'claude' }],
      mcpServers: [],
      jsPlugins: [],
    };

    expect(() => new MarketplaceIntegrityInstaller().install(
      plugin,
      ['claude'],
      undefined,
      undefined,
      'full',
      { homeDir, journalDir, legacyRecord: true },
    )).toThrow('ARTIFACT_MODIFIED');
    expect(JSON.parse(readFileSync(settingsPath, 'utf8'))).toEqual({ unrelated: { keep: true } });
  });
});
