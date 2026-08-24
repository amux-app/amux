import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    renameSync: vi.fn(),
    mkdirSync: vi.fn(),
  };
});

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { MarketplaceRegistry } from '../../src/services/marketplace/MarketplaceRegistry.js';
import type { MarketplaceRegistryData } from '../../src/services/marketplace/types.js';

describe('MarketplaceRegistry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns empty data when file does not exist', () => {
    (existsSync as ReturnType<typeof vi.fn>).mockReturnValue(false);
    const registry = new MarketplaceRegistry('/tmp/test-registry.json');
    const data = registry.getData();
    expect(data.sources).toEqual([]);
    expect(data.installed).toEqual([]);
  });

  it('loads existing data from file', () => {
    const existing: MarketplaceRegistryData = {
      version: 1,
      sources: [{
        url: 'https://github.com/example/repo.git',
        name: 'repo',
        clonePath: '/tmp/clones/repo',
        detectedFormat: 'raw-skills',
        headSha: null,
        lastUpdated: null,
      }],
      installed: [],
    };
    (existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (readFileSync as ReturnType<typeof vi.fn>).mockReturnValue(JSON.stringify(existing));

    const registry = new MarketplaceRegistry('/tmp/test-registry.json');
    expect(registry.getData().sources).toHaveLength(1);
    expect(registry.getData().sources[0].url).toBe('https://github.com/example/repo.git');
  });

  it('preserves a valid additive ownership manifest', () => {
    const existing: MarketplaceRegistryData = {
      version: 1,
      sources: [],
      installed: [{
        pluginId: 'plugin',
        sourceUrl: 'https://example.test/plugin.git',
        installedAt: '2026-01-01T00:00:00.000Z',
        agents: {},
        ownershipManifest: {
          version: 1,
          transactionId: 'transaction',
          artifacts: [{
            agent: 'claude',
            installedDigest: 'a'.repeat(64),
            path: '/tmp/skill',
            type: 'directory',
          }],
        },
      }],
    };
    (existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (readFileSync as ReturnType<typeof vi.fn>).mockReturnValue(JSON.stringify(existing));

    const registry = new MarketplaceRegistry('/tmp/test-registry.json');

    expect(registry.getData().installed[0].ownershipManifest?.artifacts).toHaveLength(1);
  });

  it('rejects malformed ownership data instead of treating it as verified', () => {
    const malformed = {
      version: 1,
      sources: [],
      installed: [{
        pluginId: 'plugin',
        sourceUrl: 'https://example.test/plugin.git',
        installedAt: '2026-01-01T00:00:00.000Z',
        agents: {},
        ownershipManifest: { version: 1, transactionId: 'transaction', artifacts: [{ path: '/tmp/skill' }] },
      }],
    };
    (existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (readFileSync as ReturnType<typeof vi.fn>).mockReturnValue(JSON.stringify(malformed));

    const registry = new MarketplaceRegistry('/tmp/test-registry.json');

    expect(registry.getData()).toEqual({ version: 1, sources: [], installed: [] });
  });

  it('rejects an ownership manifest with an invalid artifact scope', () => {
    const malformed = {
      version: 1,
      sources: [],
      installed: [{
        pluginId: 'plugin',
        sourceUrl: 'https://example.test/plugin.git',
        installedAt: '2026-01-01T00:00:00.000Z',
        agents: {},
        ownershipManifest: {
          version: 1,
          transactionId: 'transaction',
          artifacts: [{
            agent: 'claude',
            installedDigest: 'a'.repeat(64),
            path: '/tmp/skill',
            scope: 'all-plugins',
            type: 'directory',
          }],
        },
      }],
    };
    (existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (readFileSync as ReturnType<typeof vi.fn>).mockReturnValue(JSON.stringify(malformed));

    expect(new MarketplaceRegistry('/tmp/test-registry.json').getData())
      .toEqual({ version: 1, sources: [], installed: [] });
  });

  it('addSource persists to disk', () => {
    (existsSync as ReturnType<typeof vi.fn>).mockReturnValue(false);
    const registry = new MarketplaceRegistry('/tmp/test-registry.json');

    registry.addSource({
      url: 'https://github.com/test/skills.git',
      name: 'skills',
      clonePath: '/tmp/clones/skills',
      detectedFormat: null,
      headSha: null,
      lastUpdated: null,
    });

    expect(writeFileSync).toHaveBeenCalled();
    expect(registry.getData().sources).toHaveLength(1);
  });

  it('removeSource removes by URL', () => {
    const existing: MarketplaceRegistryData = {
      version: 1,
      sources: [{
        url: 'https://github.com/example/repo.git',
        name: 'repo',
        clonePath: '/tmp/clones/repo',
        detectedFormat: 'raw-skills',
        headSha: null,
        lastUpdated: null,
      }],
      installed: [],
    };
    (existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (readFileSync as ReturnType<typeof vi.fn>).mockReturnValue(JSON.stringify(existing));

    const registry = new MarketplaceRegistry('/tmp/test-registry.json');
    registry.removeSource('https://github.com/example/repo.git');
    expect(registry.getData().sources).toHaveLength(0);
  });
});
