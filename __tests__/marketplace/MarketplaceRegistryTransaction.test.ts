import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MarketplaceRegistry } from '../../src/services/marketplace/MarketplaceRegistry.js';
import { digestPath, MarketplaceTransaction } from '../../src/services/marketplace/MarketplaceTransaction.js';

describe('MarketplaceRegistry transaction integration', () => {
  it('rolls back the registry mutation when a transaction fails after every replacement', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'aumx-marketplace-registry-transaction-'));
    const registryPath = path.join(root, 'registry.json');
    const artifactPath = path.join(root, 'artifact.txt');
    writeFileSync(registryPath, JSON.stringify({ version: 1, sources: [], installed: [] }, null, 2));
    writeFileSync(artifactPath, 'before');
    const registry = new MarketplaceRegistry(registryPath);
    const prepared = registry.prepareAddInstalled({
      pluginId: 'plugin-one',
      sourceUrl: 'https://example.test/marketplace.git',
      installedAt: '2026-08-20T00:00:00.000Z',
      agents: { claude: { status: 'full' } },
      ownershipManifest: { artifacts: [], transactionId: 'transaction', version: 1 },
    });

    expect(() => new MarketplaceTransaction({
      journalDir: path.join(root, 'journal'),
      failAfterApply: 2,
    }).execute([
      { content: Buffer.from('after'), expectedDigest: digestPath(artifactPath), kind: 'file', path: artifactPath },
      prepared.mutation,
    ])).toThrow('Injected marketplace transaction failure');

    expect(readFileSync(artifactPath, 'utf8')).toBe('before');
    expect(JSON.parse(readFileSync(registryPath, 'utf8'))).toEqual({ version: 1, sources: [], installed: [] });
    expect(registry.getInstalled('plugin-one', 'https://example.test/marketplace.git')).toBeUndefined();
    expect(existsSync(path.join(root, 'journal', 'transactions'))).toBe(true);
  });
});
