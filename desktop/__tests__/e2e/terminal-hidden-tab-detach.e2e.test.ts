import type { MuxBasePane } from 'muxbase/core';
import { execFileSync, spawnSync } from 'child_process';
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { basename, join, resolve } from 'path';
import { _electron as electron } from 'playwright';
import type { ElectronApplication, Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { IPC } from '../../src/shared/ipc-channels';
import type { PaneCreateResponse, SessionInfoResult } from '../../src/shared/ipc-types';
import { closeElectronApp, closePaneBestEffort, getAppWindow, pollUntil } from './e2e-helpers';

const ROOT = resolve(__dirname, '..', '..');
const MAIN_ENTRY = resolve(ROOT, 'out', 'main', 'index.js');
const APP_STARTUP_TIMEOUT_MS = 30_000;
const APP_SHUTDOWN_TIMEOUT_MS = 30_000;
const TERMINAL_TIMEOUT_MS = 15_000;
const TEST_TIMEOUT_MS = 60_000;
// Must exceed HIDDEN_DETACH_DELAY_MS in InteractiveTerminal.
const DETACH_GRACE_MARGIN_MS = 3_200;

interface TerminalStoreState {
  attachedPaneIds: Set<string>;
}

interface PaneStoreState {
  panes: MuxBasePane[];
  selectPane: (paneId: string | null) => void;
  setPanes: (panes: MuxBasePane[]) => void;
}

interface UiStoreState {
  setActiveView: (view: 'dashboard' | 'settings') => void;
  setViewMode: (mode: 'fleet' | 'focus' | 'kanban' | 'conflict-resolution') => void;
}

interface E2EWindow {
  __MUXBASE_E2E?: boolean;
  __muxbaseStores?: {
    pane?: { getState: () => PaneStoreState };
    terminal?: { getState: () => TerminalStoreState };
    ui?: { getState: () => UiStoreState };
  };
  __muxbaseTerminalDebug?: {
    getViewportInfo: (paneId: string) => { cols: number; length: number; rows: number } | null;
    getVisibleLines: (paneId: string, count: number) => string[];
  };
  muxbase: { invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
}

function killTmuxSession(sessionName: string): void {
  spawnSync('tmux', ['kill-session', '-t', sessionName], { stdio: 'ignore' });
}

async function invoke<T>(page: Page, channel: string, request?: unknown): Promise<T> {
  const args = request === undefined ? [] : [request];
  return page.evaluate(
    async ({ ipcArgs, ipcChannel }) => {
      const e2eWindow = window as unknown as E2EWindow;
      return e2eWindow.muxbase.invoke(ipcChannel, ...ipcArgs);
    },
    { ipcArgs: args, ipcChannel: channel },
  ) as Promise<T>;
}

async function isPaneAttached(page: Page, paneId: string): Promise<boolean> {
  return page.evaluate((id) => {
    const stores = (window as unknown as E2EWindow).__muxbaseStores;
    return stores?.terminal?.getState().attachedPaneIds.has(id) ?? false;
  }, paneId);
}

async function waitForAttachState(page: Page, paneId: string, attached: boolean): Promise<void> {
  await pollUntil(
    async () => ((await isPaneAttached(page, paneId)) === attached ? true : null),
    {
      interval: 100,
      label: `terminal-${attached ? 'attached' : 'detached'}(${paneId})`,
      timeout: TERMINAL_TIMEOUT_MS,
    },
  );
}

async function showFleetPane(page: Page, panes: MuxBasePane[], paneId: string): Promise<void> {
  await page.evaluate(({ nextPanes, selectedId }) => {
    const stores = (window as unknown as E2EWindow).__muxbaseStores;
    stores?.pane?.getState().setPanes(nextPanes);
    stores?.ui?.getState().setActiveView('dashboard');
    stores?.ui?.getState().setViewMode('fleet');
    stores?.pane?.getState().selectPane(selectedId);
  }, { nextPanes: panes, selectedId: paneId });
  await page
    .locator(`[data-testid="interactive-terminal"][data-pane-id="${paneId}"] .xterm-screen`)
    .waitFor({ state: 'visible', timeout: TERMINAL_TIMEOUT_MS });
}

async function clickPaneTab(page: Page, paneId: string, label: string): Promise<void> {
  await page
    .locator(`[data-testid="pane-cell"][data-pane-id="${paneId}"]`)
    .first()
    .locator(`button[role="tab"][aria-label="${label}"]`)
    .first()
    .click();
}

describe.runIf(process.env.MUXBASE_E2E === '1')('Hidden pane tab terminal detach E2E', () => {
  let app: ElectronApplication;
  let page: Page;
  let projectRoot: string;
  let sessionName: string;
  let pane: MuxBasePane;

  beforeAll(async () => {
    expect(existsSync(MAIN_ENTRY), `Build output missing: ${MAIN_ENTRY}`).toBe(true);
    projectRoot = realpathSync(mkdtempSync(join(tmpdir(), 'muxbase-hidden-tab-e2e-')));
    execFileSync('git', ['init'], { cwd: projectRoot, stdio: 'ignore' });
    sessionName = `muxbase-${basename(projectRoot)}`;
    killTmuxSession(sessionName);

    app = await electron.launch({
      args: [MAIN_ENTRY],
      cwd: projectRoot,
      env: { ...process.env, MUXBASE_DEV: 'true', MUXBASE_E2E: '1', NODE_ENV: 'test' },
    });

    page = await getAppWindow(app);
    await app.context().addInitScript(() => {
      (window as unknown as E2EWindow).__MUXBASE_E2E = true;
    });
    await page.reload();
    await page.setViewportSize({ height: 980, width: 1440 });
    await page.locator('[data-testid="app-shell"]').waitFor({ state: 'visible', timeout: 15_000 });

    const session = await invoke<SessionInfoResult>(page, IPC.SESSION_INFO);
    sessionName = session.sessionName;

    const response = await invoke<PaneCreateResponse>(page, IPC.PANE_CREATE, {
      prompt: '',
      type: 'shell',
    });
    expect(response.success, response.error).toBe(true);
    pane = response.pane!;
  }, APP_STARTUP_TIMEOUT_MS);

  afterAll(async () => {
    if (pane) await closePaneBestEffort(page, pane);
    if (app) await closeElectronApp(app);
    if (sessionName) killTmuxSession(sessionName);
    if (projectRoot) rmSync(projectRoot, { force: true, recursive: true });
  }, APP_SHUTDOWN_TIMEOUT_MS);

  it('detaches a hidden pane terminal and restores it on the tab round-trip', async () => {
    // Arrange
    await showFleetPane(page, [pane], pane.id);
    await waitForAttachState(page, pane.id, true);

    // Act: switch to a non-terminal tab and wait past the detach grace period.
    await clickPaneTab(page, pane.id, 'Diff');
    await waitForAttachState(page, pane.id, false);

    // Assert: the stream is released, not merely hidden.
    const detachedViewport = await page.evaluate(
      (id) => (window as unknown as E2EWindow).__muxbaseTerminalDebug?.getViewportInfo(id) ?? null,
      pane.id,
    );
    expect(detachedViewport).toBeNull();

    // Act: return to the terminal tab.
    await clickPaneTab(page, pane.id, 'Terminal');
    await waitForAttachState(page, pane.id, true);

    // Assert: a live terminal renders again.
    await page
      .locator(`[data-testid="interactive-terminal"][data-pane-id="${pane.id}"] .xterm-screen`)
      .waitFor({ state: 'visible', timeout: TERMINAL_TIMEOUT_MS });
    const reattachedViewport = await pollUntil(
      async () => page.evaluate(
        (id) => (window as unknown as E2EWindow).__muxbaseTerminalDebug?.getViewportInfo(id) ?? null,
        pane.id,
      ),
      { interval: 100, label: `terminal-viewport(${pane.id})`, timeout: TERMINAL_TIMEOUT_MS },
    );
    expect(reattachedViewport.cols).toBeGreaterThan(0);
    expect(reattachedViewport.rows).toBeGreaterThan(0);
  }, TEST_TIMEOUT_MS);

  it('keeps the terminal attached across a fast tab round-trip', async () => {
    // Arrange
    await showFleetPane(page, [pane], pane.id);
    await waitForAttachState(page, pane.id, true);

    // Act: leave and return well inside the detach grace period.
    await clickPaneTab(page, pane.id, 'Diff');
    await clickPaneTab(page, pane.id, 'Terminal');
    await page.waitForTimeout(DETACH_GRACE_MARGIN_MS);

    // Assert
    expect(await isPaneAttached(page, pane.id)).toBe(true);
  }, TEST_TIMEOUT_MS);
});
