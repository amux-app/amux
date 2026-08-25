import { execAsync } from 'muxbase/core';
import { spawnSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import * as pty from 'node-pty';
import { afterEach, describe, expect, it } from 'vitest';
import { TerminalPtyOsc52Follower } from '../../src/main/services/terminal-pty-osc52-follower';
import { TerminalPtyService, type TerminalPtySpawner } from '../../src/main/services/terminal-pty-service';

const OSC52_PAYLOAD = '\x1b]52;c;QU1VWC1PU0MtNTI=\x07';
const SHELL_OSC52_PAYLOAD = '\\033]52;c;QU1VWC1PU0MtNTI=\\007';
const UTF8_BLOCK_LOGO = '▐▛███▜▌';
const WATCHER_DELIVERY_BUDGET_MS = 2_000;
const SHELL_UTF8_BLOCK_LOGO = [...Buffer.from(UTF8_BLOCK_LOGO, 'utf8')]
  .map((byte) => `\\${byte.toString(8).padStart(3, '0')}`)
  .join('');

function runTmux(label: string, args: string[], allowFail = false): string {
  const result = spawnSync('tmux', ['-L', label, ...args], { encoding: 'utf8' });
  if (result.status !== 0 && !allowFail) {
    throw new Error(result.stderr || result.stdout || `tmux ${args.join(' ')} failed`);
  }
  return result.stdout.trim();
}

function makeLabeledExec(label: string): typeof execAsync {
  return ((command, options) => execAsync(command.replace(/^tmux\b/g, `tmux -L ${label}`), options)) as typeof execAsync;
}

function makeLabeledSpawner(label: string): TerminalPtySpawner {
  return {
    spawn(file, args, options) {
      expect(file).toBe('tmux');
      return pty.spawn(file, ['-L', label, ...args], options);
    },
  };
}

function makeLocaleFreeLabeledSpawner(label: string): TerminalPtySpawner {
  return {
    spawn(file, args, options) {
      const env = { ...options.env };
      delete env.LANG;
      delete env.LC_ALL;
      delete env.LC_CTYPE;
      return pty.spawn(file, ['-L', label, ...args], { ...options, env });
    },
  };
}

async function waitForOutput(predicate: () => boolean, description: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (!predicate()) throw new Error(`Timed out waiting for ${description}`);
}

describe('TerminalPtyService real tmux integration', () => {
  const labels: string[] = [];
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const label of labels.splice(0)) {
      runTmux(label, ['kill-server'], true);
    }
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it('attaches an isolated PTY view with mouse enabled', async () => {
    const label = `muxbase-pty-mouse-${process.pid}-${Date.now()}`;
    labels.push(label);

    runTmux(label, ['-f', '/dev/null', 'new-session', '-d', '-s', 'src', 'sleep', '86400']);
    const windowId = runTmux(label, ['list-windows', '-t', '=src', '-F', '#{window_id}']);
    const tmuxPaneId = runTmux(label, ['list-panes', '-t', '=src', '-F', '#{pane_id}']);
    const service = new TerminalPtyService({
      exec: makeLabeledExec(label),
      killViewSession: (viewSessionName) => {
        runTmux(label, ['kill-session', '-t', `=${viewSessionName}`], true);
      },
      spawner: makeLabeledSpawner(label),
    });

    const handle = await service.attach({
      cols: 80,
      enableMouse: true,
      onData: () => undefined,
      paneId: 'pane-mouse',
      rows: 24,
      sessionName: 'src',
      streamId: 1,
      tmuxPaneId,
      windowId,
    });

    expect(runTmux(label, [
      'show-options',
      '-v',
      '-t',
      'src--view-pane-mouse',
      'mouse',
    ])).toBe('on');
    handle.dispose();
  }, 15_000);

  it('delivers application OSC 52 through the app-local transcript follower without mutating server policy', async () => {
    const label = `muxbase-osc52-${process.pid}-${Date.now()}`;
    labels.push(label);
    const tempDir = mkdtempSync(join(tmpdir(), 'muxbase-osc52-'));
    tempDirs.push(tempDir);
    const triggerPath = join(tempDir, 'go');
    const transcriptPath = join(tempDir, 'pane.ansi');
    writeFileSync(transcriptPath, '');
    const script = `while [ ! -f ${JSON.stringify(triggerPath)} ]; do sleep 0.05; done; printf '${SHELL_OSC52_PAYLOAD}'; sleep 0.5`;

    runTmux(label, ['-f', '/dev/null', 'new-session', '-d', '-s', 'src', 'sh', '-lc', script]);
    runTmux(label, ['new-session', '-d', '-s', 'unrelated', 'sleep', '86400']);
    runTmux(label, ['new-session', '-d', '-s', 'src--view-pane-1', 'sleep', '86400']);
    const clipboardPolicyBefore = runTmux(label, ['show-options', '-sv', 'set-clipboard']);
    const windowId = runTmux(label, ['list-windows', '-t', '=src', '-F', '#{window_id}']);
    const tmuxPaneId = runTmux(label, ['list-panes', '-t', '=src', '-F', '#{pane_id}']);
    runTmux(label, ['pipe-pane', '-t', tmuxPaneId, `cat >> ${JSON.stringify(transcriptPath)}`]);
    const service = new TerminalPtyService({
      exec: makeLabeledExec(label),
      killViewSession: (viewSessionName) => {
        runTmux(label, ['kill-session', '-t', `=${viewSessionName}`], true);
      },
      spawner: makeLabeledSpawner(label),
    });

    let ptyOutput = '';
    let extractedOutput = '';
    // The fallback interval is pinned to the clamp ceiling so a delivery under
    // WATCHER_DELIVERY_BUDGET_MS can only have come from the transcript watcher.
    const followerHandle = new TerminalPtyOsc52Follower({ pollIntervalMs: 5_000 }).attach(
      transcriptPath,
      (sequence) => {
        extractedOutput += sequence;
      },
    );
    const handle = await service.attach({
      cols: 80,
      onData: (_paneId, data) => {
        ptyOutput += data;
      },
      paneId: 'pane-1',
      rows: 24,
      sessionName: 'src',
      streamId: 1,
      tmuxPaneId,
      windowId,
    });

    await waitForOutput(() => runTmux(
      label,
      ['list-clients', '-t', '=src--view-pane-1', '-F', '#{client_name}'],
      true,
    ).length > 0, 'the isolated tmux client to attach');
    writeFileSync(triggerPath, '1');
    const triggeredAt = Date.now();
    await waitForOutput(() => extractedOutput.includes(OSC52_PAYLOAD), 'the extracted OSC 52 payload');
    expect(Date.now() - triggeredAt).toBeLessThan(WATCHER_DELIVERY_BUDGET_MS);
    expect(ptyOutput).not.toContain(OSC52_PAYLOAD);
    expect(clipboardPolicyBefore).toBe('external');
    expect(runTmux(label, ['show-options', '-sv', 'set-clipboard'])).toBe(clipboardPolicyBefore);
    expect(runTmux(label, ['list-sessions', '-F', '#{session_name}']).split('\n')).toContain('unrelated');
    followerHandle.dispose();
    handle.dispose();
  }, 15_000);

  it('preserves UTF-8 block glyphs when the desktop process has no locale', async () => {
    const label = `muxbase-utf8-${process.pid}-${Date.now()}`;
    labels.push(label);
    const script = `printf '${SHELL_UTF8_BLOCK_LOGO}  Claude Code\\n'; sleep 86400`;

    runTmux(label, ['-f', '/dev/null', 'new-session', '-d', '-s', 'src', 'sh', '-lc', script]);
    const windowId = runTmux(label, ['list-windows', '-t', '=src', '-F', '#{window_id}']);
    const tmuxPaneId = runTmux(label, ['list-panes', '-t', '=src', '-F', '#{pane_id}']);
    const service = new TerminalPtyService({
      exec: makeLabeledExec(label),
      killViewSession: (viewSessionName) => {
        runTmux(label, ['kill-session', '-t', `=${viewSessionName}`], true);
      },
      spawner: makeLocaleFreeLabeledSpawner(label),
    });

    let ptyOutput = '';
    const handle = await service.attach({
      cols: 80,
      onData: (_paneId, data) => {
        ptyOutput += data;
      },
      paneId: 'pane-utf8',
      rows: 24,
      sessionName: 'src',
      streamId: 1,
      tmuxPaneId,
      windowId,
    });

    await waitForOutput(() => ptyOutput.includes('Claude Code'), 'the initial tmux repaint');
    expect(ptyOutput).toContain(UTF8_BLOCK_LOGO);
    handle.dispose();
  }, 15_000);
});
