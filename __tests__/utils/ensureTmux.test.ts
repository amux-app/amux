import { execFile } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const SCRIPT = resolve(__dirname, '../../scripts/ensure-tmux.mjs');
const roots: string[] = [];

function stubBinDir(scripts: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'ensure-tmux-'));
  roots.push(dir);
  for (const [name, body] of Object.entries(scripts)) {
    const path = join(dir, name);
    writeFileSync(path, `#!/bin/sh\n${body}\n`);
    chmodSync(path, 0o755);
  }
  return dir;
}

async function runScript(
  binDir: string,
  mode: '--check' | '--provision' = '--check',
  env: Record<string, string> = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [SCRIPT, mode], {
      env: { ...env, PATH: binDir },
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const err = error as { code?: number; stdout?: string; stderr?: string };
    return { code: err.code ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe('ensure-tmux --check', () => {
  it('passes when tmux meets the minimum', async () => {
    // Arrange
    const binDir = stubBinDir({
      tmux: 'if [ "$1" = "-V" ]; then echo "tmux 3.7b"; else echo "3.7b"; fi',
    });

    // Act
    const result = await runScript(binDir);

    // Assert
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('ok tmux 3.7b');
    expect(result.stdout).toContain('ok tmux server 3.7b');
  });

  it('fails with an upgrade instruction when tmux is too old', async () => {
    // Arrange
    const binDir = stubBinDir({ tmux: 'echo "tmux 3.6a"' });

    // Act
    const result = await runScript(binDir);

    // Assert
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('brew upgrade tmux');
  });

  it('fails with an install instruction when tmux is missing', async () => {
    // Arrange
    const binDir = stubBinDir({});

    // Act
    const result = await runScript(binDir);

    // Assert
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('brew install tmux');
  });

  it('never proposes killing a running server', async () => {
    // Arrange
    const binDir = stubBinDir({ tmux: 'echo "tmux 3.7b"' });

    // Act
    const result = await runScript(binDir);

    // Assert
    expect(`${result.stdout}${result.stderr}`).not.toMatch(/kill-server/);
  });

  it('blocks when a supported client is still connected to an old server', async () => {
    // Arrange
    const binDir = stubBinDir({
      tmux: 'if [ "$1" = "-V" ]; then echo "tmux 3.7b"; else echo "3.6a"; fi',
    });

    // Act
    const result = await runScript(binDir);

    // Assert
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('tmux server 3.6a is still running');
    expect(result.stderr).toContain('restart tmux completely');
    expect(result.stderr).not.toContain('kill-server');
  });

  it('fails closed when the running server cannot be verified', async () => {
    // Arrange
    const binDir = stubBinDir({
      tmux: [
        'if [ "$1" = "-V" ]; then echo "tmux 3.7b"; exit 0; fi',
        'echo "error connecting (Permission denied)" >&2',
        'exit 1',
      ].join('\n'),
    });

    // Act
    const result = await runScript(binDir);

    // Assert
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('could not verify the running tmux server');
  });

  it('accepts the exact no-server result', async () => {
    // Arrange
    const binDir = stubBinDir({
      tmux: [
        'if [ "$1" = "-V" ]; then echo "tmux 3.7b"; exit 0; fi',
        'echo "no server running on /tmp/tmux-501/default" >&2',
        'exit 1',
      ].join('\n'),
    });

    // Act
    const result = await runScript(binDir);

    // Assert
    expect(result.code).toBe(0);
  });

  it('refuses to upgrade an unsupported tmux that Homebrew does not own', async () => {
    // Arrange
    const actionLog = join(tmpdir(), `ensure-tmux-actions-${Date.now()}`);
    const binDir = stubBinDir({
      brew: [
        'if [ "$1" = "--version" ]; then echo "Homebrew 6"; exit 0; fi',
        'if [ "$1" = "--prefix" ]; then exit 1; fi',
        'printf "%s\\n" "$*" >> "$ACTION_LOG"',
      ].join('\n'),
      tmux: 'echo "tmux 3.6a"',
    });

    // Act
    const result = await runScript(binDir, '--provision', { ACTION_LOG: actionLog });

    // Assert
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('is not managed by Homebrew');
    expect(() => readFileSync(actionLog, 'utf8')).toThrow();
  });

  it('does not treat an unparseable custom tmux as missing during provisioning', async () => {
    // Arrange
    const actionLog = join(tmpdir(), `ensure-tmux-actions-${Date.now()}`);
    const binDir = stubBinDir({
      brew: [
        'if [ "$1" = "--version" ]; then echo "Homebrew 6"; exit 0; fi',
        'printf "%s\\n" "$*" >> "$ACTION_LOG"',
      ].join('\n'),
      tmux: 'echo "tmux custom-build"',
    });

    // Act
    const result = await runScript(binDir, '--provision', { ACTION_LOG: actionLog });

    // Assert
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('could not verify tmux version tmux custom-build');
    expect(() => readFileSync(actionLog, 'utf8')).toThrow();
  });
});
