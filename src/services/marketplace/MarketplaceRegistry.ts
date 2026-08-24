import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import path from 'path';
import logService from '../LogService.js';
import type { MarketplaceMutation } from './MarketplaceTransaction.js';
import type { InstalledPlugin, MarketplaceRegistryData, MarketplaceSource } from './types.js';

const EMPTY_REGISTRY: MarketplaceRegistryData = { version: 1, sources: [], installed: [] };

export interface PreparedMarketplaceRegistryMutation {
  mutation: MarketplaceMutation;
  applyInMemory(): void;
}

function isDigest(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value);
}

function isValidOwnershipScope(value: unknown): boolean {
  return value === undefined || value === 'plugin' || value === 'source';
}

function isValidOwnershipManifest(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const manifest = value as Record<string, unknown>;
  if (manifest.version !== 1 || typeof manifest.transactionId !== 'string' || !Array.isArray(manifest.artifacts)) {
    return false;
  }
  return manifest.artifacts.every((entry) => {
    if (typeof entry !== 'object' || entry === null) return false;
    const artifact = entry as Record<string, unknown>;
    if (
      typeof artifact.agent !== 'string'
      || typeof artifact.path !== 'string'
      || !isDigest(artifact.installedDigest)
      || !isValidOwnershipScope(artifact.scope)
    ) {
      return false;
    }
    if (artifact.type === 'file' || artifact.type === 'directory') return true;
    return artifact.type === 'config-entry' && typeof artifact.selector === 'string';
  });
}

function isValidRegistryData(value: unknown): value is MarketplaceRegistryData {
  if (typeof value !== 'object' || value === null) return false;
  const data = value as Record<string, unknown>;
  if (!(
    typeof data.version === 'number' &&
    Array.isArray(data.sources) &&
    Array.isArray(data.installed)
  )) return false;
  return data.installed.every((installed) => (
    typeof installed === 'object'
    && installed !== null
    && (!Object.hasOwn(installed, 'ownershipManifest')
      || isValidOwnershipManifest((installed as Record<string, unknown>).ownershipManifest))
  ));
}

export class MarketplaceRegistry {
  private data: MarketplaceRegistryData;
  private readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
    this.data = this.load();
  }

  getData(): MarketplaceRegistryData {
    return this.data;
  }

  addSource(source: MarketplaceSource): void {
    this.mutate(() => {
      const existing = this.data.sources.find((s) => s.url === source.url);
      if (existing) return;
      this.data.sources.push(source);
    });
  }

  removeSource(url: string): void {
    this.mutate(() => {
      this.data.sources = this.data.sources.filter((s) => s.url !== url);
      this.data.installed = this.data.installed.filter((i) => i.sourceUrl !== url);
    });
  }

  updateSource(url: string, updates: Partial<MarketplaceSource>): void {
    this.mutate(() => {
      const source = this.data.sources.find((s) => s.url === url);
      if (!source) return;
      Object.assign(source, updates);
    });
  }

  addInstalled(plugin: InstalledPlugin): void {
    this.mutate(() => {
      const existing = this.data.installed.findIndex(
        (i) => i.pluginId === plugin.pluginId && i.sourceUrl === plugin.sourceUrl,
      );
      if (existing >= 0) {
        this.data.installed[existing] = plugin;
      } else {
        this.data.installed.push(plugin);
      }
    });
  }

  prepareAddInstalled(plugin: InstalledPlugin): PreparedMarketplaceRegistryMutation {
    const next = structuredClone(this.data);
    const existing = next.installed.findIndex(
      (installed) => installed.pluginId === plugin.pluginId && installed.sourceUrl === plugin.sourceUrl,
    );
    if (existing >= 0) next.installed[existing] = plugin;
    else next.installed.push(plugin);
    return this.prepareMutation(next);
  }

  removeInstalled(pluginId: string, sourceUrl: string): void {
    this.mutate(() => {
      this.data.installed = this.data.installed.filter(
        (i) => !(i.pluginId === pluginId && i.sourceUrl === sourceUrl),
      );
    });
  }

  prepareRemoveInstalled(pluginId: string, sourceUrl: string): PreparedMarketplaceRegistryMutation {
    const next = structuredClone(this.data);
    next.installed = next.installed.filter(
      (installed) => !(installed.pluginId === pluginId && installed.sourceUrl === sourceUrl),
    );
    return this.prepareMutation(next);
  }

  getInstalled(pluginId: string, sourceUrl: string): InstalledPlugin | undefined {
    return this.data.installed.find(
      (i) => i.pluginId === pluginId && i.sourceUrl === sourceUrl,
    );
  }

  private load(): MarketplaceRegistryData {
    if (!existsSync(this.filePath)) return { ...EMPTY_REGISTRY };
    let raw: string;
    try {
      raw = readFileSync(this.filePath, 'utf-8');
    } catch (error) {
      logService.error('Failed to read marketplace registry', 'marketplace', undefined, error);
      return { ...EMPTY_REGISTRY };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      this.quarantineCorruptFile(error);
      return { ...EMPTY_REGISTRY };
    }

    if (!isValidRegistryData(parsed)) {
      this.quarantineCorruptFile(new Error('Registry file has an unexpected shape'));
      return { ...EMPTY_REGISTRY };
    }
    return parsed;
  }

  private quarantineCorruptFile(error: unknown): void {
    const backupPath = `${this.filePath}.corrupt`;
    try {
      renameSync(this.filePath, backupPath);
      logService.error(
        `Marketplace registry was corrupt; backed up to ${backupPath}. Installed plugins may need re-adding.`,
        'marketplace',
        undefined,
        error,
      );
    } catch (renameError) {
      logService.error('Failed to back up corrupt marketplace registry', 'marketplace', undefined, renameError);
    }
  }

  private save(): void {
    const dir = path.dirname(this.filePath);
    mkdirSync(dir, { recursive: true });
    // Write to temp file then atomically rename to prevent corruption on crash
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf-8');
    renameSync(tmp, this.filePath);
  }

  private mutate(operation: () => void): void {
    const previous = structuredClone(this.data);
    try {
      operation();
      this.save();
    } catch (error) {
      this.data = previous;
      throw error;
    }
  }

  private prepareMutation(next: MarketplaceRegistryData): PreparedMarketplaceRegistryMutation {
    const current = existsSync(this.filePath) ? readFileSync(this.filePath) : null;
    return {
      mutation: {
        content: Buffer.from(JSON.stringify(next, null, 2)),
        expectedDigest: current === null ? null : createHash('sha256').update(current).digest('hex'),
        kind: 'file',
        path: this.filePath,
      },
      applyInMemory: () => { this.data = next; },
    };
  }
}
