import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'fs';
import type { ElectronApplication, Page } from 'playwright';
import type { AumxPane } from 'aumx/core';
import { isHeadlessE2E } from '../../src/main/e2e-window-mode';
import { IPC } from '../../src/shared/ipc-channels';
import type {
  AppBootState,
  GitDiffResponse,
  SystemCheckResult,
  SessionInfoResult,
} from '../../src/shared/ipc-types';
import type { NormalizedSession } from '../../src/shared/agent-session-types';

export interface PhaseResult {
  name: string;
  status: 'passed' | 'failed' | 'skipped';
  durationMs: number;
  error?: string;
}

export interface FileBaseline {
  size: number;
  mtimeMs: number;
}

export interface FileSnapshot extends FileBaseline {
  content: string;
}

interface ElectronTestRuntime {
  headless: boolean;
  platform: NodeJS.Platform;
}

async function getElectronTestRuntime(app: ElectronApplication): Promise<ElectronTestRuntime> {
  const runtime = await app.evaluate(() => ({
    environment: {
      AUMX_E2E: process.env.AUMX_E2E,
      AUMX_E2E_HEADED: process.env.AUMX_E2E_HEADED,
      NODE_ENV: process.env.NODE_ENV,
    },
    platform: process.platform,
  }));
  return {
    headless: isHeadlessE2E(runtime.environment),
    platform: runtime.platform,
  };
}

export async function getAppWindow(app: ElectronApplication): Promise<Page> {
  for (const win of app.windows()) {
    if (!win.url().startsWith('devtools://')) return win;
  }
  const page = await app.firstWindow();
  if (page.url().startsWith('devtools://')) {
    return new Promise((res) => {
      app.on('window', (win) => {
        if (!win.url().startsWith('devtools://')) res(win);
      });
    });
  }
  return page;
}

function hasProcessExited(child: ReturnType<ElectronApplication['process']>): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

export async function closeElectronApp(
  app: ElectronApplication,
  timeoutMs = 10_000,
): Promise<void> {
  const child = app.process();
  if (hasProcessExited(child)) return;

  const exited = waitForProcessExit(child, timeoutMs);
  try {
    await app.evaluate(({ app: electronApp }) => electronApp.quit());
  } catch {
    // The process may already be closing; wait for the same exit signal.
  }

  await exited;
  if (hasProcessExited(child)) return;

  child.kill('SIGTERM');
  await waitForProcessExit(child, timeoutMs);
  if (hasProcessExited(child)) return;

  child.kill('SIGKILL');
  await waitForProcessExit(child, timeoutMs);
  if (!hasProcessExited(child)) {
    throw new Error(`Electron process ${child.pid ?? 'unknown'} did not exit after SIGKILL`);
  }
}

function waitForProcessExit(child: ReturnType<ElectronApplication['process']>, timeoutMs: number): Promise<void> {
  if (hasProcessExited(child)) return Promise.resolve();
  return new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.removeListener('exit', finish);
      resolve();
    };
    const timeout = setTimeout(finish, timeoutMs);
    child.once('exit', finish);
  });
}

export async function ensureAppWindowVisible(app: ElectronApplication): Promise<void> {
  const { headless } = await getElectronTestRuntime(app);
  const visible = await app.evaluate(({ BrowserWindow }, showWithoutActivation) => {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win || win.isDestroyed()) return false;
    if (win.isMinimized()) win.restore();
    // Renderer reload can cancel or reorder Electron's initial ready-to-show
    // transition. Drive one complete lifecycle transition so the
    // main-process terminal visibility state cannot remain stale.
    if (win.isVisible()) win.hide();
    if (showWithoutActivation) {
      win.showInactive();
    } else {
      win.show();
    }
    return win.isVisible();
  }, headless);
  if (!visible) {
    throw new Error('Electron test window could not be made visible after renderer reload');
  }
}

export async function setAppWindowVisibility(
  app: ElectronApplication,
  page: Page,
  visible: boolean,
): Promise<void> {
  const { headless, platform } = await getElectronTestRuntime(app);

  if (platform === 'darwin') {
    const browserWindow = await app.browserWindow(page);
    if (visible) {
      await app.evaluate(async ({ app: electronApp }, showWithoutActivation) => {
        electronApp.show();
        if (!showWithoutActivation) electronApp.focus({ steal: true });
        const deadline = Date.now() + 2_000;
        while (electronApp.isHidden() && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        if (electronApp.isHidden()) {
          throw new Error('Electron application did not finish showing');
        }
      }, headless);
      await browserWindow.evaluate((win, showWithoutActivation) => {
        if (win.isMinimized()) win.restore();
        // The production visibility watchdog covers the macOS case where
        // app.show() changes native state without a BrowserWindow event.
        if (showWithoutActivation) {
          win.showInactive();
        } else {
          win.show();
          win.focus();
        }
      }, headless);
    } else {
      await browserWindow.evaluate((win) => win.hide());
      await app.evaluate(async ({ app: electronApp }) => {
        electronApp.hide();
        const deadline = Date.now() + 2_000;
        while (!electronApp.isHidden() && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        if (!electronApp.isHidden()) {
          throw new Error('Electron application did not finish hiding');
        }
      });
    }
    return;
  }

  const browserWindow = await app.browserWindow(page);
  await browserWindow.evaluate((win, shouldShow) => {
    if (shouldShow) {
      if (win.isMinimized()) win.restore();
      win.show();
      return;
    }
    win.hide();
  }, visible);
}

export async function waitForAppReady(page: Page, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastState: AppBootState | null = null;

  while (Date.now() < deadline) {
    lastState = await page.evaluate(
      (channel) => (window as unknown as {
        aumx: { invoke: <T>(ipcChannel: string) => Promise<T> };
      }).aumx.invoke<AppBootState>(channel),
      IPC.APP_BOOT_STATE_GET,
    );
    if (lastState.phase === 'ready') return;
    if (lastState.phase === 'blocked') {
      throw new Error(`Application startup blocked: ${lastState.errors.join('; ')}`);
    }
    if (lastState.phase === 'failed') {
      throw new Error(`Application startup failed: ${lastState.message}`);
    }
    await page.waitForTimeout(100);
  }

  throw new Error(
    `Application did not become ready within ${timeoutMs} ms (last phase: ${lastState?.phase ?? 'unknown'})`,
  );
}

export async function waitForRendererPaneHydration(
  page: Page,
  timeoutMs = 30_000,
): Promise<void> {
  await pollUntil(
    () => page.evaluate(() => {
      const store = (window as unknown as {
        __aumxStores?: {
          pane?: { getState: () => { loaded?: boolean } };
        };
      }).__aumxStores?.pane;
      return store?.getState().loaded === true ? true : null;
    }),
    { interval: 50, label: 'renderer-pane-hydration', timeout: timeoutMs },
  );
}

export async function pollUntil<T>(
  fn: () => Promise<T>,
  opts: { timeout: number; interval?: number; label?: string },
): Promise<T> {
  const { timeout, interval = 3000, label = 'pollUntil' } = opts;
  const deadline = Date.now() + timeout;
  let lastError: Error | null = null;

  while (Date.now() < deadline) {
    try {
      const result = await fn();
      if (result !== null && result !== undefined && result !== false) return result;
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e));
    }
    await new Promise((r) => setTimeout(r, interval));
  }

  throw new Error(
    `${label}: timed out after ${timeout}ms${lastError ? ` — last error: ${lastError.message}` : ''}`,
  );
}

export async function getPanes(page: Page): Promise<AumxPane[]> {
  return page.evaluate(() => (window as any).aumx.invoke('pane:list'));
}

export async function getGitDiff(page: Page, worktreePath: string): Promise<GitDiffResponse> {
  return page.evaluate(
    (path) => (window as any).aumx.invoke('git:diff', { worktreePath: path }),
    worktreePath,
  );
}

export async function getSystemCheck(page: Page): Promise<SystemCheckResult> {
  return page.evaluate(() => (window as any).aumx.invoke('system:check'));
}

export async function getSessionInfo(page: Page): Promise<SessionInfoResult> {
  return page.evaluate(() => (window as any).aumx.invoke('session:info'));
}

export function killMultiPaneTestSessionBestEffort(sessionName: string): boolean {
  if (!sessionName.startsWith('aumx-aumx-multi-pane-e2e-')) return false;

  try {
    execFileSync('tmux', ['kill-session', '-t', sessionName], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export async function closePaneBestEffort(
  page: Page,
  pane: { id: string; paneId: string; worktreePath?: string },
): Promise<void> {
  let worktreeCleanupRequested = false;
  try {
    const result: any = await page.evaluate(
      (id) => (window as any).aumx.invoke('pane:close', { paneId: id }),
      pane.id,
    );
    if (result?.callbackId) {
      if (result.type === 'choice') {
        const options: Array<{ id: string; default?: boolean }> = result.options ?? [];
        const cleanupChoice =
          ['kill_clean_branch', 'kill_and_clean', 'kill_only']
            .find((id) => options.some((o) => o.id === id)) ??
          options.find((o) => o.default)?.id ??
          options[0]?.id;
        worktreeCleanupRequested =
          cleanupChoice === 'kill_clean_branch' || cleanupChoice === 'kill_and_clean';
        await page.evaluate(
          ({ cbId, value }) =>
            (window as any).aumx.invoke('action:callback', { callbackId: cbId, value }),
          { cbId: result.callbackId, value: cleanupChoice },
        );
      } else if (result.type === 'confirm') {
        await page.evaluate(
          (cbId) =>
            (window as any).aumx.invoke('action:callback', { callbackId: cbId, value: 'confirm' }),
          result.callbackId,
        );
      }
    }
  } catch {
    await page.evaluate(
      (id) => (window as any).aumx.invoke('pane:send-keys', { paneId: id, command: 'exit' }),
      pane.id,
    ).catch(() => {});
  }

  // Worktree removal is intentionally asynchronous in production so closing a
  // pane stays responsive. E2E teardown must wait for that background job
  // before terminating Electron, otherwise the process can die mid-cleanup.
  if (worktreeCleanupRequested && pane.worktreePath) {
    await pollUntil(
      async () => !existsSync(pane.worktreePath),
      { interval: 100, label: `worktree-cleanup(${pane.id})`, timeout: 10_000 },
    ).catch(() => {});
  }
}

export async function sendFollowUpToPane(
  page: Page,
  paneId: string,
  text: string,
): Promise<void> {
  const result: { error?: string } | undefined = await page.evaluate(
    ({ id, cmd }) => (window as any).aumx.invoke('pane:send-keys', { paneId: id, command: cmd }),
    { id: paneId, cmd: text },
  );
  if (result?.error) {
    throw new Error(`pane:send-keys failed for ${paneId}: ${result.error}`);
  }
}

export async function waitForFileContentChange(
  filePath: string,
  baseline: FileBaseline,
  contentMustInclude: RegExp[],
  timeout: number,
  interval = 1000,
): Promise<FileSnapshot> {
  const deadline = Date.now() + timeout;
  let lastReason = 'file did not appear';
  while (Date.now() < deadline) {
    if (existsSync(filePath)) {
      const st = statSync(filePath);
      const content = readFileSync(filePath, 'utf-8');
      const grew = st.size !== baseline.size || st.mtimeMs > baseline.mtimeMs;
      const missingPatterns = contentMustInclude.filter((p) => !p.test(content));
      if (grew && missingPatterns.length === 0) {
        return { size: st.size, mtimeMs: st.mtimeMs, content };
      }
      lastReason = grew
        ? `missing patterns: ${missingPatterns.map((p) => p.source).join(', ')}`
        : `size=${st.size} mtime=${st.mtimeMs} unchanged from baseline`;
    }
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error(
    `waitForFileContentChange(${filePath}): timed out after ${timeout}ms — ${lastReason}`,
  );
}

export async function getNormalizedSession(
  page: Page,
  paneId: string,
): Promise<NormalizedSession | null> {
  const result: { session?: NormalizedSession; error?: string } | undefined = await page.evaluate(
    (id) => (window as any).aumx.invoke('agent-session:get', { paneId: id }),
    paneId,
  );
  if (!result || result.error) return null;
  return result.session ?? null;
}

export async function waitForUserMessageCount(
  page: Page,
  paneId: string,
  minCount: number,
  timeout: number,
): Promise<number> {
  return pollUntil(
    async () => {
      const session = await getNormalizedSession(page, paneId);
      if (!session) return null;
      const count = (session.messages ?? []).filter((m) => m.type === 'user').length;
      return count >= minCount ? count : null;
    },
    { timeout, interval: 2000, label: `waitForUserMessageCount(${paneId} >= ${minCount})` },
  );
}
