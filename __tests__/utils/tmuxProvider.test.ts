import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { delimiter, join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveTmuxProvider, type TmuxProviderDeps } from '../../src/utils/tmuxProvider.js';

const MIN = '3.7b';
const roots: string[] = [];

function makeBinDir(binaries: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'tmux-provider-'));
  roots.push(dir);
  const binDir = join(dir, 'bin');
  mkdirSync(binDir, { recursive: true });
  for (const name of binaries) {
    const path = join(binDir, name);
    writeFileSync(path, '#!/bin/sh\n');
    chmodSync(path, 0o755);
  }
  return binDir;
}

function deps(versions: Record<string, string>, brewPrefix?: string): TmuxProviderDeps {
  return {
    probeVersion: async (binPath) => versions[binPath] ?? null,
    resolveBrewPrefix: async () => brewPrefix ?? null,
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe('resolveTmuxProvider', () => {
  it('keeps a supported tmux already first on PATH', async () => {
    // Arrange
    const binDir = makeBinDir(['tmux']);
    const tmuxPath = join(binDir, 'tmux');

    // Act
    const result = await resolveTmuxProvider(MIN, binDir, deps({ [tmuxPath]: 'tmux 3.7b' }));

    // Assert
    expect(result).toMatchObject({ status: 'ok', source: 'path', version: 'tmux 3.7b' });
    expect(result.prependedBinDir).toBeUndefined();
  });

  it('falls back to the Homebrew formula when the PATH tmux is too old', async () => {
    // Arrange
    const pathDir = makeBinDir(['tmux', 'brew']);
    const brewPrefixBin = makeBinDir(['tmux']);
    const brewPrefix = brewPrefixBin.replace(/\/bin$/, '');

    // Act
    const result = await resolveTmuxProvider(MIN, pathDir, deps(
      { [join(pathDir, 'tmux')]: 'tmux 3.6a', [join(brewPrefixBin, 'tmux')]: 'tmux 3.7b' },
      brewPrefix,
    ));

    // Assert
    expect(result).toMatchObject({ status: 'ok', source: 'homebrew', prependedBinDir: brewPrefixBin });
  });

  it('does not replace a supported custom tmux with Homebrew', async () => {
    // Arrange
    const pathDir = makeBinDir(['tmux', 'brew']);
    const brewPrefixBin = makeBinDir(['tmux']);

    // Act
    const result = await resolveTmuxProvider(MIN, pathDir, deps(
      { [join(pathDir, 'tmux')]: 'tmux 3.8', [join(brewPrefixBin, 'tmux')]: 'tmux 3.7b' },
      brewPrefixBin.replace(/\/bin$/, ''),
    ));

    // Assert
    expect(result.source).toBe('path');
    expect(result.version).toBe('tmux 3.8');
  });

  it('resolves symlinked kegs to their canonical real path', async () => {
    // Arrange
    const realBin = makeBinDir([]);
    const realTmux = join(realBin, 'tmux');
    writeFileSync(realTmux, '#!/bin/sh\n');
    chmodSync(realTmux, 0o755);
    const linkDir = makeBinDir([]);
    const linkTmux = join(linkDir, 'tmux');
    symlinkSync(realTmux, linkTmux);

    // Act
    const result = await resolveTmuxProvider(MIN, linkDir, deps({ [linkTmux]: 'tmux 3.7b' }));

    // Assert
    expect(result.path).toBe(realpathSync(realTmux));
  });

  it('classifies an old-only environment without Homebrew as old', async () => {
    // Arrange
    const pathDir = makeBinDir(['tmux']);

    // Act
    const result = await resolveTmuxProvider(MIN, pathDir, deps({ [join(pathDir, 'tmux')]: 'tmux 3.6a' }));

    // Assert
    expect(result).toMatchObject({ status: 'old', detected: 'tmux 3.6a' });
  });

  it('reports missing when no tmux is on PATH and Homebrew has none', async () => {
    // Arrange
    const emptyDir = makeBinDir([]);

    // Act
    const result = await resolveTmuxProvider(MIN, emptyDir, deps({}));

    // Assert
    expect(result.status).toBe('missing');
  });

  it('flags an unparseable PATH version as unparseable', async () => {
    // Arrange
    const pathDir = makeBinDir(['tmux']);

    // Act
    const result = await resolveTmuxProvider(MIN, pathDir, deps({ [join(pathDir, 'tmux')]: 'tmux next-master' }));

    // Assert
    expect(result).toMatchObject({ status: 'unparseable', detected: 'tmux next-master' });
  });

  it('ignores directories with spaces that hold no tmux', async () => {
    // Arrange
    const spaced = mkdtempSync(join(tmpdir(), 'tmux provider space-'));
    roots.push(spaced);
    const binDir = join(spaced, 'bin');
    mkdirSync(binDir, { recursive: true });
    const good = makeBinDir(['tmux']);

    // Act
    const result = await resolveTmuxProvider(MIN, [binDir, good].join(delimiter), deps({ [join(good, 'tmux')]: 'tmux 3.7b' }));

    // Assert
    expect(result).toMatchObject({ status: 'ok', source: 'path' });
  });
});
