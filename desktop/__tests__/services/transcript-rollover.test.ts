import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  rolloverPaneTranscript,
  sweepTranscriptRollovers,
  transcriptNeedsRollover,
} from '../../src/main/services/transcript-rollover';
import { startTmuxTranscript, type TmuxTranscriptRunner } from '../../src/main/utils/tmux-transcript';

vi.mock('../../src/main/services/Logger.js', () => ({
  log: {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

const tempDirs: string[] = [];

function createTempTranscript(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'aumx-rollover-'));
  tempDirs.push(dir);
  const transcriptPath = join(dir, 'pane.ansi');
  writeFileSync(transcriptPath, content);
  return transcriptPath;
}

function executePipeCommand(args: string[]): void {
  const command = args[3];
  if (!command) return;
  execFileSync('/bin/sh', ['-c', command], { stdio: 'ignore' });
}

function successfulRunner(): ReturnType<typeof vi.fn<TmuxTranscriptRunner>> {
  return vi.fn<TmuxTranscriptRunner>(async (args) => {
    executePipeCommand(args);
  });
}

function rolloverArtifacts(transcriptPath: string): string[] {
  return readdirSync(dirname(transcriptPath)).filter((name) => name.includes('.rollover-'));
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(predicate()).toBe(true);
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('transcriptNeedsRollover', () => {
  it('is false at or below the cap and true above it', () => {
    const transcriptPath = createTempTranscript('12345678');

    expect(transcriptNeedsRollover(transcriptPath, 8)).toBe(false);
    expect(transcriptNeedsRollover(transcriptPath, 7)).toBe(true);
  });

  it('is false for a missing file', () => {
    expect(transcriptNeedsRollover('/nonexistent/pane.ansi', 8)).toBe(false);
  });
});

describe('rolloverPaneTranscript', () => {
  it('atomically replaces the transcript path and restarts piping on the fresh inode', async () => {
    const transcriptPath = createTempTranscript('old-bytes');
    const oldIno = statSync(transcriptPath).ino;
    const runner = successfulRunner();

    await rolloverPaneTranscript('%7', transcriptPath, runner);

    expect(existsSync(transcriptPath)).toBe(true);
    expect(readFileSync(transcriptPath, 'utf8')).toBe('');
    expect(statSync(transcriptPath).ino).not.toBe(oldIno);
    expect(rolloverArtifacts(transcriptPath)).toEqual([]);
    expect(runner).toHaveBeenCalledTimes(1);
    expect(runner.mock.calls[0][0].slice(0, 3)).toEqual(['pipe-pane', '-t', '%7']);
    expect(runner.mock.calls[0][0][3]).toContain(`'${transcriptPath}'`);
  });

  it('keeps the visible transcript and stops piping when replacement fails', async () => {
    const transcriptPath = createTempTranscript('old-bytes');
    const oldIno = statSync(transcriptPath).ino;
    const runner = vi.fn<TmuxTranscriptRunner>(async (args) => {
      if (args.length > 3) throw new Error('tmux gone');
    });

    await expect(rolloverPaneTranscript('%7', transcriptPath, runner)).rejects.toThrow('tmux gone');

    expect(readFileSync(transcriptPath, 'utf8')).toBe('old-bytes');
    expect(statSync(transcriptPath).ino).toBe(oldIno);
    expect(rolloverArtifacts(transcriptPath)).toEqual([]);
    expect(runner).toHaveBeenCalledTimes(2);
    expect(runner.mock.calls[1][0]).toEqual(['pipe-pane', '-t', '%7']);
  });

  it('keeps an isolated real tmux pane piping into the same path after rollover', async () => {
    const transcriptPath = createTempTranscript('');
    const label = `ar-${process.pid}-${Date.now().toString(36)}`;
    const runTmux = (args: string[]): string => execFileSync(
      'tmux',
      ['-L', label, ...args],
      {
        encoding: 'utf8',
        env: { ...process.env, TMUX_TMPDIR: tmpdir() },
      },
    );
    const runner: TmuxTranscriptRunner = async (args) => {
      runTmux(args);
    };

    runTmux(['-f', '/dev/null', 'new-session', '-d', '-s', 'rollover']);
    try {
      await startTmuxTranscript('rollover', transcriptPath, runner);
      runTmux(['send-keys', '-t', 'rollover', "printf 'before-rollover\\n'", 'Enter']);
      await waitFor(() => readFileSync(transcriptPath, 'utf8').includes('before-rollover'));
      writeFileSync(transcriptPath, 'stale-persisted-history\n', { flag: 'a' });
      const oldIno = statSync(transcriptPath).ino;

      await rolloverPaneTranscript('rollover', transcriptPath, runner);
      await waitFor(() => statSync(transcriptPath).ino !== oldIno);
      expect(runTmux(['display-message', '-p', '-t', 'rollover', '#{pane_pipe}']).trim()).toBe('1');
      runTmux(['send-keys', '-t', 'rollover', "printf 'after-rollover\\n'", 'Enter']);
      await waitFor(() => readFileSync(transcriptPath, 'utf8').includes('after-rollover'));

      expect(readFileSync(transcriptPath, 'utf8')).not.toContain('stale-persisted-history');
    } finally {
      try {
        runTmux(['kill-server']);
      } catch {
      }
    }
  });
});

describe('sweepTranscriptRollovers', () => {
  it('rolls only oversized transcripts of live panes', async () => {
    const oversized = createTempTranscript('123456789');
    const small = createTempTranscript('123');
    const deadPaneTranscript = createTempTranscript('123456789');
    const runner = successfulRunner();
    const isPaneAlive = vi.fn(async (tmuxPaneId: string) => tmuxPaneId !== '%dead');
    const panes = [
      { id: 'a', paneId: '%1', terminalTranscriptPath: oversized },
      { id: 'b', paneId: '%2', terminalTranscriptPath: small },
      { id: 'c', paneId: '%dead', terminalTranscriptPath: deadPaneTranscript },
      { id: 'd', paneId: '%3' },
    ];

    const rolled = await sweepTranscriptRollovers(panes, { isPaneAlive, maxBytes: 8, runner });

    expect(rolled).toBe(1);
    expect(readFileSync(oversized, 'utf8')).toBe('');
    expect(readFileSync(small, 'utf8')).toBe('123');
    expect(readFileSync(deadPaneTranscript, 'utf8')).toBe('123456789');
    expect(isPaneAlive).toHaveBeenCalledTimes(2);
  });

  it('isolates pane failures and continues rolling healthy panes', async () => {
    const first = createTempTranscript('123456789');
    const second = createTempTranscript('123456789');
    const runner = vi.fn<TmuxTranscriptRunner>(async (args) => {
      if (args[2] === '%1' && args.length > 3) throw new Error('tmux gone');
      executePipeCommand(args);
    });
    const panes = [
      { id: 'a', paneId: '%1', terminalTranscriptPath: first },
      { id: 'b', paneId: '%2', terminalTranscriptPath: second },
    ];

    const rolled = await sweepTranscriptRollovers(panes, {
      isPaneAlive: async () => true,
      maxBytes: 8,
      runner,
    });

    expect(rolled).toBe(1);
    expect(readFileSync(first, 'utf8')).toBe('123456789');
    expect(readFileSync(second, 'utf8')).toBe('');
  });

  it('continues when one pane liveness probe fails', async () => {
    const first = createTempTranscript('123456789');
    const second = createTempTranscript('123456789');
    const runner = successfulRunner();

    const rolled = await sweepTranscriptRollovers([
      { id: 'a', paneId: '%1', terminalTranscriptPath: first },
      { id: 'b', paneId: '%2', terminalTranscriptPath: second },
    ], {
      isPaneAlive: async (paneId) => {
        if (paneId === '%1') throw new Error('probe failed');
        return true;
      },
      maxBytes: 8,
      runner,
    });

    expect(rolled).toBe(1);
    expect(readFileSync(first, 'utf8')).toBe('123456789');
    expect(readFileSync(second, 'utf8')).toBe('');
  });
});
