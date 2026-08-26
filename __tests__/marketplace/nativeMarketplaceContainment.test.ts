import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MarketplaceInstaller } from '../../src/services/marketplace/MarketplaceInstaller.js';
import { NativeInstaller } from '../../src/services/marketplace/NativeInstaller.js';
import type { DetectedPlugin } from '../../src/services/marketplace/types.js';

const plugin: DetectedPlugin = {
  agents: [],
  hooks: [],
  id: 'native-plugin',
  jsPlugins: [],
  mcpServers: [],
  name: 'Native plugin',
  skills: [],
};

function nativeConfig(clonePath: string) {
  return {
    clonePath,
    marketplaceName: 'native-marketplace',
    marketplaceUrl: 'https://example.test/native.git',
    pluginId: 'native-plugin',
    sourceFormat: 'claude-marketplace',
  } as const;
}

describe('native marketplace preview containment', () => {
  it('includes every recursively copied native tree in the preview graph', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'muxbase-native-preview-'));
    mkdirSync(path.join(root, 'nested'), { recursive: true });
    writeFileSync(path.join(root, 'nested', 'plugin.js'), 'console.log("native");\n');

    const preview = new MarketplaceInstaller().preview(
      plugin,
      ['claude'],
      nativeConfig(root),
      undefined,
      { headSha: 'head-1', sourceUrl: 'https://example.test/native.git' },
    );
    const nativeArtifact = preview.agents[0]?.artifacts.find((artifact) => artifact.name === 'native:marketplace clone');

    expect(nativeArtifact).toMatchObject({
      destinationPaths: [expect.stringContaining('.claude/plugins/marketplaces/native-marketplace')],
      sourcePaths: [root],
    });
    expect(nativeArtifact?.contentHashes).toEqual(expect.arrayContaining([
      expect.stringContaining('directory:.'),
      expect.stringContaining('file:nested/plugin.js:'),
    ]));
  });

  it('materializes safe relative symlinks that stay inside a native tree', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'muxbase-native-preview-'));
    writeFileSync(path.join(root, 'AGENTS.md'), '# Shared instructions\n');
    symlinkSync('AGENTS.md', path.join(root, 'CLAUDE.md'));

    const preview = new MarketplaceInstaller().preview(
      plugin,
      ['claude'],
      nativeConfig(root),
    );
    const nativeArtifact = preview.agents[0]?.artifacts.find((artifact) => artifact.name === 'native:marketplace clone');
    const agentsHash = nativeArtifact?.contentHashes.find((entry) => entry.startsWith('file:AGENTS.md:'))?.split(':').at(-1);
    const claudeHash = nativeArtifact?.contentHashes.find((entry) => entry.startsWith('file:CLAUDE.md:'))?.split(':').at(-1);

    expect(agentsHash).toMatch(/^[a-f0-9]{64}$/);
    expect(claudeHash).toBe(agentsHash);
  });

  it('rejects symlinks that escape a native recursively copied tree', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'muxbase-native-preview-'));
    const outside = mkdtempSync(path.join(tmpdir(), 'muxbase-native-outside-'));
    writeFileSync(path.join(outside, 'secret.js'), 'secret');
    symlinkSync(path.relative(root, outside), path.join(root, 'linked-directory'), 'dir');

    try {
      new MarketplaceInstaller().preview(plugin, ['claude'], nativeConfig(root));
      throw new Error('Expected preview to reject the escaping symlink');
    } catch (error) {
      expect(error).toMatchObject({
        artifactPath: path.join(root, 'linked-directory'),
        code: 'INVALID_SOURCE_TREE',
        message: expect.stringContaining('escapes source tree'),
      });
    }
  });

  it('keeps selected-all preview scoped to selected artifacts while full preview validates the native tree', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'muxbase-native-preview-'));
    const outside = mkdtempSync(path.join(tmpdir(), 'muxbase-native-outside-'));
    const skillDir = path.join(root, 'skills', 'safe-skill');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(path.join(skillDir, 'SKILL.md'), '# Safe skill\n');
    writeFileSync(path.join(outside, 'secret.js'), 'secret');
    symlinkSync(path.relative(root, outside), path.join(root, 'unrelated-link'), 'dir');

    const selectedPlugin: DetectedPlugin = {
      ...plugin,
      skills: [{ name: 'safe-skill', path: path.join(skillDir, 'SKILL.md') }],
    };
    const config = nativeConfig(root);

    const selectedPreview = new MarketplaceInstaller().preview(
      selectedPlugin,
      ['claude'],
      config,
      { skills: ['safe-skill'], mcpServers: [], agents: [] },
      { headSha: 'head-1', sourceUrl: config.marketplaceUrl },
      'selected',
    );
    expect(selectedPreview.mode).toBe('selected');
    expect(selectedPreview.agents[0]?.artifacts.some((artifact) => artifact.name.startsWith('native:'))).toBe(false);

    expect(() => new MarketplaceInstaller().preview(
      selectedPlugin,
      ['claude'],
      config,
      undefined,
      { headSha: 'head-1', sourceUrl: config.marketplaceUrl },
      'full',
    )).toThrow(expect.objectContaining({
      artifactPath: path.join(root, 'unrelated-link'),
      code: 'INVALID_SOURCE_TREE',
    }));
  });

  it('cleans a partially materialized native tree when a later symlink escapes', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'muxbase-native-preview-'));
    const outside = mkdtempSync(path.join(tmpdir(), 'muxbase-native-outside-'));
    const home = mkdtempSync(path.join(tmpdir(), 'muxbase-native-home-'));
    writeFileSync(path.join(root, 'safe.js'), 'safe');
    writeFileSync(path.join(outside, 'secret.js'), 'secret');
    symlinkSync(path.relative(root, outside), path.join(root, 'z-linked-directory'), 'dir');

    expect(() => new NativeInstaller().install(nativeConfig(root), 'claude', home)).toThrow('escapes source tree');
    expect(existsSync(path.join(home, '.claude', 'plugins', 'marketplaces', 'native-marketplace'))).toBe(false);
    expect(existsSync(path.join(home, '.claude', 'settings.json'))).toBe(false);
  });

  it('rejects absolute symlink targets in a native recursively copied tree', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'muxbase-native-preview-'));
    const target = path.join(root, 'target.js');
    writeFileSync(target, 'safe');
    symlinkSync(target, path.join(root, 'absolute-link.js'));

    expect(() => new MarketplaceInstaller().preview(
      plugin,
      ['claude'],
      nativeConfig(root),
    )).toThrow('absolute symlink target');
  });

  it('rejects broken symlinks in a native recursively copied tree', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'muxbase-native-preview-'));
    symlinkSync('missing.js', path.join(root, 'broken-link.js'));

    expect(() => new MarketplaceInstaller().preview(
      plugin,
      ['claude'],
      nativeConfig(root),
    )).toThrow('broken or cyclic symlink');
  });

  it('rejects cyclic symlinks in a native recursively copied tree', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'muxbase-native-preview-'));
    symlinkSync('.', path.join(root, 'cycle'), 'dir');

    expect(() => new MarketplaceInstaller().preview(
      plugin,
      ['claude'],
      nativeConfig(root),
    )).toThrow('symlink cycle');
  });

  it('reports the plugin cache tree when the native marketplace manifest selects it', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'muxbase-native-preview-'));
    mkdirSync(path.join(root, '.claude-plugin'), { recursive: true });
    mkdirSync(path.join(root, 'plugins', 'native-plugin'), { recursive: true });
    writeFileSync(
      path.join(root, '.claude-plugin', 'marketplace.json'),
      JSON.stringify({ plugins: [{ name: 'native-plugin', source: './plugins/native-plugin' }] }),
    );
    writeFileSync(path.join(root, 'plugins', 'native-plugin', 'plugin.js'), 'native');

    const operations = new NativeInstaller().getNativeCopyOperations(nativeConfig(root), 'claude');

    expect(operations.map((operation) => operation.name)).toEqual(['marketplace clone', 'plugin cache']);
    expect(operations[1]?.sourcePath).toBe(path.join(root, 'plugins', 'native-plugin'));
  });

  it('represents Codex native configuration in a full-install preview', () => {
    const preview = new MarketplaceInstaller().preview(
      plugin,
      ['codex'],
      {
        marketplaceName: 'codex-marketplace',
        marketplaceUrl: 'https://example.test/codex.git',
        pluginId: plugin.id,
        sourceFormat: 'codex-plugin',
      },
      undefined,
      { headSha: 'head-1', sourceUrl: 'https://example.test/codex.git' },
      'full',
    );

    expect(preview.mode).toBe('full');
    expect(preview.generatedFiles).toContain(path.join(homedir(), '.codex', 'config.toml'));
    expect(preview.introducesExecutableBehavior).toBe(true);
  });
});
