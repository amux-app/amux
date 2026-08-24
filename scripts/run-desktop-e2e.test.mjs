import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const runner = join(process.cwd(), 'scripts', 'run-desktop-e2e.mjs');

function runRunner(code, file) {
  return spawnSync(process.execPath, [runner, '--', process.execPath, '-e', code], {
    env: { ...process.env, AUMX_E2E_RUNNER_TMPDIR_FILE: file },
    encoding: 'utf8',
  });
}

describe('desktop E2E runner', () => {
  it('passes a child argument named --files through unchanged', () => {
    const result = spawnSync(
      process.execPath,
      [runner, '--', process.execPath, '-e', "process.exit(process.argv[1] === '--files' ? 0 : 8)", '--', '--files'],
      { encoding: 'utf8' },
    );

    expect(result.status).toBe(0);
  });

  it('runs each requested test file in a fresh tmux environment', () => {
    const root = mkdtempSync(join(tmpdir(), 'aumx-runner-test-'));
    const record = join(root, 'runs');
    const result = spawnSync(
      process.execPath,
      [
        runner,
        '--files',
        'first.test.ts',
        'second.test.ts',
        '--',
        process.execPath,
        '-e',
        "require('node:fs').appendFileSync(process.env.AUMX_E2E_FILE_RECORD, `${process.env.TMUX_TMPDIR}|${process.argv[1]}\\n`)",
      ],
      {
        env: { ...process.env, AUMX_E2E_FILE_RECORD: record },
        encoding: 'utf8',
      },
    );

    expect(result.status).toBe(0);
    const runs = readFileSync(record, 'utf8').trim().split('\n');
    expect(runs).toHaveLength(2);
    expect(runs.map((run) => run.split('|')[1])).toEqual(['first.test.ts', 'second.test.ts']);

    const tmuxDirectories = runs.map((run) => run.split('|')[0]);
    expect(new Set(tmuxDirectories).size).toBe(2);
    expect(tmuxDirectories.every((directory) => !existsSync(directory))).toBe(true);
    rmSync(root, { force: true, recursive: true });
  });

  it('cleans its private tmux directory after a passing command', () => {
    const root = mkdtempSync(join(tmpdir(), 'aumx-runner-test-'));
    const file = join(root, 'tmux-dir');
    const result = runRunner('process.exit(0)', file);

    expect(result.status).toBe(0);
    expect(existsSync(readFileSync(file, 'utf8'))).toBe(false);
    rmSync(root, { force: true, recursive: true });
  });

  it('preserves the child failure code while still cleaning up', () => {
    const root = mkdtempSync(join(tmpdir(), 'aumx-runner-test-'));
    const file = join(root, 'tmux-dir');
    const result = runRunner('process.exit(7)', file);

    expect(result.status).toBe(7);
    expect(existsSync(readFileSync(file, 'utf8'))).toBe(false);
    rmSync(root, { force: true, recursive: true });
  });

  it('does not inherit a caller tmux environment', () => {
    const root = mkdtempSync(join(tmpdir(), 'aumx-runner-test-'));
    const file = join(root, 'tmux-dir');
    const result = runRunner('process.exit(process.env.TMUX || process.env.TMUX_PANE ? 9 : 0)', file);

    expect(result.status).toBe(0);
    expect(existsSync(readFileSync(file, 'utf8'))).toBe(false);
    rmSync(root, { force: true, recursive: true });
  });

  it('preserves the forwarded signal exit status and cleans up', () => {
    const root = mkdtempSync(join(tmpdir(), 'aumx-runner-test-'));
    const file = join(root, 'tmux-dir');
    const result = runRunner(
      "setTimeout(() => process.kill(process.ppid, 'SIGTERM'), 100); setInterval(() => {}, 1000)",
      file,
    );

    expect(result.status).toBe(143);
    expect(existsSync(readFileSync(file, 'utf8'))).toBe(false);
    rmSync(root, { force: true, recursive: true });
  }, 10_000);
});
