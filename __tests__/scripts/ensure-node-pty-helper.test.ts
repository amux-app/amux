import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureNodePtyHelpersExecutable } from '../../scripts/ensure-node-pty-helper.mjs';

const scratchDirs: string[] = [];

afterEach(() => {
  for (const dir of scratchDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

function createHelper(mode: number): { helperPath: string; packageRoot: string } {
  const packageRoot = mkdtempSync(join(tmpdir(), 'aumx-node-pty-'));
  scratchDirs.push(packageRoot);
  const helperPath = join(packageRoot, 'prebuilds', 'darwin-arm64', 'spawn-helper');
  mkdirSync(join(packageRoot, 'prebuilds', 'darwin-arm64'), { recursive: true });
  writeFileSync(helperPath, 'helper');
  chmodSync(helperPath, mode);
  return { helperPath, packageRoot };
}

describe('ensureNodePtyHelpersExecutable', () => {
  it('runs automatically after dependencies are installed', () => {
    const packageJson = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));

    expect(packageJson.scripts.postinstall).toBe('node scripts/ensure-node-pty-helper.mjs');
  });

  it('repairs the missing executable bit in both macOS release prebuilds', () => {
    const { helperPath, packageRoot } = createHelper(0o644);
    const x64HelperPath = join(packageRoot, 'prebuilds', 'darwin-x64', 'spawn-helper');
    mkdirSync(join(packageRoot, 'prebuilds', 'darwin-x64'), { recursive: true });
    writeFileSync(x64HelperPath, 'helper');
    chmodSync(x64HelperPath, 0o644);

    const repaired = ensureNodePtyHelpersExecutable(packageRoot, {
      platform: 'darwin',
    });

    expect(repaired).toEqual([helperPath, x64HelperPath]);
    expect(statSync(helperPath).mode & 0o777).toBe(0o755);
    expect(statSync(x64HelperPath).mode & 0o777).toBe(0o755);
  });

  it('does not mutate helpers on other platforms', () => {
    const { helperPath, packageRoot } = createHelper(0o644);

    const repaired = ensureNodePtyHelpersExecutable(packageRoot, {
      platform: 'linux',
    });

    expect(repaired).toEqual([]);
    expect(statSync(helperPath).mode & 0o777).toBe(0o644);
  });
});
