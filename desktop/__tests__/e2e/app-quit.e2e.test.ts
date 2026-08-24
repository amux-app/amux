import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { _electron as electron } from 'playwright';
import type { ElectronApplication } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { IPC } from '../../src/shared/ipc-channels';
import { getAppWindow, waitForAppReady } from './e2e-helpers';

const ROOT = resolve(__dirname, '..', '..');
const MAIN_ENTRY = resolve(ROOT, 'out', 'main', 'index.js');
const APP_STARTUP_TIMEOUT_MS = 30_000;
const TEST_TIMEOUT_MS = 15_000;

interface E2EWindow {
  aumx: {
    invoke: <T>(channel: string, ...args: unknown[]) => Promise<T>;
  };
}

function waitForProcessExit(app: ElectronApplication, timeoutMs: number): Promise<void> {
  return new Promise((resolveExit, rejectExit) => {
    const timer = setTimeout(() => {
      rejectExit(new Error(`Electron did not exit within ${timeoutMs} ms`));
    }, timeoutMs);
    app.process().once('exit', () => {
      clearTimeout(timer);
      resolveExit();
    });
  });
}

describe.runIf(process.env.AUMX_E2E === '1')('Application quit E2E', () => {
  let app: ElectronApplication;
  let appExited = false;
  let blockTmuxFile = '';
  let fakeTmuxPidFile = '';
  let projectRoot = '';
  let realTmuxPath = '';

  beforeAll(async () => {
    expect(existsSync(MAIN_ENTRY), `Build output missing: ${MAIN_ENTRY}`).toBe(true);
    projectRoot = mkdtempSync(join(tmpdir(), 'aumx-quit-e2e-'));
    execFileSync('git', ['init'], { cwd: projectRoot, stdio: 'ignore' });
    realTmuxPath = execFileSync('which', ['tmux'], { encoding: 'utf8' }).trim();
    const fakeBin = join(projectRoot, 'fake-bin');
    const fakeTmux = join(fakeBin, 'tmux');
    const blockingFifo = join(projectRoot, 'blocked-tmux.fifo');
    blockTmuxFile = join(projectRoot, 'block-tmux');
    fakeTmuxPidFile = join(projectRoot, 'fake-tmux.pid');
    mkdirSync(fakeBin);
    execFileSync('mkfifo', [blockingFifo]);
    writeFileSync(fakeTmux, [
      '#!/bin/sh',
      'if [ ! -e "$AUMX_E2E_BLOCK_TMUX_FILE" ]; then',
      '  exec "$AUMX_E2E_REAL_TMUX" "$@"',
      'fi',
      'printf \'%s\\n\' "$$" >> "$AUMX_E2E_FAKE_TMUX_PID_FILE"',
      'exec /bin/cat "$AUMX_E2E_FAKE_TMUX_FIFO"',
      '',
    ].join('\n'));
    chmodSync(fakeTmux, 0o755);

    app = await electron.launch({
      args: [MAIN_ENTRY],
      cwd: projectRoot,
      env: {
        ...process.env,
        AUMX_E2E_BLOCK_TMUX_FILE: blockTmuxFile,
        AUMX_E2E_FAKE_TMUX_FIFO: blockingFifo,
        AUMX_E2E_FAKE_TMUX_PID_FILE: fakeTmuxPidFile,
        AUMX_E2E_REAL_TMUX: realTmuxPath,
        AUMX_DISABLE_UPDATE_CHECKS: '1',
        AUMX_E2E: '1',
        NODE_ENV: 'test',
        PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
        SHELL: '/bin/sh',
      },
    });
    const page = await getAppWindow(app);
    await page.locator('[data-testid="app-shell"]').waitFor({
      state: 'visible',
      timeout: APP_STARTUP_TIMEOUT_MS,
    });
    await waitForAppReady(page, APP_STARTUP_TIMEOUT_MS);
  }, APP_STARTUP_TIMEOUT_MS);

  afterAll(async () => {
    if (fakeTmuxPidFile && existsSync(fakeTmuxPidFile)) {
      const pids = readFileSync(fakeTmuxPidFile, 'utf8')
        .split(/\s+/)
        .map((value) => Number.parseInt(value, 10));
      for (const pid of pids) {
        if (Number.isInteger(pid) && pid > 1) {
          try {
            process.kill(pid, 'SIGKILL');
          } catch {
            // The forced Electron exit may already have reaped the fake process.
          }
        }
      }
    }
    if (!appExited && app) await app.close();
    if (realTmuxPath && projectRoot) {
      try {
        execFileSync(realTmuxPath, ['kill-session', '-t', `=aumx-${basename(projectRoot)}`], {
          stdio: 'ignore',
        });
      } catch {
        // The app may not have needed to create a project session.
      }
    }
    if (projectRoot) rmSync(projectRoot, { force: true, recursive: true });
  }, TEST_TIMEOUT_MS);

  it('force-exits when resource cleanup exceeds the global quit deadline', async () => {
    writeFileSync(blockTmuxFile, 'block');

    const page = await getAppWindow(app);
    const processExit = waitForProcessExit(app, 10_000);
    const startedAt = Date.now();
    const accepted = await page.evaluate(async (channel) => {
      return (window as unknown as E2EWindow).aumx.invoke<boolean>(channel);
    }, IPC.APP_QUIT);

    expect(accepted).toBe(true);
    await processExit;
    appExited = true;
    expect(Date.now() - startedAt).toBeLessThan(8_000);
    expect(existsSync(fakeTmuxPidFile)).toBe(true);
  }, TEST_TIMEOUT_MS);
});
