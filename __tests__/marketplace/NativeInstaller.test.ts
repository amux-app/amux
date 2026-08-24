import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
    cpSync: vi.fn(),
    rmSync: vi.fn(),
    readdirSync: vi.fn(() => []),
  };
});

import { existsSync, readFileSync, writeFileSync, cpSync, rmSync } from 'fs';
import { NativeInstaller } from '../../src/services/marketplace/NativeInstaller.js';

describe('NativeInstaller', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('claude', () => {
    it('registers marketplace and enables plugin in settings.json', () => {
      (existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true);
      (readFileSync as ReturnType<typeof vi.fn>).mockReturnValue(
        JSON.stringify({ env: { SOME: 'val' }, enabledPlugins: {} })
      );

      const installer = new NativeInstaller();
      installer.install({
        marketplaceUrl: 'https://github.com/org/my-marketplace.git',
        marketplaceName: 'my-marketplace',
        pluginId: 'my-plugin',
      }, 'claude');

      const written = (writeFileSync as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
      const parsed = JSON.parse(written);
      expect(parsed.env.SOME).toBe('val');
      expect(parsed.extraKnownMarketplaces['my-marketplace']).toEqual({
        source: { source: 'git', url: 'https://github.com/org/my-marketplace.git' },
        autoUpdate: true,
      });
      expect(parsed.enabledPlugins['my-plugin@my-marketplace']).toBe(true);
    });

    it('seeds marketplace clone and plugin cache when clonePath provided', () => {
      (existsSync as ReturnType<typeof vi.fn>).mockImplementation((p: string) => {
        if (typeof p === 'string' && p.includes('settings.json')) return true;
        if (typeof p === 'string' && p.includes('marketplace.json')) return true;
        if (typeof p === 'string' && p.endsWith('/tmp/clones/my-marketplace/plugins/my-plugin')) return true;
        return false;
      });
      (readFileSync as ReturnType<typeof vi.fn>).mockImplementation((p: string) => {
        if (typeof p === 'string' && p.includes('settings.json')) {
          return JSON.stringify({ enabledPlugins: {} });
        }
        if (typeof p === 'string' && p.includes('marketplace.json')) {
          return JSON.stringify({
            plugins: [{ name: 'my-plugin', source: './plugins/my-plugin', version: '2.0.0' }],
          });
        }
        if (typeof p === 'string' && p.includes('installed_plugins.json')) {
          return JSON.stringify({ version: 2, plugins: {} });
        }
        if (typeof p === 'string' && p.includes('known_marketplaces.json')) {
          return JSON.stringify({});
        }
        return '{}';
      });

      const installer = new NativeInstaller();
      installer.install({
        marketplaceUrl: 'https://github.com/org/my-marketplace.git',
        marketplaceName: 'my-marketplace',
        pluginId: 'my-plugin',
        clonePath: '/tmp/clones/my-marketplace',
        pluginVersion: '2.0.0',
      }, 'claude');

      // Should seed marketplace clone
      expect(cpSync).toHaveBeenCalledWith(
        '/tmp/clones/my-marketplace',
        expect.stringContaining('marketplaces/my-marketplace'),
        { recursive: true },
      );

      // Should seed plugin cache
      expect(cpSync).toHaveBeenCalledWith(
        '/tmp/clones/my-marketplace/plugins/my-plugin',
        expect.stringContaining('cache/my-marketplace/my-plugin/2.0.0'),
        { recursive: true },
      );

      // Should write installed_plugins.json
      const installedCalls = (writeFileSync as ReturnType<typeof vi.fn>).mock.calls.filter(
        (c) => (c[0] as string).includes('installed_plugins.json'),
      );
      expect(installedCalls.length).toBeGreaterThan(0);
      const installedData = JSON.parse(installedCalls[0][1] as string);
      expect(installedData.plugins['my-plugin@my-marketplace']).toBeDefined();
      expect(installedData.plugins['my-plugin@my-marketplace'][0].version).toBe('2.0.0');

      // Should write known_marketplaces.json
      const knownCalls = (writeFileSync as ReturnType<typeof vi.fn>).mock.calls.filter(
        (c) => (c[0] as string).includes('known_marketplaces.json'),
      );
      expect(knownCalls.length).toBeGreaterThan(0);
    });

    it('uninstalls by removing from enabledPlugins and extraKnownMarketplaces', () => {
      (existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true);
      (readFileSync as ReturnType<typeof vi.fn>).mockImplementation((p: string) => {
        if (typeof p === 'string' && p.includes('settings.json')) {
          return JSON.stringify({
            enabledPlugins: { 'pluginA@community-pack': true, 'other@mp': true },
            extraKnownMarketplaces: { 'community-pack': { source: {} }, 'other-mp': { source: {} } },
          });
        }
        if (typeof p === 'string' && p.includes('installed_plugins.json')) {
          return JSON.stringify({ version: 2, plugins: { 'pluginA@community-pack': [{ installPath: '/some/path' }] } });
        }
        if (typeof p === 'string' && p.includes('known_marketplaces.json')) {
          return JSON.stringify({ 'community-pack': { source: {} } });
        }
        return '{}';
      });

      const installer = new NativeInstaller();
      installer.uninstall({
        marketplaceUrl: 'https://example.com/repo.git',
        marketplaceName: 'community-pack',
        pluginId: 'pluginA',
        // Treat as last plugin so legacy marketplace-level cleanup still runs.
        isLastPluginFromMarketplace: true,
      }, 'claude');

      // Check settings.json was written correctly
      const settingsCalls = (writeFileSync as ReturnType<typeof vi.fn>).mock.calls.filter(
        (c) => (c[0] as string).includes('settings.json'),
      );
      expect(settingsCalls.length).toBeGreaterThan(0);
      const parsed = JSON.parse(settingsCalls[0][1] as string);
      expect(parsed.enabledPlugins['pluginA@community-pack']).toBeUndefined();
      expect(parsed.enabledPlugins['other@mp']).toBe(true);
      expect(parsed.extraKnownMarketplaces['community-pack']).toBeUndefined();
      expect(parsed.extraKnownMarketplaces['other-mp']).toBeDefined();

      // Check installed_plugins.json was updated
      const installedCalls = (writeFileSync as ReturnType<typeof vi.fn>).mock.calls.filter(
        (c) => (c[0] as string).includes('installed_plugins.json'),
      );
      expect(installedCalls.length).toBeGreaterThan(0);
      const installedData = JSON.parse(installedCalls[0][1] as string);
      expect(installedData.plugins['pluginA@community-pack']).toBeUndefined();
    });

    it('skips manifest entries whose source escapes the clone, falling through to the next match', () => {
      // A malicious or buggy marketplace.json can list the same plugin twice — first with an
      // unsafe `../../...` source, then with a safe one. FormatDetector already skips the unsafe
      // entry via safeResolveUnder; NativeInstaller must do the same when seeding the cache.
      (existsSync as ReturnType<typeof vi.fn>).mockImplementation((p: string) => {
        if (typeof p === 'string' && p.includes('settings.json')) return true;
        if (typeof p === 'string' && p.endsWith('marketplace.json')) return true;
        if (typeof p === 'string' && p.endsWith('/tmp/clones/my-marketplace/plugins/my-plugin')) return true;
        return false;
      });
      (readFileSync as ReturnType<typeof vi.fn>).mockImplementation((p: string) => {
        if (typeof p === 'string' && p.includes('settings.json')) {
          return JSON.stringify({ enabledPlugins: {} });
        }
        if (typeof p === 'string' && p.endsWith('marketplace.json')) {
          return JSON.stringify({
            plugins: [
              { name: 'my-plugin', source: '../../../etc' },
              { name: 'my-plugin', source: './plugins/my-plugin' },
            ],
          });
        }
        return '{}';
      });

      const installer = new NativeInstaller();
      installer.install({
        marketplaceUrl: 'https://github.com/org/my-marketplace.git',
        marketplaceName: 'my-marketplace',
        pluginId: 'my-plugin',
        clonePath: '/tmp/clones/my-marketplace',
        pluginVersion: '1.0.0',
      }, 'claude');

      const cacheCpCalls = (cpSync as ReturnType<typeof vi.fn>).mock.calls.filter(
        (c) => typeof c[1] === 'string' && (c[1] as string).includes('cache/my-marketplace/my-plugin'),
      );
      expect(cacheCpCalls.length).toBe(1);
      const [src] = cacheCpCalls[0] as [string, string];
      // Must not have copied the unsafe (escapes-clone) source
      expect(src.startsWith('/tmp/clones/my-marketplace/')).toBe(true);
      expect(src).toBe('/tmp/clones/my-marketplace/plugins/my-plugin');
    });

    it('keeps marketplace registration when sibling plugins remain (isLastPluginFromMarketplace unset)', () => {
      (existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true);
      (readFileSync as ReturnType<typeof vi.fn>).mockImplementation((p: string) => {
        if (typeof p === 'string' && p.includes('settings.json')) {
          return JSON.stringify({
            enabledPlugins: { 'a@mp': true, 'b@mp': true },
            extraKnownMarketplaces: { mp: { source: {} } },
          });
        }
        if (typeof p === 'string' && p.includes('installed_plugins.json')) {
          return JSON.stringify({ version: 2, plugins: { 'a@mp': [{ installPath: '/p' }], 'b@mp': [{ installPath: '/q' }] } });
        }
        if (typeof p === 'string' && p.includes('known_marketplaces.json')) {
          return JSON.stringify({ mp: { source: {} } });
        }
        return '{}';
      });

      const installer = new NativeInstaller();
      installer.uninstall({
        marketplaceUrl: 'https://example.com/repo.git',
        marketplaceName: 'mp',
        pluginId: 'a',
        // No isLastPluginFromMarketplace → default-safe: leave marketplace registration alone
      }, 'claude');

      // settings.json: per-plugin entry gone, sibling and marketplace registration retained
      const settingsCalls = (writeFileSync as ReturnType<typeof vi.fn>).mock.calls.filter(
        (c) => (c[0] as string).includes('settings.json'),
      );
      const parsed = JSON.parse(settingsCalls[0][1] as string);
      expect(parsed.enabledPlugins['a@mp']).toBeUndefined();
      expect(parsed.enabledPlugins['b@mp']).toBe(true);
      expect(parsed.extraKnownMarketplaces.mp).toBeDefined();

      // known_marketplaces.json: mp entry retained
      const knownCalls = (writeFileSync as ReturnType<typeof vi.fn>).mock.calls.filter(
        (c) => (c[0] as string).includes('known_marketplaces.json'),
      );
      if (knownCalls.length > 0) {
        const knownData = JSON.parse(knownCalls[knownCalls.length - 1][1] as string);
        expect(knownData.mp).toBeDefined();
      }

      // installed_plugins.json: a removed, b retained
      const installedCalls = (writeFileSync as ReturnType<typeof vi.fn>).mock.calls.filter(
        (c) => (c[0] as string).includes('installed_plugins.json'),
      );
      const installedData = JSON.parse(installedCalls[0][1] as string);
      expect(installedData.plugins['a@mp']).toBeUndefined();
      expect(installedData.plugins['b@mp']).toBeDefined();

      // No rmSync against the marketplace clone
      const rmTargets = (rmSync as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0] as string);
      expect(rmTargets.some((t) => t.includes('plugins/marketplaces/mp'))).toBe(false);

      // Per-plugin cache dir IS removed
      expect(rmTargets.some((t) => t.includes('cache/mp/a'))).toBe(true);
    });

    it('removes marketplace registration when it is the last plugin from the marketplace', () => {
      (existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true);
      (readFileSync as ReturnType<typeof vi.fn>).mockImplementation((p: string) => {
        if (typeof p === 'string' && p.includes('settings.json')) {
          return JSON.stringify({
            enabledPlugins: { 'a@mp': true },
            extraKnownMarketplaces: { mp: { source: {} } },
          });
        }
        if (typeof p === 'string' && p.includes('installed_plugins.json')) {
          return JSON.stringify({ version: 2, plugins: { 'a@mp': [{ installPath: '/p' }] } });
        }
        if (typeof p === 'string' && p.includes('known_marketplaces.json')) {
          return JSON.stringify({ mp: { source: {} } });
        }
        return '{}';
      });

      const installer = new NativeInstaller();
      installer.uninstall({
        marketplaceUrl: 'https://example.com/repo.git',
        marketplaceName: 'mp',
        pluginId: 'a',
        isLastPluginFromMarketplace: true,
      }, 'claude');

      const settingsCalls = (writeFileSync as ReturnType<typeof vi.fn>).mock.calls.filter(
        (c) => (c[0] as string).includes('settings.json'),
      );
      const parsed = JSON.parse(settingsCalls[0][1] as string);
      expect(parsed.extraKnownMarketplaces.mp).toBeUndefined();

      const knownCalls = (writeFileSync as ReturnType<typeof vi.fn>).mock.calls.filter(
        (c) => (c[0] as string).includes('known_marketplaces.json'),
      );
      const knownData = JSON.parse(knownCalls[knownCalls.length - 1][1] as string);
      expect(knownData.mp).toBeUndefined();

      const rmTargets = (rmSync as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0] as string);
      expect(rmTargets.some((t) => t.includes('plugins/marketplaces/mp'))).toBe(true);
    });
  });

  describe('codex', () => {
    it('writes marketplace and plugin TOML sections', () => {
      (existsSync as ReturnType<typeof vi.fn>).mockImplementation((p: string) => {
        if (typeof p === 'string' && p.includes('config.toml')) return true;
        return false;
      });
      (readFileSync as ReturnType<typeof vi.fn>).mockReturnValue(
        'model = "gpt-4"\n'
      );

      const installer = new NativeInstaller();
      installer.install({
        marketplaceUrl: 'https://github.com/org/my-marketplace.git',
        marketplaceName: 'my-marketplace',
        pluginId: 'my-plugin',
      }, 'codex');

      const written = (writeFileSync as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
      expect(written).toContain('[marketplaces.my-marketplace]');
      expect(written).toContain('source_type = "git"');
      expect(written).toContain('source = "https://github.com/org/my-marketplace.git"');
      expect(written).toContain('[plugins."my-plugin@my-marketplace"]');
      expect(written).toContain('enabled = true');
      expect(written).toContain('model = "gpt-4"');
    });

    it('does not duplicate sections if already present', () => {
      (existsSync as ReturnType<typeof vi.fn>).mockImplementation((p: string) => {
        if (typeof p === 'string' && p.includes('config.toml')) return true;
        return false;
      });
      (readFileSync as ReturnType<typeof vi.fn>).mockReturnValue(
        '[marketplaces.my-marketplace]\nsource_type = "git"\nsource = "https://github.com/org/my-marketplace.git"\n\n[plugins."my-plugin@my-marketplace"]\nenabled = true\n'
      );

      const installer = new NativeInstaller();
      installer.install({
        marketplaceUrl: 'https://github.com/org/my-marketplace.git',
        marketplaceName: 'my-marketplace',
        pluginId: 'my-plugin',
      }, 'codex');

      const written = (writeFileSync as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
      const marketplaceMatches = written.match(/\[marketplaces\.my-marketplace\]/g);
      expect(marketplaceMatches).toHaveLength(1);
    });

    it('uninstalls by removing plugin and marketplace sections', () => {
      (existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true);
      (readFileSync as ReturnType<typeof vi.fn>).mockReturnValue(
        'model = "gpt-4"\n\n[marketplaces.my-mp]\nsource_type = "git"\nsource = "https://example.com"\n\n[plugins."my-plugin@my-mp"]\nenabled = true\n\n[other.section]\nkey = "val"\n'
      );

      const installer = new NativeInstaller();
      installer.uninstall({
        marketplaceUrl: 'https://example.com',
        marketplaceName: 'my-mp',
        pluginId: 'my-plugin',
        isLastPluginFromMarketplace: true,
      }, 'codex');

      const written = (writeFileSync as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
      expect(written).not.toContain('[plugins."my-plugin@my-mp"]');
      expect(written).not.toContain('[marketplaces.my-mp]');
      expect(written).toContain('model = "gpt-4"');
      expect(written).toContain('[other.section]');
    });

    it('leaves [marketplaces.<name>] intact when sibling plugins remain', () => {
      (existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true);
      (readFileSync as ReturnType<typeof vi.fn>).mockReturnValue(
        '[marketplaces.mp]\nsource_type = "git"\nsource = "https://example.com"\n\n[plugins."a@mp"]\nenabled = true\n\n[plugins."b@mp"]\nenabled = true\n'
      );

      const installer = new NativeInstaller();
      installer.uninstall({
        marketplaceUrl: 'https://example.com',
        marketplaceName: 'mp',
        pluginId: 'a',
        // No isLastPluginFromMarketplace → marketplace section must survive
      }, 'codex');

      const written = (writeFileSync as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
      expect(written).not.toContain('[plugins."a@mp"]');
      expect(written).toContain('[plugins."b@mp"]');
      expect(written).toContain('[marketplaces.mp]');
    });
  });

  describe('supportsNative', () => {
    it('returns true for claude with claude-marketplace format', () => {
      const installer = new NativeInstaller();
      expect(installer.supportsNative('claude')).toBe(true);
      expect(installer.supportsNative('claude', 'claude-marketplace')).toBe(true);
    });

    it('returns true for codex with codex-plugin format', () => {
      const installer = new NativeInstaller();
      expect(installer.supportsNative('codex')).toBe(true);
      expect(installer.supportsNative('codex', 'codex-plugin')).toBe(true);
    });

    it('returns false for claude with incompatible format', () => {
      const installer = new NativeInstaller();
      expect(installer.supportsNative('claude', 'opencode-plugins')).toBe(false);
      expect(installer.supportsNative('claude', 'codex-plugin')).toBe(false);
    });

    it('returns false for codex with incompatible format', () => {
      const installer = new NativeInstaller();
      expect(installer.supportsNative('codex', 'opencode-plugins')).toBe(false);
      expect(installer.supportsNative('codex', 'claude-marketplace')).toBe(false);
    });

    it('returns false for opencode', () => {
      const installer = new NativeInstaller();
      expect(installer.supportsNative('opencode')).toBe(false);
    });
  });
});
