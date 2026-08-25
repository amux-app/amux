import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
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

  it('rejects symlinks anywhere in a native recursively copied tree', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'muxbase-native-preview-'));
    const outside = mkdtempSync(path.join(tmpdir(), 'muxbase-native-outside-'));
    writeFileSync(path.join(outside, 'secret.js'), 'secret');
    symlinkSync(outside, path.join(root, 'linked-directory'), 'dir');

    expect(() => new MarketplaceInstaller().preview(
      plugin,
      ['claude'],
      nativeConfig(root),
    )).toThrow('symlinks are not allowed');
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
