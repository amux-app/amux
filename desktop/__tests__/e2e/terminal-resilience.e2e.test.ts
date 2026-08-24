import {
  atomicWriteJsonSync,
  getProjectConfigPath,
  type AgentStatus,
  type AumxConfig,
  type AumxPane,
} from 'aumx/core';
import { execFileSync, spawnSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { basename, join, resolve } from 'path';
import { _electron as electron } from 'playwright';
import type { ElectronApplication, Locator, Page } from 'playwright';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, onTestFinished } from 'vitest';
import { makeTerminalPtyViewSessionName } from '../../src/main/services/terminal-pty-session';
import { SIDEBAR_PANEL_ID } from '../../src/renderer/components/layout/sidebarLayout';
import { MIN_FLEET_PANE_WIDTH_PX } from '../../src/renderer/hooks/usePanelLayout';
import { IPC } from '../../src/shared/ipc-channels';
import type {
  PaneCreateResponse,
  SessionInfoResult,
  TerminalAttachResponse,
  TerminalTransportMode,
} from '../../src/shared/ipc-types';
import type { PaneActivity } from '../../src/shared/pane-activity';
import { makeActivity } from '../helpers/pane-activity-fixtures';
import {
  closeElectronApp,
  ensureAppWindowVisible,
  getAppWindow,
  pollUntil,
  setAppWindowVisibility,
  waitForAppReady,
  waitForRendererPaneHydration,
} from './e2e-helpers';

const ROOT = resolve(__dirname, '..', '..');
const MAIN_ENTRY = resolve(ROOT, 'out', 'main', 'index.js');
const MOUSE_REPORTING_TUI_FIXTURE = resolve(__dirname, 'fixtures', 'mouse-reporting-tui.cjs');
const APP_EXECUTABLE_PATH = process.env.AUMX_E2E_EXECUTABLE_PATH;
const SCREENSHOTS_DIR = resolve(ROOT, 'out', 'e2e-terminal-resilience');
const APP_STARTUP_TIMEOUT_MS = 30_000;
const APP_SHUTDOWN_TIMEOUT_MS = 30_000;
const TERMINAL_TIMEOUT_MS = 15_000;
const TERMINAL_GEOMETRY_TIMEOUT_MS = 30_000;
const SCROLLBACK_DONE_MARKER = 'AUMX-SCROLLBACK-DONE';
const SCROLLBACK_FIRST_LINE = 'AUMX-SCROLLBACK-LINE-001';
const OLD_PROJECT_BOTTOM_MARKER = 'AUMX-OLD-PROJECT-BOTTOM';
const OLD_PROJECT_LAUNCH_MARKER = 'AUMX_PROMPT_CONTENT=dirty-startup-command';
const ATTENTION_STAT = '[data-testid="resource-attention-stat"]';
const ATTENTION_PEEK = '[role="menu"][aria-label="Waiting agents"]';
const COMMAND_PALETTE = '[role="dialog"][aria-label="Command palette"]';
// A Fleet drag stops dead at the Panel minimum, so every requested leg stays
// this far inside the measured headroom instead of silently clamping.
const DUEL_DRAG_CLAMP_MARGIN_PX = 8;
// Below this the pane barely changes width and the adaptive font never moves.
const MIN_DUEL_DRAG_TRAVEL_PX = 200;
// Panel widths are committed through rounded pixels, so travel lands a hair off.
const RESIZE_TRAVEL_TOLERANCE_PX = 2;

interface AumxStoreApi<TState> {
  getState: () => TState;
}

interface WritableAumxStoreApi<TState> extends AumxStoreApi<TState> {
  setState: (partial: Partial<TState>) => void;
}

interface PaneStoreState {
  panes: AumxPane[];
  selectedPaneId: string | null;
  selectPane: (paneId: string | null) => void;
  setPanes: (panes: AumxPane[]) => void;
  updatePaneStatus: (paneId: string, status: AgentStatus) => void;
}

interface UiStoreState {
  focusPane: (paneId: string) => void;
  setActiveView: (view: 'dashboard' | 'settings') => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  setViewMode: (mode: 'fleet' | 'focus' | 'kanban' | 'conflict-resolution') => void;
}

interface PaneActivityStoreState {
  activityByPaneId: Record<string, PaneActivity>;
}

interface E2EStores {
  pane?: AumxStoreApi<PaneStoreState>;
  paneActivity?: WritableAumxStoreApi<PaneActivityStoreState>;
  ui?: AumxStoreApi<UiStoreState>;
}

interface TerminalDebugInfo {
  attachHistory: Array<{ action: 'attach-start' | 'attach-success' | 'detach' }>;
  baseY: number;
  cols?: number;
  length: number;
  rows?: number;
  selectionPosition: {
    end: { x: number; y: number };
    start: { x: number; y: number };
  } | null;
  viewportY: number;
  wheelHistory: Array<{
    consumedBy: 'agent-input' | 'native-scroll' | 'none' | 'suppress' | 'tmux-scroll';
    defaultPrevented: boolean;
    deltaY: number;
    selectionOwner?: 'application' | 'pending' | 'terminal';
    selectionAccumulatedLength?: number;
    selectionAnchorLength?: number;
    selectionRangeComplete?: boolean;
    selectionRangeVerified?: boolean;
    selectionTextLength?: number;
  }>;
}

interface TerminalDebugApi {
  getFontSize: (paneId: string) => number | null;
  getLines: (paneId: string, startRow: number, count: number) => string[];
  getViewportInfo: (paneId: string) => TerminalDebugInfo | null;
  getVisibleLines: (paneId: string, count: number) => string[];
}

interface E2EWindow {
  __AUMX_E2E?: boolean;
  __aumxStores?: E2EStores;
  __aumxTerminalDebug?: TerminalDebugApi;
  aumx: {
    invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
  };
}

interface DuelPairGeometry {
  headroom: number;
  pairWidth: number;
  resizingPanelWidth: number;
  separatorWidth: number;
  sidebarWidth: number;
  spacerPanelWidth: number;
}

interface TerminalSnapshot {
  info: TerminalDebugInfo;
  lines: string[];
  visibleLines: string[];
}

interface TerminalLayoutMetrics {
  backgroundColor: string;
  fitContainerWidth: number;
  rootHeight: number;
  rootWidth: number;
  screenBottomOverflow: number;
  screenRightOverflow: number;
  screenWidth: number;
  screenTopInset: number;
  verticalScrollbarWidth: number;
  xtermHorizontalPadding: number;
}

interface TerminalScreenRaster extends TerminalCanvasInkMetrics {
  dataUrl: string;
}

interface TerminalCanvasInkMetrics {
  greenPixels: number;
  height: number;
  inkPixels: number;
  width: number;
}

interface TerminalCanvasMaskComparison {
  greenIntersectionPixels: number;
  greenIntersectionOverUnion: number;
  greenUnionPixels: number;
}

interface TmuxPaneSize {
  cols: number;
  rows: number;
}

interface DeterministicTerminalProfile {
  agent?: AumxPane['agent'];
  claudeRenderer?: AumxPane['claudeRenderer'];
  fixedCols?: number;
}

function runTmux(args: string[], cwd?: string): string {
  return execFileSync('tmux', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function killTmuxSession(sessionName: string): void {
  spawnSync('tmux', ['kill-session', '-t', sessionName], { stdio: 'ignore' });
}

function killTmuxPaneWindow(tmuxPaneId: string): void {
  const windowId = runTmux(['display-message', '-p', '-t', tmuxPaneId, '#{window_id}']).trim();
  runTmux(['kill-window', '-t', windowId]);
}

function listSessionTmuxPaneIds(sessionName: string): string[] {
  return runTmux(['list-panes', '-s', '-t', `=${sessionName}`, '-F', '#{pane_id}'])
    .split('\n')
    .map((paneId) => paneId.trim())
    .filter(Boolean)
    .sort();
}

function terminalSelector(paneId: string): string {
  return `[data-testid="interactive-terminal"][data-pane-id="${paneId}"]`;
}

async function invoke<T>(page: Page, channel: string, request?: unknown): Promise<T> {
  const args = request === undefined ? [] : [request];
  return page.evaluate(
    async ({ ipcChannel, ipcArgs }) => {
      const e2eWindow = window as unknown as E2EWindow;
      return e2eWindow.aumx.invoke(ipcChannel, ...ipcArgs);
    },
    { ipcArgs: args, ipcChannel: channel },
  ) as Promise<T>;
}

async function getPanes(page: Page): Promise<AumxPane[]> {
  return invoke<AumxPane[]>(page, IPC.PANE_LIST);
}

async function syncRendererPanes(page: Page): Promise<AumxPane[]> {
  const panes = await getPanes(page);
  await page.evaluate((nextPanes) => {
    const e2eWindow = window as unknown as E2EWindow;
    e2eWindow.__aumxStores?.pane?.getState().setPanes(nextPanes);
  }, panes);
  return panes;
}

// A missing element must not read as a zero width: the collapsed-sidebar wait and
// the layout precondition both treat 0 as success, so silence would pass them.
async function measureElementWidth(page: Page, elementId: string): Promise<number> {
  return page.evaluate((id) => {
    const element = document.getElementById(id);
    if (!element) throw new Error(`no element #${id} to measure`);
    return element.getBoundingClientRect().width;
  }, elementId);
}

// Terminal geometry is measured against the content area, so the sidebar is
// parked closed after every (re)load instead of eating its default width. The
// column animates to zero, so the collapse is only settled once it measures 0.
async function collapseSidebar(page: Page): Promise<void> {
  await page.evaluate(() => {
    const ui = (window as unknown as E2EWindow).__aumxStores?.ui;
    if (!ui) throw new Error('renderer exposed no ui store, so the sidebar cannot be collapsed');
    ui.getState().setSidebarCollapsed(true);
  });
  await pollUntil(
    async () => {
      const width = await measureElementWidth(page, SIDEBAR_PANEL_ID);
      if (width === 0) return true;
      throw new Error(`sidebar column still measures ${width}px`);
    },
    { interval: 50, label: 'sidebar-collapsed', timeout: TERMINAL_TIMEOUT_MS },
  );
}

async function setTerminalTransport(
  app: ElectronApplication,
  page: Page,
  terminalTransport: TerminalTransportMode,
): Promise<void> {
  await invoke(page, IPC.ELECTRON_SETTINGS_UPDATE, {
    key: 'terminalTransport',
    value: terminalTransport,
  });
  await page.reload();
  await ensureAppWindowVisible(app);
  await page.setViewportSize({ height: 980, width: 1440 });
  await page.locator('[data-testid="app-shell"]').waitFor({ state: 'visible', timeout: 15_000 });
  await waitForRendererPaneHydration(page);
  await collapseSidebar(page);
}

async function createShellPane(
  page: Page,
  createdPanes: AumxPane[],
  options: { waitForCommandReady?: boolean } = {},
): Promise<AumxPane> {
  const response = await invoke<PaneCreateResponse>(page, IPC.PANE_CREATE, {
    prompt: '',
    type: 'shell',
  });

  expect(response.success, response.error).toBe(true);
  expect(response.pane).toBeDefined();
  const pane = response.pane!;
  createdPanes.push(pane);
  await syncRendererPanes(page);

  if (options.waitForCommandReady === false) return pane;

  await pollUntil(
    async () => {
      const attached = await page.evaluate((paneId) => {
        const info = (window as unknown as E2EWindow).__aumxTerminalDebug?.getViewportInfo(paneId);
        return info?.attachHistory.some((event) => event.action === 'attach-success') ?? false;
      }, pane.id);
      return attached ? true : null;
    },
    { interval: 50, label: `shell-pane-terminal-attached(${pane.id})`, timeout: TERMINAL_TIMEOUT_MS },
  );

  await pollUntil(
    async () => {
      const ready = await invoke<{ error?: string; success: boolean }>(page, IPC.PANE_SEND_KEYS, {
        command: ':',
        paneId: pane.id,
      });
      if (ready.success) return true;
      if (ready.error?.includes('Terminal input is locked')) return null;
      throw new Error(ready.error || `Pane ${pane.id} rejected its readiness command`);
    },
    { interval: 50, label: `shell-pane-command-ready(${pane.id})`, timeout: TERMINAL_TIMEOUT_MS },
  );
  return pane;
}

async function collectFailureDiagnostics(
  page: Page,
  sessionName: string,
  baselinePaneIds: readonly string[],
  baselineTmuxPaneIds: readonly string[],
  ownedPanes: readonly AumxPane[],
): Promise<Record<string, unknown>> {
  let tmuxSessions = '';
  let tmuxPanes = '';
  try {
    tmuxSessions = runTmux([
      'list-sessions',
      '-F',
      '#{session_name}|attached=#{session_attached}|windows=#{session_windows}|view=#{@aumx_view_session}',
    ]);
    tmuxPanes = runTmux([
      'list-panes',
      '-a',
      '-F',
      '#{session_name}|#{window_id}|#{pane_id}|dead=#{pane_dead}|cmd=#{pane_current_command}|title=#{pane_title}',
    ]);
  } catch (error) {
    tmuxSessions = `unavailable: ${error instanceof Error ? error.message : String(error)}`;
  }

  let rendererState: unknown = 'unavailable';
  if (!page.isClosed()) {
    rendererState = await page.evaluate(() => {
      const e2eWindow = window as unknown as E2EWindow;
      const paneState = e2eWindow.__aumxStores?.pane?.getState();
      const paneIds = paneState?.panes.map((pane) => pane.id) ?? [];
      return {
        paneIds,
        selectedPaneId: paneState?.selectedPaneId ?? null,
        terminalStreams: paneIds.map((paneId) => ({
          paneId,
          viewport: e2eWindow.__aumxTerminalDebug?.getViewportInfo(paneId) ?? null,
        })),
      };
    });
  }

  return {
    baselinePaneIds,
    baselineTmuxPaneIds,
    expectedSession: sessionName,
    ownedPanes: ownedPanes.map((pane) => ({ id: pane.id, tmuxPaneId: pane.paneId })),
    rendererState,
    tmuxPanes,
    tmuxSessions,
  };
}

async function closePaneBestEffort(page: Page, pane: AumxPane): Promise<void> {
  if (!pane.id) return;
  try {
    await invoke(page, IPC.PANE_CLOSE, { paneId: pane.id });
  } catch {
  }
  if (pane.paneId) {
    try {
      runTmux(['kill-pane', '-t', pane.paneId]);
    } catch {
    }
  }
}

async function waitForConfigQuiescence(
  page: Page,
  configPath: string,
  expectedPaneIds: readonly string[],
): Promise<void> {
  const expectedIds = [...expectedPaneIds].sort();
  await pollUntil(
    async () => {
      const stats = statSync(configPath);
      if (Date.now() - stats.mtimeMs < 250) return null;

      const persisted = JSON.parse(readFileSync(configPath, 'utf8')) as AumxConfig;
      const persistedIds = persisted.panes.map((pane) => pane.id).sort();
      const backendIds = (await getPanes(page)).map((pane) => pane.id).sort();
      return JSON.stringify(persistedIds) === JSON.stringify(expectedIds)
        && JSON.stringify(backendIds) === JSON.stringify(expectedIds)
        ? true
        : null;
    },
    { interval: 50, label: 'config-quiescence', timeout: TERMINAL_TIMEOUT_MS },
  );
}

async function focusPane(page: Page, paneId: string): Promise<void> {
  await syncRendererPanes(page);
  await page.evaluate((id) => {
    const stores = (window as unknown as E2EWindow).__aumxStores;
    stores?.ui?.getState().setActiveView('dashboard');
    stores?.pane?.getState().selectPane(id);
    stores?.ui?.getState().focusPane(id);
  }, paneId);
  await page.locator(`${terminalSelector(paneId)} .xterm-screen`).waitFor({
    state: 'visible',
    timeout: TERMINAL_TIMEOUT_MS,
  });
}

async function setRendererPaneStatus(
  page: Page,
  paneIds: readonly string[],
  status: AgentStatus,
): Promise<void> {
  await page.evaluate(({ ids, nextStatus }) => {
    const paneStore = (window as unknown as E2EWindow).__aumxStores?.pane?.getState();
    for (const id of ids) paneStore?.updatePaneStatus(id, nextStatus);
  }, { ids: [...paneIds], nextStatus: status });
}

async function focusedTerminalPaneId(page: Page): Promise<string | null> {
  return page.evaluate(() => (
    document.activeElement?.closest('[data-testid="interactive-terminal"]')?.getAttribute('data-pane-id') ?? null
  ));
}

async function clickTerminalAndWaitForFocus(page: Page, paneId: string): Promise<void> {
  await page.locator(`${terminalSelector(paneId)} .xterm-screen`).click();
  await pollUntil(
    async () => ((await focusedTerminalPaneId(page)) === paneId ? true : null),
    { interval: 50, label: `terminal-focused(${paneId})`, timeout: TERMINAL_TIMEOUT_MS },
  );
}

async function cycleOverlay(page: Page, open: () => Promise<void>, selector: string): Promise<void> {
  await open();
  await page.locator(selector).waitFor({ state: 'visible', timeout: TERMINAL_TIMEOUT_MS });
  await page.keyboard.press('Escape');
  await page.locator(selector).waitFor({ state: 'detached', timeout: TERMINAL_TIMEOUT_MS });
}

async function showDashboardMode(page: Page, mode: 'fleet' | 'settings'): Promise<void> {
  await page.evaluate((nextMode) => {
    const ui = (window as unknown as E2EWindow).__aumxStores?.ui?.getState();
    if (nextMode === 'settings') {
      ui?.setActiveView('settings');
      return;
    }
    ui?.setActiveView('dashboard');
    ui?.setViewMode('fleet');
  }, mode);
}

async function switchPaneTab(page: Page, paneId: string, label: string): Promise<void> {
  const cell = page.locator(`[data-testid="pane-cell"][data-pane-id="${paneId}"]`).first();
  await cell.locator(`button[role="tab"]:has-text("${label}")`).first().click();
}

async function screenshot(page: Page, name: string): Promise<string> {
  mkdirSync(SCREENSHOTS_DIR, { recursive: true });
  const path = resolve(SCREENSHOTS_DIR, `${name}.png`);
  const buffer = await page.screenshot({ path });
  expect(existsSync(path)).toBe(true);
  expect(buffer.length).toBeGreaterThan(20_000);
  return path;
}

async function waitForTmuxContent(tmuxPaneId: string, needle: string): Promise<string> {
  return pollUntil(
    async () => {
      const content = runTmux(['capture-pane', '-t', tmuxPaneId, '-p', '-S', '-240']);
      return content.includes(needle) ? content : null;
    },
    { interval: 250, label: 'tmux-content', timeout: TERMINAL_TIMEOUT_MS },
  );
}

function widthProbeCommand(marker: string): string {
  const script = [
    `const marker=${JSON.stringify(marker)};`,
    'const cols=process.stdout.columns||0;',
    'const width=Math.max(1,cols);',
    'console.log(marker+"-COLS="+cols);',
    'console.log(marker+"-TABLE-"+"=".repeat(width));',
  ].join('');
  return `node -e ${JSON.stringify(script)}`;
}

function extractProbeCols(content: string, marker: string): number {
  const match = content.match(new RegExp(`${marker}-COLS=(\\d+)`));
  if (!match) throw new Error(`missing width probe marker ${marker}`);
  return Number.parseInt(match[1], 10);
}

function readTmuxPaneSize(tmuxPaneId: string): TmuxPaneSize {
  const raw = runTmux(['display-message', '-p', '-t', tmuxPaneId, '#{pane_width}x#{pane_height}']).trim();
  const match = raw.match(/^(\d+)x(\d+)$/);
  if (!match) throw new Error(`invalid tmux pane size for ${tmuxPaneId}: ${raw}`);
  return {
    cols: Number.parseInt(match[1], 10),
    rows: Number.parseInt(match[2], 10),
  };
}

async function getTerminalSnapshot(page: Page, paneId: string): Promise<TerminalSnapshot | null> {
  return page.evaluate((id) => {
    const debug = (window as unknown as E2EWindow).__aumxTerminalDebug;
    const info = debug?.getViewportInfo(id);
    if (!debug || !info) return null;
    const lines = debug.getLines(id, 0, Math.min(info.length, 260));
    const visibleLines = debug.getVisibleLines(id, 120);
    return { info, lines, visibleLines };
  }, paneId);
}

async function getTerminalFontSize(page: Page, paneId: string): Promise<number | null> {
  return page.evaluate(
    (id) => (window as unknown as E2EWindow).__aumxTerminalDebug?.getFontSize(id) ?? null,
    paneId,
  );
}

async function hasTerminalWebglRenderer(page: Page, paneId: string): Promise<boolean> {
  return page.evaluate((selector) => {
    const root = document.querySelector(`${selector} .xterm-screen`);
    if (!(root instanceof HTMLElement)) return false;
    const canvas = Array.from(root.querySelectorAll('canvas')).find((candidate) => !candidate.className);
    return canvas instanceof HTMLCanvasElement && canvas.getContext('webgl2') !== null;
  }, terminalSelector(paneId));
}

async function waitForSeededScrollback(page: Page, paneId: string): Promise<TerminalSnapshot> {
  const deadline = Date.now() + TERMINAL_TIMEOUT_MS;
  let lastSnapshot: TerminalSnapshot | null = null;

  while (Date.now() < deadline) {
    const snapshot = await getTerminalSnapshot(page, paneId);
    if (snapshot) {
      lastSnapshot = snapshot;
      const text = snapshot.lines.join('\n');
      const seeded = snapshot.info.baseY > 0
        && text.includes(SCROLLBACK_FIRST_LINE);
      if (seeded) return snapshot;
    }
    await page.waitForTimeout(250);
  }

  const info = lastSnapshot ? JSON.stringify(lastSnapshot.info) : 'no terminal snapshot';
  const sample = lastSnapshot?.lines.slice(0, 30).join(' | ') ?? '';
  throw new Error(`seeded-terminal-scrollback: timed out after ${TERMINAL_TIMEOUT_MS}ms (${info}) ${sample}`);
}

async function waitForVisibleTerminalText(
  page: Page,
  paneId: string,
  expected: string,
): Promise<TerminalSnapshot> {
  const deadline = Date.now() + TERMINAL_TIMEOUT_MS;
  let lastSnapshot: TerminalSnapshot | null = null;

  while (Date.now() < deadline) {
    const snapshot = await getTerminalSnapshot(page, paneId);
    if (snapshot) {
      lastSnapshot = snapshot;
      const text = snapshot.visibleLines.join('\n');
      if (text.includes(expected)) return snapshot;
    }
    await page.waitForTimeout(250);
  }

  const info = lastSnapshot ? JSON.stringify(lastSnapshot.info) : 'no terminal snapshot';
  const sample = lastSnapshot?.visibleLines.slice(0, 40).join(' | ') ?? '';
  throw new Error(`visible-terminal-text: missing "${expected}" after ${TERMINAL_TIMEOUT_MS}ms (${info}) ${sample}`);
}

async function continueSelectionDragUntilTextVisible(
  page: Page,
  paneId: string,
  pointer: { x: number; y: number },
  expected: string,
): Promise<TerminalSnapshot> {
  const deadline = Date.now() + TERMINAL_TIMEOUT_MS;
  let lastSnapshot: TerminalSnapshot | null = null;
  let attempt = 0;

  while (Date.now() < deadline) {
    // Chromium can stop emitting edge-drag mousemoves while the pointer is
    // stationary. A one-pixel jitter keeps the real selection auto-scroll path
    // active without synthesizing wheel input or releasing the selection.
    await page.mouse.move(pointer.x + (attempt % 2), pointer.y, { steps: 2 });
    await page.waitForTimeout(100);
    const snapshot = await getTerminalSnapshot(page, paneId);
    if (snapshot) {
      lastSnapshot = snapshot;
      if (snapshot.visibleLines.join('\n').includes(expected)) return snapshot;
    }
    attempt += 1;
  }

  const info = lastSnapshot ? JSON.stringify(lastSnapshot.info) : 'no terminal snapshot';
  const sample = lastSnapshot?.visibleLines.slice(0, 40).join(' | ') ?? '';
  throw new Error(`selection-drag: missing "${expected}" after ${TERMINAL_TIMEOUT_MS}ms (${info}) ${sample}`);
}

async function getTerminalLayoutMetrics(page: Page, paneId: string): Promise<TerminalLayoutMetrics> {
  const metrics = await page.evaluate((id) => {
    const terminals = Array.from(document.querySelectorAll('[data-testid="interactive-terminal"]'));
    const root = terminals.find((element) => element.getAttribute('data-pane-id') === id);
    if (!(root instanceof HTMLElement)) return null;
    const screen = root.querySelector('.xterm-screen');
    if (!(screen instanceof HTMLElement)) return null;
    const scrollbar = root.querySelector('.xterm-scrollable-element > .scrollbar.vertical');
    const xterm = root.querySelector('.xterm');
    if (!(scrollbar instanceof HTMLElement) || !(xterm instanceof HTMLElement)) return null;

    const rootRect = root.getBoundingClientRect();
    const screenRect = screen.getBoundingClientRect();
    const fitContainer = xterm.parentElement;
    if (!(fitContainer instanceof HTMLElement)) return null;
    const fitContainerRect = fitContainer.getBoundingClientRect();
    const xtermStyle = getComputedStyle(xterm);
    return {
      backgroundColor: getComputedStyle(root).backgroundColor,
      fitContainerWidth: fitContainerRect.width,
      rootHeight: rootRect.height,
      rootWidth: rootRect.width,
      screenBottomOverflow: screenRect.bottom - rootRect.bottom,
      screenRightOverflow: screenRect.right - fitContainerRect.right,
      screenWidth: screenRect.width,
      screenTopInset: screenRect.top - rootRect.top,
      verticalScrollbarWidth: scrollbar.getBoundingClientRect().width,
      xtermHorizontalPadding: Number.parseFloat(xtermStyle.paddingLeft)
        + Number.parseFloat(xtermStyle.paddingRight),
    };
  }, paneId);

  expect(metrics).not.toBeNull();
  if (!metrics) throw new Error(`terminal-layout: missing terminal metrics for ${paneId}`);
  return metrics;
}

async function getTerminalScreenRaster(page: Page, paneId: string): Promise<TerminalScreenRaster> {
  const screen = page.locator(`${terminalSelector(paneId)} .xterm-screen`).first();
  await screen.waitFor({ state: 'visible', timeout: TERMINAL_TIMEOUT_MS });
  const screenshot = await screen.screenshot({ animations: 'disabled' });
  const dataUrl = `data:image/png;base64,${screenshot.toString('base64')}`;
  const metrics = await page.evaluate(async (canvasDataUrl) => {
    const image = new Image();
    image.src = canvasDataUrl;
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error('terminal canvas screenshot could not be decoded'));
    });
    const copy = document.createElement('canvas');
    copy.width = image.naturalWidth;
    copy.height = image.naturalHeight;
    const context = copy.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('terminal canvas could not be sampled');
    context.drawImage(image, 0, 0);
    const pixels = context.getImageData(0, 0, copy.width, copy.height).data;
    let greenPixels = 0;
    let inkPixels = 0;
    for (let index = 0; index < pixels.length; index += 4) {
      const red = pixels[index];
      const green = pixels[index + 1];
      const blue = pixels[index + 2];
      const alpha = pixels[index + 3];
      if (alpha > 0 && (red > 24 || green > 24 || blue > 24)) inkPixels += 1;
      if (alpha > 0 && green > 100 && green > red * 1.35 && green > blue * 1.15) greenPixels += 1;
    }
    return { greenPixels, height: copy.height, inkPixels, width: copy.width };
  }, dataUrl);
  return { ...metrics, dataUrl };
}

async function compareTerminalScreenGreenMasks(
  page: Page,
  before: TerminalScreenRaster,
  after: TerminalScreenRaster,
): Promise<TerminalCanvasMaskComparison> {
  return page.evaluate(async ({ afterDataUrl, beforeDataUrl }) => {
    const decode = async (dataUrl: string): Promise<ImageData> => {
      const image = new Image();
      image.src = dataUrl;
      await new Promise<void>((resolve, reject) => {
        image.onload = () => resolve();
        image.onerror = () => reject(new Error('terminal canvas screenshot could not be decoded'));
      });
      const canvas = document.createElement('canvas');
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context) throw new Error('terminal canvas could not be sampled');
      context.drawImage(image, 0, 0);
      return context.getImageData(0, 0, canvas.width, canvas.height);
    };
    const [beforeImage, afterImage] = await Promise.all([
      decode(beforeDataUrl),
      decode(afterDataUrl),
    ]);
    const width = Math.min(beforeImage.width, afterImage.width);
    const height = Math.min(beforeImage.height, afterImage.height);
    const isGreen = (pixels: Uint8ClampedArray, index: number): boolean => {
      const red = pixels[index];
      const green = pixels[index + 1];
      const blue = pixels[index + 2];
      const alpha = pixels[index + 3];
      return alpha > 0 && green > 100 && green > red * 1.35 && green > blue * 1.15;
    };
    let greenIntersectionPixels = 0;
    let greenUnionPixels = 0;
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const beforeIndex = (y * beforeImage.width + x) * 4;
        const afterIndex = (y * afterImage.width + x) * 4;
        const beforeGreen = isGreen(beforeImage.data, beforeIndex);
        const afterGreen = isGreen(afterImage.data, afterIndex);
        if (beforeGreen || afterGreen) greenUnionPixels += 1;
        if (beforeGreen && afterGreen) greenIntersectionPixels += 1;
      }
    }
    return {
      greenIntersectionPixels,
      greenIntersectionOverUnion: greenUnionPixels === 0
        ? 1
        : greenIntersectionPixels / greenUnionPixels,
      greenUnionPixels,
    };
  }, { afterDataUrl: after.dataUrl, beforeDataUrl: before.dataUrl });
}

function hasEfficientHorizontalFit(metrics: TerminalLayoutMetrics, cols: number): boolean {
  if (cols < 1 || metrics.screenWidth <= 0) return false;

  const horizontalSlack = metrics.fitContainerWidth - metrics.screenWidth;
  const renderedCellWidth = metrics.screenWidth / cols;
  // FitAddon reserves xterm's scrollbar and floors the remaining width to
  // whole cells. Our single defensive DOM-overflow correction may remove one
  // additional column when Chromium rounds the canvas up. Therefore a correct
  // fit may leave one scrollbar + at most two cells + rounding, regardless of
  // font size. Clipping remains a separate hard failure.
  const maximumSlack = metrics.verticalScrollbarWidth
    + metrics.xtermHorizontalPadding
    + (renderedCellWidth * 2)
    + 2;

  return metrics.screenRightOverflow <= 1
    && horizontalSlack >= -1
    && horizontalSlack <= maximumSlack;
}

async function dragResizeHandle(page: Page, handle: Locator, deltaX: number): Promise<void> {
  const count = await handle.count().catch(() => 0);
  if (count === 0) return;
  const target = count === 1 ? handle : handle.first();
  if (!(await target.isVisible({ timeout: 1_000 }).catch(() => false))) return;
  const box = await target.boundingBox().catch(() => null);
  if (!box) return;

  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + deltaX, y, { steps: 14 });
  await page.mouse.up();
  await page.waitForTimeout(700);
}

async function dragResizeHandleFromX(
  page: Page,
  fromX: number,
  targetX: number,
  y: number,
): Promise<void> {
  await page.mouse.move(fromX, y);
  await page.mouse.down();
  await page.mouse.move(targetX, y, { steps: 20 });
  await page.mouse.up();
  await page.waitForTimeout(700);
}

// Achievable splitter travel is bounded by the pair's own geometry, not by the
// requested delta: each Fleet Panel clamps at MIN_FLEET_PANE_WIDTH_PX, so a
// sidebar that is still open or a narrower viewport silently shortens a drag.
async function measureDuelPairGeometry(
  page: Page,
  separatorWidth: number,
  resizingPaneId: string,
  spacerPaneId: string,
): Promise<DuelPairGeometry> {
  const [resizingPanelWidth, sidebarWidth, spacerPanelWidth] = await Promise.all([
    measureElementWidth(page, `fleet-pane-content-${resizingPaneId}`),
    measureElementWidth(page, SIDEBAR_PANEL_ID),
    measureElementWidth(page, `fleet-pane-content-${spacerPaneId}`),
  ]);

  return {
    headroom: Math.min(resizingPanelWidth, spacerPanelWidth) - MIN_FLEET_PANE_WIDTH_PX,
    pairWidth: resizingPanelWidth + separatorWidth + spacerPanelWidth,
    resizingPanelWidth,
    separatorWidth,
    sidebarWidth,
    spacerPanelWidth,
  };
}

async function exerciseDuelSplitter(
  page: Page,
  groupId: string,
  paneId: string,
  cycles: number,
): Promise<void> {
  const handle = page.getByTestId(`fleet-pane-separator-duel-${groupId}`);
  await handle.waitFor({ state: 'visible', timeout: TERMINAL_TIMEOUT_MS });
  const initialBox = await handle.boundingBox();
  expect(initialBox).not.toBeNull();
  if (!initialBox) throw new Error(`duel splitter ${groupId} has no initial bounds`);
  const initialX = initialBox.x + initialBox.width / 2;

  const dragTo = async (targetX: number, label: string): Promise<void> => {
    const beforeWidth = (await getTerminalLayoutMetrics(page, paneId)).rootWidth;
    let fromX = 0;
    let movement = 0;
    let resizedBox: Awaited<ReturnType<Locator['boundingBox']>> = null;
    for (let attempt = 0; attempt < 2 && movement <= 100; attempt += 1) {
      const currentBox = await handle.boundingBox();
      expect(currentBox).not.toBeNull();
      if (!currentBox) throw new Error(`duel splitter ${groupId} disappeared during resize`);
      fromX = currentBox.x + currentBox.width / 2;
      // Duel pairs place a clickable "VS" chip over the midpoint. Drag from
      // the upper quarter so Playwright reaches the real separator hit target.
      await dragResizeHandleFromX(
        page,
        fromX,
        targetX,
        currentBox.y + currentBox.height / 4,
      );
      resizedBox = await handle.boundingBox();
      expect(resizedBox).not.toBeNull();
      if (!resizedBox) throw new Error(`duel splitter ${groupId} disappeared after ${label}`);
      movement = Math.abs((resizedBox.x + resizedBox.width / 2) - fromX);
    }
    expect(resizedBox).not.toBeNull();
    if (!resizedBox) throw new Error(`duel splitter ${groupId} disappeared after ${label}`);
    const afterWidth = (await getTerminalLayoutMetrics(page, paneId)).rootWidth;
    expect(
      movement,
      `duel splitter ${groupId} did not move during ${label}`,
    ).toBeGreaterThan(100);
    expect(
      Math.abs(afterWidth - beforeWidth),
      `pane ${paneId} did not materially resize during ${label}`,
    ).toBeGreaterThan(100);
  };

  for (let cycle = 0; cycle < cycles; cycle += 1) {
    await dragTo(initialX - 260, `narrow cycle ${cycle + 1}`);
    await dragTo(initialX, `restore cycle ${cycle + 1}`);
  }
}

async function nearestFleetResizeHandle(page: Page, target: Locator): Promise<Locator> {
  const targetBox = await target.boundingBox();
  expect(targetBox).not.toBeNull();
  if (!targetBox) throw new Error('fleet pane has no bounding box');

  const handles = page.locator('[data-fleet-pane-separator="true"][aria-orientation="vertical"]');
  const count = await handles.count();
  expect(count, 'fleet should expose at least one vertical resize separator').toBeGreaterThan(0);

  let bestIndex = 0;
  let bestScore = Number.POSITIVE_INFINITY;
  for (let index = 0; index < count; index += 1) {
    const handle = handles.nth(index);
    const box = await handle.boundingBox();
    if (!box) continue;
    const overlapY = Math.max(0, Math.min(targetBox.y + targetBox.height, box.y + box.height) - Math.max(targetBox.y, box.y));
    const edgeDistance = Math.min(
      Math.abs(box.x - targetBox.x),
      Math.abs(box.x - (targetBox.x + targetBox.width)),
    );
    const score = edgeDistance - overlapY;
    if (score < bestScore) {
      bestIndex = index;
      bestScore = score;
    }
  }

  return handles.nth(bestIndex);
}

async function widenFleetPane(page: Page, paneId: string): Promise<void> {
  const paneCell = page.locator(`[data-testid="pane-cell"][data-pane-id="${paneId}"]`).first();
  await paneCell.waitFor({ state: 'visible', timeout: TERMINAL_TIMEOUT_MS });
  const handle = await nearestFleetResizeHandle(page, paneCell);
  const before = await getTerminalLayoutMetrics(page, paneId);

  for (const deltaX of [360, -720, 360]) {
    await dragResizeHandle(page, handle, deltaX);
    const after = await getTerminalLayoutMetrics(page, paneId);
    if (after.rootWidth > before.rootWidth + 80) return;
  }

  const after = await getTerminalLayoutMetrics(page, paneId);
  throw new Error(`fleet pane did not widen enough: before=${before.rootWidth}, after=${after.rootWidth}`);
}

async function waitForTerminalGeometry(
  page: Page,
  pane: AumxPane,
  minCols: number,
): Promise<{ metrics: TerminalLayoutMetrics; snapshot: TerminalSnapshot; tmuxSize: TmuxPaneSize }> {
  return pollUntil(
    async () => {
      const snapshot = await getTerminalSnapshot(page, pane.id);
      if (!snapshot?.info.cols || !snapshot.info.rows) return null;
      const tmuxSize = readTmuxPaneSize(pane.paneId);
      const metrics = await getTerminalLayoutMetrics(page, pane.id);
      const screenGap = metrics.fitContainerWidth - metrics.screenWidth;
      const geometryReady = snapshot.info.cols >= minCols
        && tmuxSize.cols === snapshot.info.cols
        && tmuxSize.rows === snapshot.info.rows
        && hasEfficientHorizontalFit(metrics, snapshot.info.cols);
      if (geometryReady) return { metrics, snapshot, tmuxSize };
      throw new Error(JSON.stringify({
        minCols,
        metrics,
        screenGap,
        snapshot: { cols: snapshot.info.cols, rows: snapshot.info.rows },
        tmuxSize,
      }));
    },
    { interval: 250, label: `terminal-geometry(${pane.id})`, timeout: TERMINAL_GEOMETRY_TIMEOUT_MS },
  );
}

async function waitForStableTerminalGeometry(
  page: Page,
  pane: AumxPane,
  minCols: number,
): Promise<{ metrics: TerminalLayoutMetrics; snapshot: TerminalSnapshot; tmuxSize: TmuxPaneSize }> {
  let previous = await waitForTerminalGeometry(page, pane, minCols);

  return pollUntil(
    async () => {
      await page.waitForTimeout(300);
      const next = await waitForTerminalGeometry(page, pane, minCols);
      const stable = next.snapshot.info.cols === previous.snapshot.info.cols
        && next.snapshot.info.rows === previous.snapshot.info.rows
        && next.tmuxSize.cols === previous.tmuxSize.cols
        && next.tmuxSize.rows === previous.tmuxSize.rows;
      previous = next;
      return stable ? next : null;
    },
    { interval: 100, label: `stable-terminal-geometry(${pane.id})`, timeout: TERMINAL_GEOMETRY_TIMEOUT_MS },
  );
}

async function waitForStableTerminalSize(
  page: Page,
  pane: AumxPane,
): Promise<{ snapshot: TerminalSnapshot; tmuxSize: TmuxPaneSize }> {
  let previousSize = '';
  let consecutiveMatches = 0;
  return pollUntil(
    async () => {
      const snapshot = await getTerminalSnapshot(page, pane.id);
      if (!snapshot?.info.cols || !snapshot.info.rows) return null;
      const tmuxSize = readTmuxPaneSize(pane.paneId);
      if (tmuxSize.cols !== snapshot.info.cols || tmuxSize.rows !== snapshot.info.rows) {
        previousSize = '';
        consecutiveMatches = 0;
        return null;
      }
      const size = `${tmuxSize.cols}x${tmuxSize.rows}`;
      consecutiveMatches = size === previousSize ? consecutiveMatches + 1 : 0;
      previousSize = size;
      return consecutiveMatches >= 1 ? { snapshot, tmuxSize } : null;
    },
    { interval: 300, label: `stable-terminal-size(${pane.id})`, timeout: TERMINAL_GEOMETRY_TIMEOUT_MS },
  );
}

async function waitForStableSelectionPosition(
  page: Page,
  paneId: string,
  timeout = TERMINAL_TIMEOUT_MS,
): Promise<TerminalSnapshot> {
  let previous = '';
  let consecutiveMatches = 0;
  let lastSnapshot: TerminalSnapshot | null = null;
  try {
    return await pollUntil(
      async () => {
        const snapshot = await getTerminalSnapshot(page, paneId);
        lastSnapshot = snapshot;
        const position = snapshot?.info.selectionPosition;
        if (!snapshot || !position) {
          previous = '';
          consecutiveMatches = 0;
          return null;
        }
        const signature = `${position.start.x},${position.start.y}-${position.end.x},${position.end.y}`;
        consecutiveMatches = signature === previous ? consecutiveMatches + 1 : 0;
        previous = signature;
        return consecutiveMatches >= 2 ? snapshot : null;
      },
      { interval: 100, label: `stable-selection(${paneId})`, timeout },
    );
  } catch (error) {
    throw new Error(
      `stable-selection(${paneId}) failed with last snapshot ${JSON.stringify(lastSnapshot?.info ?? null)}`,
      { cause: error },
    );
  }
}

async function scrollTerminalUp(page: Page, paneId: string): Promise<TerminalSnapshot> {
  const screen = page.locator(`${terminalSelector(paneId)} .xterm-screen`);
  await screen.waitFor({ state: 'visible', timeout: TERMINAL_TIMEOUT_MS });
  const box = await screen.boundingBox();
  expect(box).not.toBeNull();
  if (!box) throw new Error(`terminal-scroll-up: missing terminal screen for ${paneId}`);

  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  let lastSnapshot: TerminalSnapshot | null = null;

  for (let attempt = 0; attempt < 40; attempt += 1) {
    await page.mouse.wheel(0, -16_000);
    await page.waitForTimeout(100);
    const snapshot = await getTerminalSnapshot(page, paneId);
    if (!snapshot) continue;

    lastSnapshot = snapshot;
    const text = snapshot.visibleLines.join('\n');
    if (snapshot.info.viewportY < snapshot.info.baseY && text.includes(SCROLLBACK_FIRST_LINE)) {
      return snapshot;
    }
  }

  const info = lastSnapshot ? JSON.stringify(lastSnapshot.info) : 'no terminal snapshot';
  const sample = lastSnapshot?.visibleLines.slice(0, 30).join(' | ') ?? '';
  throw new Error(`terminal-scroll-up: oldest scrollback line was not visible (${info}) ${sample}`);
}

async function scrollPtyTerminalUp(page: Page, pane: AumxPane): Promise<TerminalSnapshot> {
  const screen = page.locator(`${terminalSelector(pane.id)} .xterm-screen`);
  await screen.waitFor({ state: 'visible', timeout: TERMINAL_TIMEOUT_MS });
  const box = await screen.boundingBox();
  expect(box).not.toBeNull();
  if (!box) throw new Error(`pty-terminal-scroll-up: missing terminal screen for ${pane.id}`);

  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  let lastSnapshot: TerminalSnapshot | null = null;

  for (let attempt = 0; attempt < 40; attempt += 1) {
    await page.mouse.wheel(0, -16_000);
    await page.waitForTimeout(150);
    const snapshot = await getTerminalSnapshot(page, pane.id);
    if (!snapshot) continue;

    lastSnapshot = snapshot;
    const text = snapshot.visibleLines.join('\n');
    const paneInCopyMode = runTmux(['display-message', '-p', '-t', pane.paneId, '#{pane_in_mode}']).trim() === '1';
    if (paneInCopyMode && text.includes(SCROLLBACK_FIRST_LINE)) {
      return snapshot;
    }
  }

  const info = lastSnapshot ? JSON.stringify(lastSnapshot.info) : 'no terminal snapshot';
  const sample = lastSnapshot?.visibleLines.slice(0, 30).join(' | ') ?? '';
  throw new Error(`pty-terminal-scroll-up: oldest scrollback line was not visible (${info}) ${sample}`);
}

async function scrollPtyTerminalDown(
  page: Page,
  pane: AumxPane,
  bottomMarker: string,
): Promise<TerminalSnapshot> {
  const screen = page.locator(`${terminalSelector(pane.id)} .xterm-screen`);
  await screen.waitFor({ state: 'visible', timeout: TERMINAL_TIMEOUT_MS });
  const box = await screen.boundingBox();
  expect(box).not.toBeNull();
  if (!box) throw new Error(`pty-terminal-scroll-down: missing terminal screen for ${pane.id}`);

  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  let lastSnapshot: TerminalSnapshot | null = null;

  for (let attempt = 0; attempt < 40; attempt += 1) {
    await page.mouse.wheel(0, 16_000);
    await page.waitForTimeout(150);
    const snapshot = await getTerminalSnapshot(page, pane.id);
    if (!snapshot) continue;

    lastSnapshot = snapshot;
    const text = snapshot.visibleLines.join('\n');
    const paneInCopyMode = runTmux(['display-message', '-p', '-t', pane.paneId, '#{pane_in_mode}']).trim() === '1';
    if (!paneInCopyMode && text.includes(bottomMarker)) {
      return snapshot;
    }
  }

  const info = lastSnapshot ? JSON.stringify(lastSnapshot.info) : 'no terminal snapshot';
  const sample = lastSnapshot?.visibleLines.slice(0, 30).join(' | ') ?? '';
  throw new Error(`pty-terminal-scroll-down: live view was not restored (${info}) ${sample}`);
}

async function showProfiledDuelPair(
  page: Page,
  sourcePane: AumxPane,
  siblingSourcePane: AumxPane,
  groupId: string,
  profile: DeterministicTerminalProfile,
): Promise<{ pane: AumxPane; siblingPane: AumxPane }> {
  const pane: AumxPane = {
    ...sourcePane,
    ...(profile.agent
      ? {
        agent: profile.agent,
        agentStatus: 'idle' as const,
        claudeRenderer: profile.claudeRenderer,
        shellType: undefined,
        terminalFixedCols: profile.fixedCols,
        type: undefined,
      }
      : {}),
    duel: {
      groupId,
      prompt: 'Deterministic terminal resize and scroll regression',
      role: 'a',
      siblingPaneId: siblingSourcePane.id,
    },
  };
  const siblingPane: AumxPane = {
    ...siblingSourcePane,
    duel: {
      groupId,
      prompt: 'Deterministic terminal resize and scroll regression',
      role: 'b',
      siblingPaneId: pane.id,
    },
  };

  const idleActivity = profile.agent
    ? makeActivity({ paneIncarnationId: `${pane.id}-e2e-incarnation` })
    : undefined;

  await page.evaluate(({ idleActivity: activity, panes }) => {
    const stores = (window as unknown as E2EWindow).__aumxStores;
    if (activity) {
      const currentActivities = stores?.paneActivity?.getState().activityByPaneId ?? {};
      stores?.paneActivity?.setState({
        activityByPaneId: { ...currentActivities, [panes[0].id]: activity },
      });
    }
    stores?.pane?.getState().setPanes(panes);
    stores?.ui?.getState().setActiveView('dashboard');
    stores?.ui?.getState().setViewMode('fleet');
  }, { idleActivity, panes: [pane, siblingPane] });
  await page.locator(`${terminalSelector(pane.id)} .xterm-screen`).waitFor({
    state: 'visible',
    timeout: TERMINAL_TIMEOUT_MS,
  });
  await page.locator(`${terminalSelector(siblingPane.id)} .xterm-screen`).waitFor({
    state: 'visible',
    timeout: TERMINAL_TIMEOUT_MS,
  });
  return { pane, siblingPane };
}

async function expectIsolatedPtyViewSession(page: Page, pane: AumxPane): Promise<void> {
  const session = await invoke<SessionInfoResult>(page, IPC.SESSION_INFO);
  const viewSessionBase = makeTerminalPtyViewSessionName(session.sessionName, pane.id);
  const sourceWindowId = runTmux(['display-message', '-p', '-t', pane.paneId, '#{window_id}']).trim();
  const deadline = Date.now() + TERMINAL_TIMEOUT_MS;
  let lastCandidates: string[] = [];
  let lastError = '';

  while (Date.now() < deadline) {
    try {
      // '|' separator: tmux sanitizes tabs to '_' in list-sessions output.
      const candidates = runTmux(['list-sessions', '-F', '#{session_name}|#{session_attached}|#{session_windows}|#{@aumx_view_session}'])
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .flatMap((line) => {
          const [name, attached, windowCount, marker] = line.split('|');
          if (marker !== '1') return [];
          if (name !== viewSessionBase && !name.startsWith(`${viewSessionBase}-`)) return [];
          return [{ attached, name, windowCount }];
        });

      lastCandidates = candidates.map((candidate) => `${candidate.name}:${candidate.attached}:${candidate.windowCount}`);
      for (const candidate of candidates) {
        const windowIds = runTmux(['list-windows', '-t', `=${candidate.name}`, '-F', '#{window_id}'])
          .trim()
          .split('\n')
          .filter(Boolean);
        if (windowIds.length === 1 && windowIds[0] === sourceWindowId) return;
        lastError = `candidate=${candidate.name}, windows=${JSON.stringify(windowIds)}, source=${sourceWindowId}`;
      }
      if (candidates.length === 0) {
        lastError = `no marked PTY view session with base ${viewSessionBase}`;
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await page.waitForTimeout(100);
  }

  const sessions = runTmux(['list-sessions', '-F', '#{session_name}|#{session_attached}|#{session_windows}|#{@aumx_view_session}'])
    .split('\n')
    .filter((line) => line.includes('--view-') || line.includes(session.sessionName))
    .join(' ; ');
  throw new Error(`isolated PTY view session ${viewSessionBase}* was not ready: ${lastError}; candidates=${JSON.stringify(lastCandidates)}; sessions: ${sessions}`);
}

describe.runIf(process.env.AUMX_E2E === '1')('Terminal resilience E2E', () => {
  let app: ElectronApplication;
  let page: Page;
  let projectRoot: string;
  let sessionName: string;
  const createdPanes: AumxPane[] = [];
  let scenarioBaselinePaneIds: string[] = [];
  let scenarioBaselineBackendPaneIds: string[] = [];
  let scenarioBaselineTmuxPaneIds: string[] = [];
  let scenarioOwnedPanes: AumxPane[] = [];

  beforeAll(async () => {
    const launchTarget = APP_EXECUTABLE_PATH
      ? { args: [], executablePath: APP_EXECUTABLE_PATH }
      : { args: [MAIN_ENTRY] };
    expect(existsSync(APP_EXECUTABLE_PATH ?? MAIN_ENTRY), 'Electron launch target is missing').toBe(true);
    mkdirSync(SCREENSHOTS_DIR, { recursive: true });
    projectRoot = realpathSync(mkdtempSync(join(tmpdir(), 'aumx-terminal-e2e-')));
    execFileSync('git', ['init'], { cwd: projectRoot, stdio: 'ignore' });
    sessionName = `aumx-${basename(projectRoot)}`;
    killTmuxSession(sessionName);

    app = await electron.launch({
      ...launchTarget,
      cwd: projectRoot,
      env: {
        ...process.env,
        AUMX_E2E: '1',
        AUMX_DEV: 'true',
        NODE_ENV: 'test',
      },
    });

    page = await getAppWindow(app);
    await app.context().addInitScript(() => {
      (window as unknown as E2EWindow).__AUMX_E2E = true;
    });
    await page.reload();
    await ensureAppWindowVisible(app);
    await page.setViewportSize({ height: 980, width: 1440 });
    await page.locator('[data-testid="app-shell"]').waitFor({ state: 'visible', timeout: 15_000 });
    await waitForAppReady(page);
    const expectedTmuxVersion = process.env.AUMX_E2E_EXPECT_TMUX_VERSION;
    if (expectedTmuxVersion) {
      const effectivePath = await app.evaluate(() => process.env.PATH ?? '');
      const effectiveVersion = execFileSync('tmux', ['-V'], {
        encoding: 'utf8',
        env: { ...process.env, PATH: effectivePath },
      }).trim();
      expect(effectiveVersion).toBe(`tmux ${expectedTmuxVersion}`);
    }
    await waitForRendererPaneHydration(page);
    await collapseSidebar(page);

    const session = await invoke<SessionInfoResult>(page, IPC.SESSION_INFO);
    expect(session.projectRoot).toBe(projectRoot);
    sessionName = session.sessionName;
    await setTerminalTransport(app, page, 'pty');
  }, APP_STARTUP_TIMEOUT_MS);

  beforeEach(async (context) => {
    scenarioBaselinePaneIds = createdPanes.map((pane) => pane.id);
    scenarioBaselineBackendPaneIds = (await getPanes(page)).map((pane) => pane.id).sort();
    scenarioBaselineTmuxPaneIds = listSessionTmuxPaneIds(sessionName);
    scenarioOwnedPanes = [];
    context.onTestFailed(async () => {
      const baseline = new Set(scenarioBaselinePaneIds);
      const ownedPanes = scenarioOwnedPanes.length > 0
        ? scenarioOwnedPanes
        : createdPanes.filter((pane) => !baseline.has(pane.id));
      const diagnostics = await collectFailureDiagnostics(
        page,
        sessionName,
        scenarioBaselinePaneIds,
        scenarioBaselineTmuxPaneIds,
        ownedPanes,
      );
      console.error(`Terminal resilience failure diagnostics: ${JSON.stringify(diagnostics, null, 2)}`);
    });
  });

  afterEach(async () => {
    const baseline = new Set(scenarioBaselinePaneIds);
    const ownedPanes = createdPanes.filter((pane) => !baseline.has(pane.id));
    scenarioOwnedPanes = [...ownedPanes];
    for (const pane of [...ownedPanes].reverse()) {
      await closePaneBestEffort(page, pane);
    }
    for (let index = createdPanes.length - 1; index >= 0; index -= 1) {
      if (!baseline.has(createdPanes[index].id)) createdPanes.splice(index, 1);
    }
    if (!page.isClosed()) {
      await pollUntil(
        async () => {
          const paneIds = (await getPanes(page)).map((pane) => pane.id).sort();
          return JSON.stringify(paneIds) === JSON.stringify(scenarioBaselineBackendPaneIds)
            ? true
            : null;
        },
        { interval: 100, label: 'scenario-pane-cleanup', timeout: TERMINAL_TIMEOUT_MS },
      );
      await pollUntil(
        async () => (
          JSON.stringify(listSessionTmuxPaneIds(sessionName))
            === JSON.stringify(scenarioBaselineTmuxPaneIds)
            ? true
            : null
        ),
        { interval: 100, label: 'scenario-tmux-cleanup', timeout: TERMINAL_TIMEOUT_MS },
      );
      await syncRendererPanes(page);
    }
  }, APP_SHUTDOWN_TIMEOUT_MS);

  afterAll(async () => {
    for (const pane of [...createdPanes].reverse()) {
      await closePaneBestEffort(page, pane);
    }
    if (app) await closeElectronApp(app);
    if (sessionName) killTmuxSession(sessionName);
    if (projectRoot) rmSync(projectRoot, { force: true, recursive: true });
  }, APP_SHUTDOWN_TIMEOUT_MS);

  it('removes a stale pane instead of leaving a boot spinner or empty terminal', async () => {
    await showDashboardMode(page, 'settings');
    const pane = await createShellPane(page, createdPanes, { waitForCommandReady: false });
    expect(pane.paneId).toMatch(/^%\d+$/);

    await invoke(page, IPC.TERMINAL_DETACH, { paneId: pane.id });
    killTmuxPaneWindow(pane.paneId);

    const attach = await invoke<TerminalAttachResponse>(page, IPC.TERMINAL_ATTACH, {
      paneId: pane.id,
      sessionName,
      transcriptPath: pane.terminalTranscriptPath,
    });

    expect(attach.success).toBe(false);
    expect(attach.error).toContain('Terminal pane no longer exists');

    await pollUntil(
      async () => {
        const panes = await syncRendererPanes(page);
        return panes.every((candidate) => candidate.id !== pane.id);
      },
      { interval: 250, label: 'stale-pane-cleanup', timeout: TERMINAL_TIMEOUT_MS },
    );

    createdPanes.splice(createdPanes.indexOf(pane), 1);
    await showDashboardMode(page, 'fleet');
    await pollUntil(
      async () => (await page.locator(terminalSelector(pane.id)).count()) === 0 ? true : null,
      { interval: 100, label: 'stale-terminal-dom-removed', timeout: TERMINAL_TIMEOUT_MS },
    );

    const replacement = await createShellPane(page, createdPanes);
    const replacementMarker = 'AUMX-STALE-PANE-REPLACEMENT-READY';
    const markerResponse = await invoke<{ error?: string; success: boolean }>(page, IPC.PANE_SEND_KEYS, {
      command: `printf '${replacementMarker}\\n'`,
      paneId: replacement.id,
    });
    expect(markerResponse.success, markerResponse.error).toBe(true);
    await waitForTmuxContent(replacement.paneId, replacementMarker);
    await screenshot(page, '01-stale-pane-cleaned');
  }, 30_000);

  it('reopens a transcript-backed terminal with scrollback and professional alignment', async () => {
    await setTerminalTransport(app, page, 'classic');
    const pane = await createShellPane(page, createdPanes);
    const otherPane = await createShellPane(page, createdPanes);

    const outputCommand = [
      'node',
      '-e',
      '\'for (let i = 1; i <= 140; i += 1) console.log(`AUMX-SCROLLBACK-LINE-${String(i).padStart(3, "0")}`); console.log("AUMX-SCROLLBACK-DONE");\'',
    ].join(' ');

    await invoke(page, IPC.PANE_SEND_KEYS, {
      command: outputCommand,
      paneId: pane.id,
    });
    await waitForTmuxContent(pane.paneId, SCROLLBACK_DONE_MARKER);

    await focusPane(page, otherPane.id);
    await page.locator(`${terminalSelector(otherPane.id)} .xterm-screen`).waitFor({
      state: 'visible',
      timeout: TERMINAL_TIMEOUT_MS,
    });

    await focusPane(page, pane.id);
    const seeded = await waitForSeededScrollback(page, pane.id);
    expect(seeded.info.baseY).toBeGreaterThan(0);

    const metrics = await getTerminalLayoutMetrics(page, pane.id);
    expect(metrics.backgroundColor).toBe('rgb(0, 0, 0)');
    expect(metrics.rootHeight).toBeGreaterThan(600);
    expect(metrics.rootWidth).toBeGreaterThan(700);
    expect(metrics.screenTopInset).toBeGreaterThanOrEqual(4);
    expect(metrics.screenTopInset).toBeLessThanOrEqual(18);
    expect(metrics.screenBottomOverflow).toBeLessThanOrEqual(1);
    expect(metrics.screenRightOverflow).toBeLessThanOrEqual(1);

    await screenshot(page, '02-reopened-terminal-bottom');

    const scrolled = await scrollTerminalUp(page, pane.id);
    const scrolledText = scrolled.visibleLines.join('\n');
    expect(scrolled.info.viewportY).toBeLessThan(scrolled.info.baseY);
    expect(scrolledText).toContain(SCROLLBACK_FIRST_LINE);

    await screenshot(page, '03-reopened-terminal-scrolled-up');
  }, 45_000);

  it('keeps existing transcript panes painted after adding another pane to the fleet grid', async () => {
    await showDashboardMode(page, 'fleet');
    const panes: AumxPane[] = [];

    for (let index = 0; index < 6; index += 1) {
      panes.push(await createShellPane(page, createdPanes));
    }

    const markers = panes.map((_, index) => `AUMX-RESIZE-KEEP-${String(index + 1).padStart(2, '0')}`);

    for (let index = 0; index < panes.length; index += 1) {
      await invoke(page, IPC.PANE_SEND_KEYS, {
        command: `printf '${markers[index]}\\n'`,
        paneId: panes[index].id,
      });
      await waitForTmuxContent(panes[index].paneId, markers[index]);
      await waitForVisibleTerminalText(page, panes[index].id, markers[index]);
    }

    await createShellPane(page, createdPanes);

    for (let index = 0; index < panes.length; index += 1) {
      await waitForVisibleTerminalText(page, panes[index].id, markers[index]);
    }

    await screenshot(page, '04-existing-panes-survive-add');
  }, 60_000);

  it('resizes xterm and tmux to the widened fleet pane before new output wraps', async () => {
    // Keep both Fleet panes above the production readability minimum while
    // leaving enough horizontal range to prove a substantial manual resize.
    await page.setViewportSize({ height: 980, width: 1600 });
    await showDashboardMode(page, 'fleet');
    const pane = await createShellPane(page, createdPanes);
    await createShellPane(page, createdPanes);
    await syncRendererPanes(page);
    await page.locator(terminalSelector(pane.id)).waitFor({ state: 'visible', timeout: TERMINAL_TIMEOUT_MS });
    await waitForStableTerminalGeometry(page, pane, 1);

    const beforeMarker = 'AUMX-WIDTH-BEFORE';
    await invoke(page, IPC.PANE_SEND_KEYS, {
      command: widthProbeCommand(beforeMarker),
      paneId: pane.id,
    });
    const beforeContent = await waitForTmuxContent(pane.paneId, `${beforeMarker}-TABLE-`);
    const beforeCols = extractProbeCols(beforeContent, beforeMarker);
    const beforeSnapshot = await waitForVisibleTerminalText(page, pane.id, `${beforeMarker}-COLS=`);
    expect(beforeSnapshot.info.cols).toBe(beforeCols);

    await widenFleetPane(page, pane.id);
    const geometry = await waitForStableTerminalGeometry(page, pane, beforeCols + 20);

    const afterMarker = 'AUMX-WIDTH-AFTER';
    await invoke(page, IPC.PANE_SEND_KEYS, {
      command: widthProbeCommand(afterMarker),
      paneId: pane.id,
    });
    const afterContent = await waitForTmuxContent(pane.paneId, `${afterMarker}-TABLE-`);
    const afterCols = extractProbeCols(afterContent, afterMarker);
    await waitForVisibleTerminalText(page, pane.id, `${afterMarker}-COLS=`);

    expect(afterCols).toBe(geometry.tmuxSize.cols);
    expect(afterCols).toBe(geometry.snapshot.info.cols);
    expect(afterCols).toBeGreaterThan(beforeCols + 20);
    expect(hasEfficientHorizontalFit(geometry.metrics, geometry.snapshot.info.cols)).toBe(true);

    await screenshot(page, '05-widened-pane-uses-new-cols');
    await page.setViewportSize({ height: 980, width: 1440 });
  }, 90_000);

  it.each([
    {
      stationaryAgent: 'claude' as const,
      stationaryClaudeRenderer: 'classic' as const,
      stationaryFixedCols: 100,
      stationaryLabel: 'Claude-profiled',
    },
    {
      stationaryAgent: 'opencode' as const,
      stationaryClaudeRenderer: undefined,
      stationaryFixedCols: undefined,
      stationaryLabel: 'OpenCode-profiled',
    },
  ])('keeps a stationary $stationaryLabel WebGL canvas intact while a Claude-profiled sibling is repeatedly resized', async ({
    stationaryAgent,
    stationaryClaudeRenderer,
    stationaryFixedCols,
  }) => {
    // The suite afterEach already closes every pane this scenario created, so
    // the widened viewport is the only state this test still owns.
    onTestFinished(async () => {
      if (!page.isClosed()) await page.setViewportSize({ height: 980, width: 1440 });
    });

    await setTerminalTransport(app, page, 'pty');
    await page.setViewportSize({ height: 980, width: 2000 });
    await showDashboardMode(page, 'settings');
    const resizingSource = await createShellPane(page, createdPanes, { waitForCommandReady: false });
    const spacerSource = await createShellPane(page, createdPanes, { waitForCommandReady: false });
    const stationarySource = await createShellPane(page, createdPanes, { waitForCommandReady: false });
    // Pane creation persists synchronously, then ConfigBridge deliberately
    // emits one duplicate file-watch update after its 100 ms stability window.
    // Let that update land before applying renderer-only agent profiles.
    await waitForConfigQuiescence(
      page,
      getProjectConfigPath(projectRoot),
      [resizingSource.id, spacerSource.id, stationarySource.id],
    );

    // Use deterministic ANSI workloads while exercising the production agent
    // terminal profiles. The gated live-agent suite separately launches the
    // real Claude and OpenCode CLIs.
    const duelGroupId = `e2e-atlas-resize-${stationaryAgent}-${Date.now()}`;
    const resizingPane: AumxPane = {
      ...resizingSource,
      agent: 'claude',
      agentStatus: 'idle',
      claudeRenderer: 'classic',
      duel: {
        groupId: duelGroupId,
        prompt: 'WebGL atlas resize regression',
        role: 'a',
        siblingPaneId: spacerSource.id,
      },
      shellType: undefined,
      terminalFixedCols: 100,
      type: undefined,
    };
    const spacerPane: AumxPane = {
      ...spacerSource,
      duel: {
        groupId: duelGroupId,
        prompt: 'WebGL atlas resize regression',
        role: 'b',
        siblingPaneId: resizingPane.id,
      },
    };
    const stationaryPane: AumxPane = {
      ...stationarySource,
      agent: stationaryAgent,
      agentStatus: 'idle',
      claudeRenderer: stationaryClaudeRenderer,
      shellType: undefined,
      terminalFixedCols: stationaryFixedCols,
      type: undefined,
    };
    const resizerMarker = 'AUMX-CLAUDE-RESIZER';
    const stationaryMarker = `AUMX-${stationaryAgent.toUpperCase()}-STATIONARY`;
    const resizerFrame = [
      '\x1b[2J\x1b[H\x1b[38;2;215;119;87m',
      `${resizerMarker} ASCII FRAME 0123456789`,
      'ABCDEFGHIJKLMNOPQRSTUVWXYZ abcdefghijklmnopqrstuvwxyz',
      '⣀⣄⣤⣦⣶⣷⣿ ◢◣◤◥ ◆◇◈◉◊ resize this pane away and back',
      '\x1b[0m\x1b[20;1H',
    ].join('\r\n');
    const stationaryFrame = [
      `\x1b[2J\x1b[H\x1b[37m${stationaryMarker}\x1b[38;2;35;220;130m`,
      '▐▛███▜▌ ▝▜█████▛▘ ▖▗▘▙▚▛▜▝▞▟ ▀▄▌▐▓▒░',
      '⣿⣷⣯⣟⡿⢿⠿⠾⠽⠻⠹⠸⠼⠴⠦⠤⣤⣶⣿',
      '┌─┬─┐ ╔═╦═╗ ╭─┰─╮ ┏━┳━┓ ┎┒┖┚',
      '├─┼─┤ ╠═╬═╣ ┝━╋━┥ ┣━╋━┫ ┟┯┷┫',
      '└─┴─┘ ╚═╩═╝ ╰─┸─╯ ┗━┻━┛ ┕┙┍┑',
      'αβγδεζηθικλμνξοπρστυφχψω ∑∏√∞≈≠≤≥',
      '⌁⌂⌘⌬⌭⌮⌯⌰⌱⌲⌳⌴⌵⌶⌷⌸⌹⌺⌻⌼⌽⌾⌿',
      '\x1b[0m\x1b[20;1H',
    ].join('\r\n');
    const keepFrameOpen = (frame: string): string => `node -e ${JSON.stringify(
      `process.stdout.write(${JSON.stringify(frame)}); setInterval(() => {}, 2147483647);`,
    )}`;
    const keepFrameOpenWithCursorPulse = (frame: string): string => `node -e ${JSON.stringify(
      `process.stdout.write(${JSON.stringify(frame)}); let column = 1; setInterval(() => { column = column === 1 ? 2 : 1; process.stdout.write('\\x1b[20;' + column + 'H'); }, 200);`,
    )}`;

    // Seed the deterministic workloads while both panes are still ordinary
    // shells. Applying an agent profile deliberately enables the startup stdin
    // lock; racing a fixture command against that lock would not represent a
    // user interaction.
    await invoke(page, IPC.PANE_SEND_KEYS, {
      command: keepFrameOpen(resizerFrame),
      paneId: resizingPane.id,
    });
    await invoke(page, IPC.PANE_SEND_KEYS, {
      command: keepFrameOpenWithCursorPulse(stationaryFrame),
      paneId: stationaryPane.id,
    });
    await waitForTmuxContent(resizingPane.paneId, resizerMarker);
    await waitForTmuxContent(stationaryPane.paneId, stationaryMarker);
    await page.evaluate((panes) => {
      const stores = (window as unknown as E2EWindow).__aumxStores;
      stores?.pane?.getState().setPanes(panes);
      stores?.ui?.getState().setActiveView('dashboard');
      stores?.ui?.getState().setViewMode('fleet');
    }, [resizingPane, spacerPane, stationaryPane]);
    await waitForVisibleTerminalText(page, resizingPane.id, resizerMarker);
    await waitForVisibleTerminalText(page, stationaryPane.id, stationaryMarker);
    expect(
      await hasTerminalWebglRenderer(page, resizingPane.id),
      'resizing terminal must use the WebGL renderer for this regression',
    ).toBe(true);
    expect(
      await hasTerminalWebglRenderer(page, stationaryPane.id),
      'stationary terminal must use the WebGL renderer for this regression',
    ).toBe(true);

    const handle = page.getByTestId(`fleet-pane-separator-duel-${duelGroupId}`);
    await handle.waitFor({ state: 'visible', timeout: TERMINAL_TIMEOUT_MS });
    const baselineHandleBox = await handle.boundingBox();
    expect(baselineHandleBox).not.toBeNull();
    if (!baselineHandleBox) throw new Error('agent-profiled pair has no resize handle at baseline');

    const geometry = await measureDuelPairGeometry(
      page,
      baselineHandleBox.width,
      resizingPane.id,
      spacerPane.id,
    );
    const dragDelta = Math.floor(geometry.headroom - DUEL_DRAG_CLAMP_MARGIN_PX);
    const layoutReport = JSON.stringify({ ...geometry, dragDelta });
    expect(
      geometry.sidebarWidth,
      `duel resize needs the whole content column, sidebar still open: ${layoutReport}`,
    ).toBe(0);
    expect(
      dragDelta,
      `duel pair is too narrow to resize without clamping a leg: ${layoutReport}`,
    ).toBeGreaterThanOrEqual(MIN_DUEL_DRAG_TRAVEL_PX);

    const [resizingSizeBefore, stationarySizeBefore] = await Promise.all([
      waitForStableTerminalSize(page, resizingPane),
      waitForStableTerminalSize(page, stationaryPane),
    ]);

    const before = await pollUntil(
      async () => {
        const metrics = await getTerminalScreenRaster(page, stationaryPane.id);
        return metrics.greenPixels > 500 ? metrics : null;
      },
      { interval: 100, label: 'stationary-canvas-baseline', timeout: TERMINAL_TIMEOUT_MS },
    );
    const resizingFontSizeBefore = await getTerminalFontSize(page, resizingPane.id);
    if (resizingFontSizeBefore === null) throw new Error('resizing agent terminal has no initial font size');

    const dragResizingPaneBy = async (deltaX: number, label: string): Promise<void> => {
      const beforeBox = await handle.boundingBox();
      expect(beforeBox).not.toBeNull();
      if (!beforeBox) throw new Error(`agent-profiled pair lost its resize handle before ${label}`);
      const beforeMetrics = await getTerminalLayoutMetrics(page, resizingPane.id);
      const beforeFontSize = await getTerminalFontSize(page, resizingPane.id);
      if (beforeFontSize === null) throw new Error(`resizing terminal has no font size before ${label}`);
      const fromX = beforeBox.x + beforeBox.width / 2;
      // Duel pairs place a clickable "VS" chip over the separator midpoint.
      // Drag from the upper quarter so the pointer reaches the separator itself.
      await dragResizeHandleFromX(
        page,
        fromX,
        fromX + deltaX,
        beforeBox.y + beforeBox.height / 4,
      );
      const afterBox = await handle.boundingBox();
      expect(afterBox).not.toBeNull();
      if (!afterBox) throw new Error(`agent-profiled pair lost its resize handle after ${label}`);
      const afterMetrics = await getTerminalLayoutMetrics(page, resizingPane.id);
      const afterFontSize = await pollUntil(
        async () => {
          const fontSize = await getTerminalFontSize(page, resizingPane.id);
          return fontSize !== null && Math.abs(fontSize - beforeFontSize) > 0.25
            ? fontSize
            : null;
        },
        { interval: 50, label: `adaptive-font-resize(${label})`, timeout: TERMINAL_GEOMETRY_TIMEOUT_MS },
      );
      // The splitter and the pane edge travel the same distance, so both are
      // held to the requested delta rather than to a loose lower bound.
      const expectedTravel = Math.abs(deltaX);
      const handleTravel = Math.abs((afterBox.x + afterBox.width / 2) - fromX);
      const paneTravel = Math.abs(afterMetrics.rootWidth - beforeMetrics.rootWidth);
      expect(
        Math.abs(handleTravel - expectedTravel),
        `agent-profiled splitter moved ${handleTravel}px instead of ${expectedTravel}px during ${label}`,
      ).toBeLessThanOrEqual(RESIZE_TRAVEL_TOLERANCE_PX);
      expect(
        Math.abs(paneTravel - expectedTravel),
        `agent-profiled pane resized ${paneTravel}px instead of ${expectedTravel}px during ${label}`,
      ).toBeLessThanOrEqual(RESIZE_TRAVEL_TOLERANCE_PX);
      expect(
        Math.abs(afterFontSize - beforeFontSize),
        `adaptive terminal font did not change during ${label}`,
      ).toBeGreaterThan(0.25);
    };

    for (let cycle = 0; cycle < 3; cycle += 1) {
      await dragResizingPaneBy(-dragDelta, `narrow cycle ${cycle + 1}`);
      await dragResizingPaneBy(dragDelta, `restore cycle ${cycle + 1}`);
    }
    await dragResizingPaneBy(-dragDelta, 'final narrow leg');
    const [resizingSizeAfter, stationarySizeAfter] = await Promise.all([
      waitForStableTerminalSize(page, resizingPane),
      waitForStableTerminalSize(page, stationaryPane),
    ]);
    await page.waitForTimeout(600);
    await screenshot(page, `05b-shared-atlas-sibling-survives-${stationaryAgent}-resize`);

    const stationaryAfter = await waitForVisibleTerminalText(page, stationaryPane.id, stationaryMarker);
    const tmuxAfter = await waitForTmuxContent(stationaryPane.paneId, stationaryMarker);
    const resizingFontSizeAfter = await getTerminalFontSize(page, resizingPane.id);
    const after = await getTerminalScreenRaster(page, stationaryPane.id);
    const maskComparison = await compareTerminalScreenGreenMasks(page, before, after);
    if (resizingFontSizeAfter === null) throw new Error('resizing agent terminal has no final font size');
    expect(resizingFontSizeAfter).toBeLessThan(resizingFontSizeBefore);
    expect(resizingSizeBefore.tmuxSize.cols).toBe(100);
    expect(resizingSizeAfter.tmuxSize.cols).toBe(100);
    expect(stationaryAfter.info.cols).toBe(stationarySizeBefore.snapshot.info.cols);
    expect(stationaryAfter.info.rows).toBe(stationarySizeBefore.snapshot.info.rows);
    expect(stationarySizeAfter.tmuxSize).toEqual(stationarySizeBefore.tmuxSize);
    expect(tmuxAfter).toContain('▐▛███▜▌');
    expect(Math.abs(after.width - before.width)).toBeLessThanOrEqual(1);
    expect(Math.abs(after.height - before.height)).toBeLessThanOrEqual(1);
    expect(
      after.greenPixels,
      `stationary ${stationaryAgent} raster lost glyph coverage: before=${JSON.stringify({
        greenPixels: before.greenPixels,
        height: before.height,
        inkPixels: before.inkPixels,
        width: before.width,
      })}, after=${JSON.stringify({
        greenPixels: after.greenPixels,
        height: after.height,
        inkPixels: after.inkPixels,
        width: after.width,
      })}`,
    ).toBeGreaterThanOrEqual(Math.floor(before.greenPixels * 0.9));
    expect(
      maskComparison.greenIntersectionOverUnion,
      `stationary ${stationaryAgent} raster moved glyph pixels: ${JSON.stringify(maskComparison)}`,
    ).toBeGreaterThanOrEqual(0.9);
  }, 90_000);

  it('keeps a terminal mounted and painted after switching pane tabs away and back', async () => {
    await showDashboardMode(page, 'fleet');
    const pane = await createShellPane(page, createdPanes);
    const marker = 'AUMX-TAB-REMOUNT-CLEAN';

    await invoke(page, IPC.PANE_SEND_KEYS, {
      command: `printf '${marker}\\n'`,
      paneId: pane.id,
    });
    await waitForTmuxContent(pane.paneId, marker);
    await waitForVisibleTerminalText(page, pane.id, marker);

    await switchPaneTab(page, pane.id, 'Activity');
    await pollUntil(
      async () => (await page.locator(terminalSelector(pane.id)).count()) === 1 ? true : null,
      { interval: 100, label: 'terminal-stays-mounted-after-tab-switch', timeout: TERMINAL_TIMEOUT_MS },
    );

    await switchPaneTab(page, pane.id, 'Terminal');
    await page.locator(`${terminalSelector(pane.id)} .xterm-screen`).waitFor({
      state: 'visible',
      timeout: TERMINAL_TIMEOUT_MS,
    });
    await waitForVisibleTerminalText(page, pane.id, marker);

    await screenshot(page, '06-tab-remount-clean');
  }, 45_000);

  it('repaints an idle PTY pane after the application window is hidden and shown', async () => {
    await setTerminalTransport(app, page, 'pty');
    await showDashboardMode(page, 'fleet');
    const pane = await createShellPane(page, createdPanes);
    const beforeMarker = 'AUMX-WINDOW-HIDE-BEFORE';
    const hiddenMarker = 'AUMX-WINDOW-HIDE-DURING';
    const browserWindow = await app.browserWindow(page);

    onTestFinished(async () => {
      await setAppWindowVisibility(app, page, true);
    });

    await invoke(page, IPC.PANE_SEND_KEYS, {
      command: `printf '${beforeMarker}\\n'`,
      paneId: pane.id,
    });
    await waitForVisibleTerminalText(page, pane.id, beforeMarker);

    await setAppWindowVisibility(app, page, false);
    await pollUntil(
      async () => await browserWindow.evaluate((win) => !win.isVisible()) ? true : null,
      { interval: 50, label: 'application-window-hidden', timeout: TERMINAL_TIMEOUT_MS },
    );
    // app.hide() may not emit a BrowserWindow event on macOS. Give the
    // production visibility monitor one full fallback interval to suspend
    // delivery before output is written while hidden.
    await page.waitForTimeout(300);
    await invoke(page, IPC.PANE_SEND_KEYS, {
      command: `printf '${hiddenMarker}\\n'`,
      paneId: pane.id,
    });
    await waitForTmuxContent(pane.paneId, hiddenMarker);

    await setAppWindowVisibility(app, page, true);
    await pollUntil(
      async () => await browserWindow.evaluate((win) => ({
        minimized: win.isMinimized(),
        visible: win.isVisible(),
      })).then((state) => state.visible && !state.minimized ? true : null),
      { interval: 50, label: 'application-window-shown', timeout: TERMINAL_TIMEOUT_MS },
    );
    await waitForVisibleTerminalText(page, pane.id, hiddenMarker);
  }, 45_000);

  it('opens an old transcript-backed pane at a clean current frame instead of dirty startup history', async () => {
    const pane = await createShellPane(page, createdPanes);
    const lines = [
      OLD_PROJECT_LAUNCH_MARKER,
      'Claude Code v2.1.150',
      'Claude Code v2.1.150',
      ...Array.from({ length: 120 }, (_, index) => `AUMX-OLD-PROJECT-HISTORY-${String(index + 1).padStart(3, '0')}`),
      OLD_PROJECT_BOTTOM_MARKER,
    ];
    const outputCommand = `node -e ${JSON.stringify(`const lines = ${JSON.stringify(lines)}; for (const line of lines) console.log(line);`)}`;

    await invoke(page, IPC.PANE_SEND_KEYS, {
      command: outputCommand,
      paneId: pane.id,
    });
    await waitForTmuxContent(pane.paneId, OLD_PROJECT_BOTTOM_MARKER);
    await invoke(page, IPC.TERMINAL_DETACH, { paneId: pane.id });
    await showDashboardMode(page, 'settings');
    runTmux(['resize-window', '-t', pane.paneId, '-x', '220', '-y', '57']);
    runTmux(['resize-pane', '-t', pane.paneId, '-x', '220', '-y', '57']);

    await focusPane(page, pane.id);
    const snapshot = await waitForVisibleTerminalText(page, pane.id, OLD_PROJECT_BOTTOM_MARKER);
    const visibleText = snapshot.visibleLines.join('\n');
    expect(visibleText).not.toContain(OLD_PROJECT_LAUNCH_MARKER);
    expect(visibleText).not.toMatch(/Claude Code v2\.1\.150.*Claude Code v2\.1\.150/s);

    await screenshot(page, '07-old-project-clean-start');
  }, 45_000);

  it.each([
    {
      label: 'regular shell',
      profile: {} satisfies DeterministicTerminalProfile,
      profileKey: 'shell',
    },
    {
      label: 'Claude-profiled',
      profile: {
        agent: 'claude' as const,
        claudeRenderer: 'classic' as const,
        fixedCols: 100,
      } satisfies DeterministicTerminalProfile,
      profileKey: 'claude',
    },
    {
      label: 'OpenCode-profiled',
      profile: { agent: 'opencode' as const } satisfies DeterministicTerminalProfile,
      profileKey: 'opencode',
    },
  ])('scrolls a $label pane cleanly after repeated splitter resizing', async ({ profile, profileKey }) => {
    const ownedPanes: AumxPane[] = [];
    onTestFinished(async () => {
      for (const ownedPane of [...ownedPanes].reverse()) {
        await closePaneBestEffort(page, ownedPane);
      }
      const ownedPaneIds = new Set(ownedPanes.map((ownedPane) => ownedPane.id));
      for (let index = createdPanes.length - 1; index >= 0; index -= 1) {
        if (ownedPaneIds.has(createdPanes[index].id)) createdPanes.splice(index, 1);
      }
      if (!page.isClosed()) await page.setViewportSize({ height: 980, width: 1440 });
    });

    await setTerminalTransport(app, page, 'pty');
    await page.setViewportSize({ height: 980, width: 1800 });
    await showDashboardMode(page, 'settings');
    const sourcePane = await createShellPane(page, createdPanes, { waitForCommandReady: false });
    ownedPanes.push(sourcePane);
    const siblingSourcePane = await createShellPane(page, createdPanes, { waitForCommandReady: false });
    ownedPanes.push(siblingSourcePane);
    const outputCommand = [
      'node',
      '-e',
      '\'for (let i = 1; i <= 220; i += 1) console.log(`AUMX-SCROLLBACK-LINE-${String(i).padStart(3, "0")}`); console.log("AUMX-SCROLLBACK-DONE");\'',
    ].join(' ');
    // Seed while these are still ordinary, unattached shell panes. Renderer-
    // only agent profiles intentionally keep stdin locked until a real agent
    // advertises readiness; the deterministic fixture must not spoof that
    // lifecycle merely to produce shell history.
    const seedResponse = await invoke<{ error?: string; success: boolean }>(page, IPC.PANE_SEND_KEYS, {
      command: outputCommand,
      paneId: sourcePane.id,
    });
    expect(seedResponse.success, seedResponse.error).toBe(true);
    await waitForTmuxContent(sourcePane.paneId, SCROLLBACK_DONE_MARKER);
    // Let ConfigBridge's deliberate duplicate file-watch update land before
    // applying the deterministic renderer-only agent profile.
    await waitForConfigQuiescence(
      page,
      getProjectConfigPath(projectRoot),
      [sourcePane.id, siblingSourcePane.id],
    );
    const groupId = `e2e-scroll-resize-${profileKey}-${Date.now()}`;
    const { pane } = await showProfiledDuelPair(
      page,
      sourcePane,
      siblingSourcePane,
      groupId,
      profile,
    );
    await waitForStableTerminalSize(page, pane);
    await waitForVisibleTerminalText(page, pane.id, SCROLLBACK_DONE_MARKER);
    await expectIsolatedPtyViewSession(page, pane);
    await page.locator(`${terminalSelector(pane.id)} .xterm-screen`).click();
    await exerciseDuelSplitter(page, groupId, pane.id, 3);
    const geometryAfterResize = await waitForStableTerminalSize(page, pane);
    if (profile.fixedCols) {
      expect(geometryAfterResize.snapshot.info.cols).toBe(profile.fixedCols);
      expect(geometryAfterResize.tmuxSize.cols).toBe(profile.fixedCols);
    }
    await page.locator(`${terminalSelector(pane.id)} .xterm-screen`).click();

    const scrolled = await scrollPtyTerminalUp(page, pane);
    expect(scrolled.info.baseY).toBe(0);
    expect(scrolled.visibleLines.join('\n')).toContain(SCROLLBACK_FIRST_LINE);
    expect(scrolled.info.wheelHistory.some((event) => (
      event.consumedBy === 'tmux-scroll'
        && event.defaultPrevented
        && event.deltaY < 0
    ))).toBe(true);

    // tmux must retain the logical copy-mode cursor while xterm and the pane
    // geometry change underneath it. This catches scroll state that appears
    // correct until a user drags the separator one more time.
    await exerciseDuelSplitter(page, groupId, pane.id, 1);
    await waitForStableTerminalSize(page, pane);
    const afterCopyModeResize = await pollUntil(
      async () => {
        const snapshot = await getTerminalSnapshot(page, pane.id);
        const visibleText = snapshot?.visibleLines.join('\n') ?? '';
        return snapshot
          && visibleText.includes('AUMX-SCROLLBACK-LINE-')
          && !visibleText.includes(SCROLLBACK_DONE_MARKER)
          ? snapshot
          : null;
      },
      { interval: 100, label: 'copy-mode-history-after-resize', timeout: TERMINAL_TIMEOUT_MS },
    );
    expect(afterCopyModeResize?.visibleLines.join('\n')).toContain('AUMX-SCROLLBACK-LINE-');
    expect(runTmux(['display-message', '-p', '-t', pane.paneId, '#{pane_in_mode}']).trim()).toBe('1');
    const rescrolledAfterResize = await scrollPtyTerminalUp(page, pane);
    expect(rescrolledAfterResize.visibleLines.join('\n')).toContain(SCROLLBACK_FIRST_LINE);
    await page.locator(`${terminalSelector(pane.id)} .xterm-screen`).click();

    const liveView = await scrollPtyTerminalDown(page, pane, SCROLLBACK_DONE_MARKER);
    expect(liveView.visibleLines.join('\n')).toContain(SCROLLBACK_DONE_MARKER);
    expect(liveView.info.wheelHistory.some((event) => (
      event.consumedBy === 'tmux-scroll'
        && event.defaultPrevented
        && event.deltaY > 0
    ))).toBe(true);

    // Reproduce inertial trackpad pressure with several already-issued scroll
    // requests, then type immediately. Keyboard input must preempt the backlog,
    // leave copy-mode, and arrive intact at the shell prompt.
    await page.evaluate(({ channel, paneId }) => {
      const e2eWindow = window as unknown as E2EWindow;
      for (let index = 0; index < 24; index += 1) {
        void e2eWindow.aumx.invoke(channel, {
          direction: index % 2 === 0 ? 'up' : 'down',
          lines: 3,
          paneId,
        });
      }
    }, { channel: IPC.TERMINAL_SCROLL, paneId: pane.id });

    const inputAfterScrollMarker = `AUMX-INPUT-AFTER-SCROLL-${profileKey.toUpperCase()}`;
    await page.keyboard.type(`printf '${inputAfterScrollMarker}\\n'`);
    await page.keyboard.press('Enter');
    await waitForTmuxContent(pane.paneId, inputAfterScrollMarker);
    expect(runTmux(['display-message', '-p', '-t', pane.paneId, '#{pane_in_mode}']).trim()).toBe('0');

    await screenshot(page, `08-pty-${profileKey}-copy-mode-scroll-after-resize`);
  }, 90_000);

  it('preserves native text-input Copy through the application menu', async () => {
    const expectedText = 'AUMX-NATIVE-COPY-FALLBACK';
    await invoke(page, IPC.SYSTEM_CLIPBOARD_WRITE, { text: '' });
    await page.evaluate((text) => {
      const input = document.createElement('textarea');
      input.dataset.testid = 'native-copy-input';
      input.value = text;
      document.body.appendChild(input);
      input.focus();
      input.select();
    }, expectedText);

    try {
      await page.keyboard.press(process.platform === 'darwin' ? 'Meta+C' : 'Control+C');
      await page.waitForTimeout(250);
      const clipboardText = await invoke<{ text: string }>(page, IPC.SYSTEM_CLIPBOARD_READ);
      expect(clipboardText.text).toBe(expectedText);
    } finally {
      await page.evaluate(() => document.querySelector('[data-testid="native-copy-input"]')?.remove());
    }
  });

  it('preserves an ordinary one-viewport xterm selection through the application menu', async () => {
    await setTerminalTransport(app, page, 'pty');
    await showDashboardMode(page, 'fleet');
    const pane = await createShellPane(page, createdPanes);
    const marker = 'AUMX-ONE-VIEW-COPY';
    await invoke(page, IPC.PANE_SEND_KEYS, {
      command: `printf '\\n${marker}\\n'`,
      paneId: pane.id,
    });
    await waitForVisibleTerminalText(page, pane.id, marker);
    await invoke(page, IPC.SYSTEM_CLIPBOARD_WRITE, { text: '' });

    const screen = page.locator(`${terminalSelector(pane.id)} .xterm-screen`);
    const box = await screen.boundingBox();
    const snapshot = await getTerminalSnapshot(page, pane.id);
    expect(box).not.toBeNull();
    expect(snapshot).not.toBeNull();
    if (!box || !snapshot) throw new Error('one-viewport copy terminal was unavailable');
    const row = snapshot.visibleLines.findIndex((line) => line.trim() === marker);
    expect(row).toBeGreaterThanOrEqual(0);
    const column = snapshot.visibleLines[row].indexOf(marker);
    const cellWidth = box.width / (snapshot.info.cols ?? 80);
    const cellHeight = box.height / (snapshot.info.rows ?? snapshot.visibleLines.length);
    await page.mouse.click(
      box.x + (column + marker.length / 2) * cellWidth,
      box.y + (row + 0.5) * cellHeight,
      { clickCount: 3, delay: 40 },
    );

    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+C' : 'Control+C');
    await page.waitForTimeout(250);
    const clipboardText = await invoke<{ text: string }>(page, IPC.SYSTEM_CLIPBOARD_READ);
    expect(clipboardText.text.trim()).toBe(marker);
  }, 30_000);

  it('copies the complete PTY selection after scrolling beyond the first viewport', async () => {
    await setTerminalTransport(app, page, 'pty');
    await showDashboardMode(page, 'fleet');
    const pane = await createShellPane(page, createdPanes);
    const outputCommand = [
      'node',
      '-e',
      '\'for (let i = 1; i <= 220; i += 1) console.log(`AUMX-COPY-LINE-${String(i).padStart(3, "0")}-${"x".repeat(140)}`); console.log("AUMX-COPY-"+"DONE");\'',
    ].join(' ');

    const seedResponse = await invoke<{ error?: string; success: boolean }>(page, IPC.PANE_SEND_KEYS, {
      command: outputCommand,
      paneId: pane.id,
    });
    expect(seedResponse.success, seedResponse.error).toBe(true);
    await waitForTmuxContent(pane.paneId, 'AUMX-COPY-DONE');
    await waitForVisibleTerminalText(page, pane.id, 'AUMX-COPY-DONE');

    const screen = page.locator(`${terminalSelector(pane.id)} .xterm-screen`);
    await screen.click();
    await page.mouse.wheel(0, -16_000);
    await page.waitForTimeout(200);
    await page.mouse.wheel(0, -16_000);
    await waitForVisibleTerminalText(page, pane.id, 'AUMX-COPY-LINE-001');

    const box = await screen.boundingBox();
    expect(box).not.toBeNull();
    if (!box) throw new Error('terminal screen disappeared before selection');

    await page.mouse.move(box.x + 8, box.y + 8);
    await page.mouse.down();
    // A real selection drag emits no wheel event. Hold beyond the bottom edge
    // and prove the application continuously scrolls while the button remains
    // pressed.
    await page.mouse.move(box.x + box.width - 8, box.y + box.height + 25, { steps: 8 });
    await waitForVisibleTerminalText(page, pane.id, 'AUMX-COPY-DONE');
    const selectedAtBottom = await getTerminalSnapshot(page, pane.id);
    expect(selectedAtBottom?.info.selectionPosition?.start.y).toBe(
      selectedAtBottom?.info.viewportY,
    );
    expect(selectedAtBottom?.visibleLines.join('\n')).not.toContain('AUMX-COPY-LINE-001');
    await screenshot(page, '08a-pty-selection-visual-continuity');
    await page.mouse.move(box.x + box.width - 8, box.y + box.height - 8);
    await page.mouse.up();
    await page.keyboard.press('Meta+C');
    await page.waitForTimeout(500);

    const clipboardText = await invoke<{ text: string }>(page, IPC.SYSTEM_CLIPBOARD_READ);
    expect(clipboardText.text).toContain('AUMX-COPY-LINE-001');
    expect(clipboardText.text).toContain('AUMX-COPY-DONE');

    // Match the reported UX exactly: after copying, scroll back through the
    // selected range and verify the repainted viewport remains highlighted.
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, -16_000);
    await page.waitForTimeout(200);
    await page.mouse.wheel(0, -16_000);
    const selectedAfterScrollingBack = await pollUntil(
      async () => {
        const snapshot = await getTerminalSnapshot(page, pane.id);
        if (!snapshot || snapshot.visibleLines.join('\n').includes('AUMX-COPY-DONE')) return null;
        return snapshot;
      },
      { interval: 100, label: 'selection-highlight-after-scroll-back', timeout: TERMINAL_TIMEOUT_MS },
    );
    expect(
      selectedAfterScrollingBack.info.selectionPosition?.start.y,
      JSON.stringify({
        firstVisibleLine: selectedAfterScrollingBack.visibleLines[0],
        lastVisibleLine: selectedAfterScrollingBack.visibleLines.at(-1),
        selectionPosition: selectedAfterScrollingBack.info.selectionPosition,
        viewportY: selectedAfterScrollingBack.info.viewportY,
        wheelHistory: selectedAfterScrollingBack.info.wheelHistory.slice(-6),
      }),
    ).toBe(
      selectedAfterScrollingBack.info.viewportY,
    );
    await screenshot(page, '08b-pty-selection-highlight-after-scroll-back');
  }, 45_000);

  it('copies an exact native selection through a mouse-reporting alternate-screen TUI', async () => {
    await setTerminalTransport(app, page, 'pty');
    await showDashboardMode(page, 'settings');
    const sourcePane = await createShellPane(page, createdPanes, { waitForCommandReady: false });
    const siblingSourcePane = await createShellPane(page, createdPanes, { waitForCommandReady: false });
    const expectedMarkers = Array.from(
      { length: 90 },
      (_, index) => `AUMX-MOUSE-TUI-LINE-${String(index + 1).padStart(3, '0')}`,
    );
    const oldestMarker = expectedMarkers[0];
    const newestMarker = expectedMarkers.at(-1)!;
    const eventLogPath = join(projectRoot, `mouse-tui-events-${Date.now()}.log`);
    const launchResponse = await invoke<{ error?: string; success: boolean }>(page, IPC.PANE_SEND_KEYS, {
      command: `node ${JSON.stringify(MOUSE_REPORTING_TUI_FIXTURE)} ${JSON.stringify(eventLogPath)}`,
      paneId: sourcePane.id,
    });
    expect(launchResponse.success, launchResponse.error).toBe(true);
    await waitForTmuxContent(sourcePane.paneId, oldestMarker);

    const { pane } = await showProfiledDuelPair(
      page,
      sourcePane,
      siblingSourcePane,
      `e2e-mouse-tui-selection-${Date.now()}`,
      { agent: 'claude', claudeRenderer: 'fullscreen' },
    );
    await waitForStableTerminalSize(page, pane);
    await waitForVisibleTerminalText(page, pane.id, oldestMarker);
    const screen = page.locator(`${terminalSelector(pane.id)} .xterm-screen`);
    const box = await screen.boundingBox();
    expect(box).not.toBeNull();
    if (!box) throw new Error('Mouse-reporting TUI terminal screen has no bounding box');
    await invoke(page, IPC.SYSTEM_CLIPBOARD_WRITE, { text: '' });

    const selectionModifier = process.platform === 'darwin' ? 'Alt' : 'Shift';
    await page.keyboard.down(selectionModifier);
    await page.mouse.move(box.x + 1, box.y + 7);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width - 2, box.y + Math.min(120, box.height / 3), { steps: 4 });
    await pollUntil(
      async () => {
        const info = await page.evaluate((paneId) => (
          (window as unknown as E2EWindow).__aumxTerminalDebug?.getViewportInfo(paneId)
            ?.selectionPosition ?? null
        ), pane.id);
        return info ? true : null;
      },
      { interval: 25, label: 'mouse-tui-native-selection-started', timeout: TERMINAL_TIMEOUT_MS },
    );
    // Keep the pointer inside Chromium's viewport while entering the terminal's
    // bottom edge zone. Coordinates below the window are not delivered
    // consistently as document mousemove events in headless Electron.
    const finalFrame = await continueSelectionDragUntilTextVisible(
      page,
      pane.id,
      { x: box.x + box.width - 2, y: box.y + box.height - 2 },
      newestMarker,
    );
    expect(finalFrame.info.wheelHistory.some((event) => (
      event.consumedBy === 'agent-input' && event.defaultPrevented && event.deltaY > 0
    ))).toBe(true);
    await page.mouse.up();
    await page.keyboard.up(selectionModifier);
    const completedSelection = await pollUntil(
      async () => {
        const snapshot = await getTerminalSnapshot(page, pane.id);
        return snapshot?.info.selectionPosition === null ? snapshot : null;
      },
      { interval: 100, label: 'mouse-tui-hides-noncontiguous-highlight', timeout: TERMINAL_TIMEOUT_MS },
    );
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+C' : 'Control+C');

    const expectedClipboard = [
      'AUMX-MOUSE-TUI-HEADER',
      ...expectedMarkers,
      'AUMX-MOUSE-TUI-FOOTER',
    ].join('\n');
    const clipboard = await pollUntil(
      async () => {
        const read = await invoke<{ text: string }>(page, IPC.SYSTEM_CLIPBOARD_READ);
        return read.text === expectedClipboard ? read : null;
      },
      { interval: 100, label: 'mouse-tui-exact-clipboard', timeout: TERMINAL_TIMEOUT_MS },
    );
    expect(
      clipboard.text,
      JSON.stringify(completedSelection.info.wheelHistory.slice(-8)),
    ).toBe(expectedClipboard);
    expect(runTmux(['display-message', '-p', '-t', pane.paneId, '#{alternate_on}']).trim()).toBe('1');
    expect(readFileSync(eventLogPath, 'utf8').split('\n')).toContain('wheel:down');

    // Review the frozen range: its fixed header/footer make the visible slice
    // non-contiguous, so the honest representation is no highlight while the
    // verified logical range remains exactly copyable.
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    for (let attempt = 0; attempt < expectedMarkers.length; attempt += 1) {
      await page.mouse.wheel(0, -16_000);
      await page.waitForTimeout(150);
      const snapshot = await getTerminalSnapshot(page, pane.id);
      if (snapshot?.visibleLines.join('\n').includes(oldestMarker)) break;
    }
    await waitForVisibleTerminalText(page, pane.id, oldestMarker);
    for (let attempt = 0; attempt < expectedMarkers.length; attempt += 1) {
      await page.mouse.wheel(0, 16_000);
      await page.waitForTimeout(150);
      const snapshot = await getTerminalSnapshot(page, pane.id);
      if (snapshot?.visibleLines.join('\n').includes(newestMarker)) break;
    }
    const reviewedFrame = await waitForVisibleTerminalText(page, pane.id, newestMarker);
    expect(reviewedFrame.info.selectionPosition).toBeNull();
    await invoke(page, IPC.SYSTEM_CLIPBOARD_WRITE, { text: '' });
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+C' : 'Control+C');
    const reviewedClipboard = await pollUntil(
      async () => {
        const read = await invoke<{ text: string }>(page, IPC.SYSTEM_CLIPBOARD_READ);
        return read.text === expectedClipboard ? read : null;
      },
      { interval: 100, label: 'mouse-tui-reviewed-clipboard', timeout: TERMINAL_TIMEOUT_MS },
    );
    expect(reviewedClipboard.text).toBe(expectedClipboard);

    await page.keyboard.press('q');
  }, 60_000);

  it('rolls a completed range back to its last-verified text when an edge scroll is silent', async () => {
    await setTerminalTransport(app, page, 'pty');
    await showDashboardMode(page, 'settings');
    const sourcePane = await createShellPane(page, createdPanes, { waitForCommandReady: false });
    const siblingSourcePane = await createShellPane(page, createdPanes, { waitForCommandReady: false });
    const oldestMarker = 'AUMX-MOUSE-TUI-LINE-001';
    const eventLogPath = join(projectRoot, `mouse-tui-silent-events-${Date.now()}.log`);
    onTestFinished(() => rmSync(eventLogPath, { force: true }));
    const launchResponse = await invoke<{ error?: string; success: boolean }>(page, IPC.PANE_SEND_KEYS, {
      command: `node ${JSON.stringify(MOUSE_REPORTING_TUI_FIXTURE)} ${JSON.stringify(eventLogPath)}`,
      paneId: sourcePane.id,
    });
    expect(launchResponse.success, launchResponse.error).toBe(true);
    await waitForTmuxContent(sourcePane.paneId, oldestMarker);

    const { pane } = await showProfiledDuelPair(
      page,
      sourcePane,
      siblingSourcePane,
      `e2e-mouse-tui-silent-${Date.now()}`,
      { agent: 'claude', claudeRenderer: 'fullscreen' },
    );
    await waitForStableTerminalSize(page, pane);
    await waitForVisibleTerminalText(page, pane.id, oldestMarker);
    const screen = page.locator(`${terminalSelector(pane.id)} .xterm-screen`);
    const box = await screen.boundingBox();
    expect(box).not.toBeNull();
    if (!box) throw new Error('Silent-boundary TUI terminal screen has no bounding box');
    await invoke(page, IPC.SYSTEM_CLIPBOARD_WRITE, { text: '' });

    // A shallow selection released inside the viewport: no auto-scroll, so the
    // fixture stays pinned at its top row and its anchor stays on screen.
    const selectionModifier = process.platform === 'darwin' ? 'Alt' : 'Shift';
    let verifiedSelection: TerminalSnapshot | null = null;
    for (let attempt = 0; attempt < 3 && !verifiedSelection; attempt += 1) {
      await page.keyboard.down(selectionModifier);
      await page.mouse.move(box.x + 1, box.y + 7);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width - 2, box.y + 40, { steps: 4 });
      await page.mouse.up();
      await page.keyboard.up(selectionModifier);
      verifiedSelection = await waitForStableSelectionPosition(page, pane.id, 2_000).catch(() => null);
    }
    if (!verifiedSelection) {
      throw new Error(`silent-boundary selection setup failed after three gestures for ${pane.id}`);
    }
    expect(verifiedSelection.info.selectionPosition).not.toBeNull();

    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+C' : 'Control+C');
    const lastVerified = await pollUntil(
      async () => {
        const read = await invoke<{ text: string }>(page, IPC.SYSTEM_CLIPBOARD_READ);
        return read.text.length > 0 ? read : null;
      },
      { interval: 100, label: 'silent-boundary-last-verified', timeout: TERMINAL_TIMEOUT_MS },
    );
    expect(lastVerified.text).toContain(oldestMarker);

    // Enable the fixture's silent-edge mode, then scroll up at the clamped top
    // row. The fixture emits no repaint, so the review step must stall and roll
    // the highlight back without touching the verified range.
    await page.keyboard.press('e');
    await pollUntil(
      async () => readFileSync(eventLogPath, 'utf8').split('\n').includes('silent-edge:on')
        ? true
        : null,
      { interval: 50, label: 'silent-edge-ready', timeout: TERMINAL_TIMEOUT_MS },
    );
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await invoke(page, IPC.SYSTEM_CLIPBOARD_WRITE, { text: '' });
    await page.mouse.wheel(0, -16_000);
    const verifiedPosition = verifiedSelection.info.selectionPosition!;
    const positionSignature = (position: TerminalDebugInfo['selectionPosition']): string =>
      JSON.stringify(position);
    await pollUntil(
      async () => readFileSync(eventLogPath, 'utf8').split('\n').includes('wheel:up')
        ? true
        : null,
      { interval: 50, label: 'silent-boundary-wheel-dispatched', timeout: TERMINAL_TIMEOUT_MS },
    );
    await page.waitForTimeout(650);
    const rolledBack = await pollUntil(
      async () => {
        const snapshot = await getTerminalSnapshot(page, pane.id);
        return snapshot?.info.selectionPosition
          && positionSignature(snapshot.info.selectionPosition) === positionSignature(verifiedPosition)
          ? snapshot
          : null;
      },
      { interval: 50, label: 'silent-boundary-rolled-back-position', timeout: TERMINAL_TIMEOUT_MS },
    );
    expect(rolledBack.info.selectionPosition).toEqual(verifiedPosition);

    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+C' : 'Control+C');
    const afterSilentEdge = await pollUntil(
      async () => {
        const read = await invoke<{ text: string }>(page, IPC.SYSTEM_CLIPBOARD_READ);
        return read.text === lastVerified.text ? read : null;
      },
      { interval: 100, label: 'silent-boundary-copy-preserved', timeout: TERMINAL_TIMEOUT_MS },
    );
    expect(afterSilentEdge.text).toBe(lastVerified.text);
    expect(await page.getByText('Selection could not be copied completely').count()).toBe(0);

    await page.keyboard.press('q');
  }, 60_000);

  it('scrolls an OpenCode-profiled alternate-screen TUI after repeated splitter resizing', async () => {
    const ownedPanes: AumxPane[] = [];
    onTestFinished(async () => {
      for (const ownedPane of [...ownedPanes].reverse()) {
        await closePaneBestEffort(page, ownedPane);
      }
      const ownedPaneIds = new Set(ownedPanes.map((ownedPane) => ownedPane.id));
      for (let index = createdPanes.length - 1; index >= 0; index -= 1) {
        if (ownedPaneIds.has(createdPanes[index].id)) createdPanes.splice(index, 1);
      }
      if (!page.isClosed()) await page.setViewportSize({ height: 980, width: 1440 });
    });

    await setTerminalTransport(app, page, 'pty');
    await page.setViewportSize({ height: 980, width: 1800 });
    await showDashboardMode(page, 'settings');
    const sourcePane = await createShellPane(page, createdPanes, { waitForCommandReady: false });
    ownedPanes.push(sourcePane);
    const siblingSourcePane = await createShellPane(page, createdPanes, { waitForCommandReady: false });
    ownedPanes.push(siblingSourcePane);

    const oldestMarker = 'AUMX-OPENCODE-MESSAGE-001';
    const newestMarker = 'AUMX-OPENCODE-MESSAGE-080';
    const expectedMarkers = Array.from(
      { length: 80 },
      (_, index) => `AUMX-OPENCODE-MESSAGE-${String(index + 1).padStart(3, '0')}`,
    );
    const expectCompleteMarkerSequence = (text: string): void => {
      expect(text.match(/AUMX-OPENCODE-MESSAGE-\d{3}/g) ?? []).toEqual(expectedMarkers);
    };
    // The fixture sizes its frame from the live pane height and repaints on
    // SIGWINCH, exactly like a real alternate-screen TUI. A fixed frame height
    // would silently scroll its top line off whenever tmux hands the pane fewer
    // rows than the fixture assumed.
    const tuiScript = [
      'const { execFileSync } = require("node:child_process");',
      'const lines = Array.from({ length: 80 }, (_, index) => "AUMX-OPENCODE-MESSAGE-" + String(index + 1).padStart(3, "0"));',
      'let top = lines.length;',
      'let exiting = false;',
      'let renderedRows = 0;',
      'const visibleRows = () => {',
      '  try {',
      '    const paneRows = Number.parseInt(execFileSync("tmux", ["display-message", "-p", "-t", process.env.TMUX_PANE, "#{pane_height}"], { encoding: "utf8" }).trim(), 10);',
      '    if (Number.isFinite(paneRows)) return Math.max(1, Math.min(lines.length, paneRows));',
      '  } catch {}',
      '  return Math.max(1, Math.min(lines.length, process.stdout.rows || 24));',
      '};',
      'const render = () => {',
      '  const rows = visibleRows();',
      '  const wasAtBottom = top + renderedRows >= lines.length;',
      '  top = wasAtBottom ? lines.length - rows : Math.max(0, Math.min(lines.length - rows, top));',
      '  renderedRows = rows;',
      '  process.stdout.write("\\x1b[2J\\x1b[H" + lines.slice(top, top + rows).join("\\r\\n"));',
      '};',
      'const finish = () => {',
      '  if (exiting) return;',
      '  exiting = true;',
      '  clearInterval(resizeTimer);',
      '  if (process.stdin.isTTY) process.stdin.setRawMode(false);',
      '  process.stdout.write("\\x1b[?1006l\\x1b[?1002l\\x1b[?25h\\x1b[?1049l", () => process.exit(0));',
      '};',
      'process.stdin.setRawMode(true);',
      'process.stdin.resume();',
      // OpenCode enables alternate-screen and mouse reporting. The production
      // OpenCode renderer filters those mouse enables (unless passthrough is
      // explicitly selected), then main routes wheel input using live tmux
      // alternate-screen state and OpenCode's Esc+Ctrl-Y/E protocol.
      'process.stdout.write("\\x1b[?1049h\\x1b[?25l\\x1b[?1002h\\x1b[?1006h");',
      'render();',
      'process.stdout.on("resize", render);',
      // Detached/manual tmux windows do not reliably surface SIGWINCH through
      // Node's stdout resize event. Poll the authoritative tmux grid so this
      // deterministic fixture behaves like a real TUI resize loop.
      'const resizeTimer = setInterval(() => { if (visibleRows() !== renderedRows) render(); }, 50);',
      'process.stdin.on("data", (data) => {',
      '  for (const byte of data) {',
      '    if (byte === 25) top -= 1;',
      '    if (byte === 5) top += 1;',
      '    if (byte === 3 || byte === 113) return finish();',
      '  }',
      '  render();',
      '});',
      'process.on("SIGTERM", finish);',
    ].join(' ');
    const launchResponse = await invoke<{ error?: string; success: boolean }>(page, IPC.PANE_SEND_KEYS, {
      command: `node -e ${JSON.stringify(tuiScript)}`,
      paneId: sourcePane.id,
    });
    expect(launchResponse.success, launchResponse.error).toBe(true);
    try {
      await waitForTmuxContent(sourcePane.paneId, newestMarker);
    } catch (error) {
      const paneContent = runTmux(['capture-pane', '-t', sourcePane.paneId, '-p', '-S', '-120']);
      throw new Error(`${error instanceof Error ? error.message : String(error)}; pane=${JSON.stringify(paneContent)}`);
    }
    await waitForConfigQuiescence(
      page,
      getProjectConfigPath(projectRoot),
      [sourcePane.id, siblingSourcePane.id],
    );
    const groupId = `e2e-opencode-tui-scroll-${Date.now()}`;
    const { pane } = await showProfiledDuelPair(
      page,
      sourcePane,
      siblingSourcePane,
      groupId,
      { agent: 'opencode' },
    );
    await waitForStableTerminalSize(page, pane);
    const bootView = await waitForVisibleTerminalText(page, pane.id, newestMarker);
    expect(
      bootView.visibleLines.join('\n'),
      'OpenCode TUI must start below its oldest message so scrolling is exercised',
    ).not.toContain(oldestMarker);
    await expectIsolatedPtyViewSession(page, pane);
    await exerciseDuelSplitter(page, groupId, pane.id, 3);
    await waitForStableTerminalSize(page, pane);

    const screen = page.locator(`${terminalSelector(pane.id)} .xterm-screen`);
    await screen.click();
    await invoke(page, IPC.SYSTEM_CLIPBOARD_WRITE, { text: '' });
    const screenBox = await screen.boundingBox();
    expect(screenBox).not.toBeNull();
    if (!screenBox) throw new Error('OpenCode TUI terminal screen has no bounding box');
    await page.mouse.move(screenBox.x + screenBox.width / 2, screenBox.y + screenBox.height - 8);
    await page.mouse.down();
    const atTop = await continueSelectionDragUntilTextVisible(
      page,
      pane.id,
      { x: screenBox.x + screenBox.width / 2, y: screenBox.y - 25 },
      oldestMarker,
    );
    await page.mouse.up();
    expect(atTop, 'OpenCode TUI did not reach its oldest message').not.toBeNull();
    expect(atTop.info.selectionPosition).not.toBeNull();
    expect(atTop.info.wheelHistory.some((event) => (
      event.consumedBy === 'tmux-scroll'
        && event.defaultPrevented
        && event.deltaY < 0
    ))).toBe(true);
    expect(runTmux(['display-message', '-p', '-t', pane.paneId, '#{pane_in_mode}']).trim()).toBe('0');
    expect(runTmux(['display-message', '-p', '-t', pane.paneId, '#{alternate_on}']).trim()).toBe('1');

    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+C' : 'Control+C');
    await page.waitForTimeout(500);
    const clipboardText = await invoke<{ text: string }>(page, IPC.SYSTEM_CLIPBOARD_READ);
    expectCompleteMarkerSequence(clipboardText.text);

    // Match the reported UX: copying must not discard the logical selection,
    // and scrolling back through an OpenCode repaint must keep the visible
    // portion highlighted.
    let selectedAtBottom: TerminalSnapshot | null = null;
    await page.mouse.move(
      screenBox.x + screenBox.width / 2,
      screenBox.y + screenBox.height / 2,
    );
    for (let attempt = 0; attempt < expectedMarkers.length && !selectedAtBottom; attempt += 1) {
      await page.mouse.wheel(0, 16_000);
      await page.waitForTimeout(200);
      const snapshot = await getTerminalSnapshot(page, pane.id);
      if (snapshot?.visibleLines.join('\n').includes(newestMarker)) selectedAtBottom = snapshot;
    }
    expect(selectedAtBottom, 'OpenCode selection did not scroll back to its newest message').not.toBeNull();
    expect(selectedAtBottom?.info.selectionPosition).not.toBeNull();
    await screenshot(page, '08b-pty-opencode-selection-after-scroll-back');
    await invoke(page, IPC.SYSTEM_CLIPBOARD_WRITE, { text: '' });
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+C' : 'Control+C');
    await page.waitForTimeout(500);
    const recopiedText = await invoke<{ text: string }>(page, IPC.SYSTEM_CLIPBOARD_READ);
    expectCompleteMarkerSequence(recopiedText.text);

    for (let attempt = 0; attempt < expectedMarkers.length; attempt += 1) {
      await page.mouse.wheel(0, -16_000);
      await page.waitForTimeout(200);
      const snapshot = await getTerminalSnapshot(page, pane.id);
      if (snapshot?.visibleLines.join('\n').includes(oldestMarker)) break;
    }
    await waitForVisibleTerminalText(page, pane.id, oldestMarker);

    // Reproduce the forward gesture reported by users: start at the oldest
    // visible row, keep the mouse held while OpenCode scrolls down, then copy.
    await screen.click();
    await invoke(page, IPC.SYSTEM_CLIPBOARD_WRITE, { text: '' });
    await page.mouse.move(screenBox.x + 1, screenBox.y + 1);
    await page.mouse.down();
    const forwardAtBottom = await continueSelectionDragUntilTextVisible(
      page,
      pane.id,
      {
        x: screenBox.x + screenBox.width / 2,
        y: screenBox.y + screenBox.height - 2,
      },
      newestMarker,
    );
    await page.mouse.up();
    expect(forwardAtBottom.info.selectionPosition).not.toBeNull();
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+C' : 'Control+C');
    await page.waitForTimeout(500);
    const forwardClipboardText = await invoke<{ text: string }>(page, IPC.SYSTEM_CLIPBOARD_READ);
    expectCompleteMarkerSequence(forwardClipboardText.text);

    await page.mouse.move(
      screenBox.x + screenBox.width / 2,
      screenBox.y + screenBox.height / 2,
    );
    for (let attempt = 0; attempt < expectedMarkers.length; attempt += 1) {
      await page.mouse.wheel(0, -16_000);
      await page.waitForTimeout(200);
      const snapshot = await getTerminalSnapshot(page, pane.id);
      if (snapshot?.visibleLines.join('\n').includes(oldestMarker)) break;
    }
    await waitForVisibleTerminalText(page, pane.id, oldestMarker);

    await exerciseDuelSplitter(page, groupId, pane.id, 1);
    await waitForStableTerminalSize(page, pane);
    await waitForVisibleTerminalText(page, pane.id, oldestMarker);
    await screen.click();

    let atBottom: TerminalSnapshot | null = null;
    for (let attempt = 0; attempt < 12 && !atBottom; attempt += 1) {
      await page.mouse.wheel(0, 16_000);
      await page.waitForTimeout(200);
      const snapshot = await getTerminalSnapshot(page, pane.id);
      if (snapshot?.visibleLines.join('\n').includes(newestMarker)) atBottom = snapshot;
    }
    expect(atBottom, 'OpenCode TUI did not return to its newest message').not.toBeNull();
    expect(atBottom?.info.wheelHistory.some((event) => (
      event.consumedBy === 'tmux-scroll'
        && event.defaultPrevented
        && event.deltaY > 0
    ))).toBe(true);
    expect(runTmux(['display-message', '-p', '-t', pane.paneId, '#{pane_in_mode}']).trim()).toBe('0');
    expect(runTmux(['display-message', '-p', '-t', pane.paneId, '#{alternate_on}']).trim()).toBe('1');

    await page.keyboard.press('q');
    await pollUntil(
      async () => runTmux(['display-message', '-p', '-t', pane.paneId, '#{alternate_on}']).trim() === '0'
        ? true
        : null,
      { interval: 100, label: 'OpenCode-TUI-exit', timeout: TERMINAL_TIMEOUT_MS },
    );
    await screenshot(page, '08b-pty-opencode-tui-scroll-after-resize');
  }, 90_000);

  it('scrolls an alternate-screen TUI with arrow keys instead of freezing it in copy-mode', async () => {
    await setTerminalTransport(app, page, 'pty');
    const pane = await createShellPane(page, createdPanes);
    const altScrollPath = `/tmp/aumx-e2e-alt-scroll-${pane.id.replace(/[^a-zA-Z0-9]/g, '')}.txt`;
    onTestFinished(() => rmSync(altScrollPath, { force: true }));
    const generateScript = 'const fs = require("fs"); const lines = Array.from({ length: 200 }, (_, i) => "AUMX-ALT-LINE-" + String(i + 1).padStart(3, "0")); fs.writeFileSync(process.argv[1], lines.join(String.fromCharCode(10)));';
    const generateAndLaunchCommand = [
      'node',
      '-e',
      JSON.stringify(generateScript),
      JSON.stringify(altScrollPath),
      '&& exec less +G',
      JSON.stringify(altScrollPath),
    ].join(' ');

    await invoke(page, IPC.PANE_SEND_KEYS, {
      command: generateAndLaunchCommand,
      paneId: pane.id,
    });
    await waitForTmuxContent(pane.paneId, 'AUMX-ALT-LINE-200');
    await focusPane(page, pane.id);
    await waitForVisibleTerminalText(page, pane.id, 'AUMX-ALT-LINE-200');
    expect(runTmux(['display-message', '-p', '-t', pane.paneId, '#{alternate_on}']).trim()).toBe('1');

    const screen = page.locator(`${terminalSelector(pane.id)} .xterm-screen`);
    await screen.waitFor({ state: 'visible', timeout: TERMINAL_TIMEOUT_MS });
    const box = await screen.boundingBox();
    expect(box).not.toBeNull();
    if (!box) throw new Error('alt-screen-scroll: missing terminal screen');
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);

    let sawEarlyLines = false;
    for (let attempt = 0; attempt < 20 && !sawEarlyLines; attempt += 1) {
      await page.mouse.wheel(0, -16_000);
      await page.waitForTimeout(200);
      const snapshot = await getTerminalSnapshot(page, pane.id);
      sawEarlyLines = snapshot?.visibleLines.join('\n').includes('AUMX-ALT-LINE-0') ?? false;
    }

    expect(sawEarlyLines).toBe(true);
    expect(runTmux(['display-message', '-p', '-t', pane.paneId, '#{pane_in_mode}']).trim()).toBe('0');
    expect(runTmux(['display-message', '-p', '-t', pane.paneId, '#{alternate_on}']).trim()).toBe('1');

    let backAtEnd = false;
    for (let attempt = 0; attempt < 20 && !backAtEnd; attempt += 1) {
      await page.mouse.wheel(0, 16_000);
      await page.waitForTimeout(200);
      const snapshot = await getTerminalSnapshot(page, pane.id);
      backAtEnd = snapshot?.visibleLines.join('\n').includes('AUMX-ALT-LINE-200') ?? false;
    }
    expect(backAtEnd).toBe(true);

    await screenshot(page, '09-pty-alternate-screen-arrow-scroll');
  }, 60_000);

  it('keeps a fixed-grid terminal exact and unclipped across responsive Fleet breakpoints', async () => {
    await setTerminalTransport(app, page, 'pty');
    await showDashboardMode(page, 'settings');
    const sourcePane = await createShellPane(page, createdPanes, { waitForCommandReady: false });
    const siblingPane = await createShellPane(page, createdPanes, { waitForCommandReady: false });
    const configPath = getProjectConfigPath(projectRoot);
    await waitForConfigQuiescence(page, configPath, [sourcePane.id, siblingPane.id]);
    const config = JSON.parse(readFileSync(configPath, 'utf-8')) as AumxConfig;
    const persistedSourcePane = config.panes.find((pane) => pane.id === sourcePane.id);
    const persistedSiblingPane = config.panes.find((pane) => pane.id === siblingPane.id);
    if (!persistedSourcePane || !persistedSiblingPane) {
      throw new Error('Newly created E2E panes were not persisted before profile setup');
    }
    const profiledSourcePane: AumxPane = {
      ...persistedSourcePane,
      agent: 'claude',
      agentStatus: 'idle',
      claudeRenderer: 'classic',
      terminalFixedCols: 100,
      shellType: undefined,
      type: undefined,
    };
    config.panes = [
      profiledSourcePane,
      persistedSiblingPane,
      ...config.panes.filter((pane) => pane.id !== sourcePane.id && pane.id !== siblingPane.id),
    ];
    config.lastUpdated = new Date().toISOString();
    atomicWriteJsonSync(configPath, config);

    const fixedPane = await pollUntil(
      async () => {
        const pane = (await getPanes(page)).find((candidate) => candidate.id === sourcePane.id);
        return pane?.claudeRenderer === 'classic' && pane.terminalFixedCols === 100 ? pane : null;
      },
      { interval: 100, label: 'persisted-fixed-terminal-profile', timeout: TERMINAL_TIMEOUT_MS },
    );
    const fixedGridReadyMarker = 'AUMX-FIXED-GRID-READY';
    await invoke(page, IPC.PANE_SEND_KEYS, {
      command: `printf '▐▛███▜▌ ${fixedGridReadyMarker}\\n▝▜█████▛▘  ⏵⏵  ←  ❯\\n'`,
      paneId: fixedPane.id,
    });
    await waitForTmuxContent(fixedPane.paneId, fixedGridReadyMarker);

    await page.setViewportSize({ height: 760, width: 820 });
    await page.evaluate(({ panes }) => {
      const stores = (window as unknown as E2EWindow).__aumxStores;
      stores?.pane?.getState().setPanes(panes);
      stores?.ui?.getState().setActiveView('dashboard');
      stores?.ui?.getState().setViewMode('fleet');
    }, { panes: [fixedPane, siblingPane] });

    const grid = page.locator('[data-fleet-column-count]');
    await grid.waitFor({ state: 'visible', timeout: TERMINAL_TIMEOUT_MS });
    await pollUntil(
      async () => (await grid.getAttribute('data-fleet-column-count')) === '1' ? true : null,
      { interval: 100, label: 'narrow-fleet-one-column', timeout: TERMINAL_TIMEOUT_MS },
    );
    await page.locator(`${terminalSelector(fixedPane.id)} .xterm-screen`).waitFor({
      state: 'visible',
      timeout: TERMINAL_TIMEOUT_MS,
    });
    await waitForVisibleTerminalText(page, fixedPane.id, fixedGridReadyMarker);

    const assertFixedGeometry = async (label: string): Promise<TerminalLayoutMetrics> => pollUntil(
      async () => {
        const snapshot = await getTerminalSnapshot(page, fixedPane.id);
        if (!snapshot?.info.cols || !snapshot.info.rows) return null;
        const tmuxSize = readTmuxPaneSize(fixedPane.paneId);
        const metrics = await getTerminalLayoutMetrics(page, fixedPane.id);
        const exact = snapshot.info.cols === 100
          && tmuxSize.cols === 100
          && tmuxSize.rows === snapshot.info.rows
          && metrics.screenRightOverflow <= 1
          && metrics.screenBottomOverflow <= 1;
        if (exact) return metrics;
        throw new Error(JSON.stringify({
          snapshot: { cols: snapshot.info.cols, rows: snapshot.info.rows },
          tmuxSize,
          screenBottomOverflow: metrics.screenBottomOverflow,
          screenRightOverflow: metrics.screenRightOverflow,
        }));
      },
      { interval: 200, label, timeout: TERMINAL_GEOMETRY_TIMEOUT_MS },
    );

    const narrowMetrics = await assertFixedGeometry('narrow-fixed-fleet-geometry');
    expect(narrowMetrics.rootWidth).toBeGreaterThan(500);
    await screenshot(page, '10-fixed-grid-narrow-fleet');

    await page.setViewportSize({ height: 980, width: 1600 });
    await pollUntil(
      async () => (await grid.getAttribute('data-fleet-column-count')) === '2' ? true : null,
      { interval: 100, label: 'wide-fleet-two-columns', timeout: TERMINAL_TIMEOUT_MS },
    );
    const wideMetrics = await assertFixedGeometry('wide-fixed-fleet-geometry');
    expect(wideMetrics.rootWidth).toBeGreaterThan(500);
    expect(readTmuxPaneSize(fixedPane.paneId).cols).toBe(100);
    await screenshot(page, '11-fixed-grid-wide-fleet');

    try {
      await invoke(page, IPC.ELECTRON_SETTINGS_UPDATE, { key: 'uiZoom', value: 1.5 });
      await page.waitForTimeout(400);
      await invoke(page, IPC.ELECTRON_SETTINGS_UPDATE, { key: 'uiZoom', value: 1.2 });
      await pollUntil(
        async () => (await grid.getAttribute('data-fleet-column-count')) === '2' ? true : null,
        { interval: 100, label: 'post-zoom-wide-fleet-two-columns', timeout: TERMINAL_TIMEOUT_MS },
      );
      await assertFixedGeometry('post-zoom-fixed-fleet-geometry');
      await waitForVisibleTerminalText(page, fixedPane.id, fixedGridReadyMarker);
      await screenshot(page, '12-fixed-grid-after-zoom-cycle');
    } finally {
      await invoke(page, IPC.ELECTRON_SETTINGS_UPDATE, { key: 'uiZoom', value: 1 });
    }

    await page.setViewportSize({ height: 980, width: 1440 });
  }, 90_000);

  it('moves keyboard focus to a fleet pane selected outside the terminal body', async () => {
    await showDashboardMode(page, 'fleet');
    const firstPane = await createShellPane(page, createdPanes);
    const secondPane = await createShellPane(page, createdPanes);

    try {
      const firstCell = page.locator(`[data-testid="pane-cell"][data-pane-id="${firstPane.id}"]`).first();
      const secondCell = page.locator(`[data-testid="pane-cell"][data-pane-id="${secondPane.id}"]`).first();
      const firstHeader = firstCell.locator(':scope > div').first();
      const secondScreen = page.locator(`${terminalSelector(secondPane.id)} .xterm-screen`);
      await firstCell.waitFor({ state: 'visible', timeout: TERMINAL_TIMEOUT_MS });
      await secondCell.waitFor({ state: 'visible', timeout: TERMINAL_TIMEOUT_MS });
      await secondScreen.waitFor({ state: 'visible', timeout: TERMINAL_TIMEOUT_MS });
      await pollUntil(
        async () => page.evaluate((paneId) => (
          (window as unknown as E2EWindow).__aumxTerminalDebug?.getViewportInfo(paneId)?.attachHistory
            .some((event) => event.action === 'attach-success') ?? false
        ), firstPane.id),
        { interval: 50, label: 'first-terminal-attached', timeout: TERMINAL_TIMEOUT_MS },
      );
      await secondScreen.click();

      const focusedPaneId = async (): Promise<string | null> => page.evaluate(() => (
        document.activeElement?.closest('[data-testid="interactive-terminal"]')?.getAttribute('data-pane-id') ?? null
      ));
      await pollUntil(
        async () => (await focusedPaneId()) === secondPane.id ? true : null,
        { interval: 50, label: 'second-terminal-focused', timeout: TERMINAL_TIMEOUT_MS },
      );

      // Header selection previously changed only the purple selection border;
      // the hidden xterm textarea stayed in the other pane and received typing.
      await firstHeader.click();
      await pollUntil(
        async () => (await focusedPaneId()) === firstPane.id ? true : null,
        { interval: 50, label: 'selected-terminal-focused', timeout: TERMINAL_TIMEOUT_MS },
      );

      const marker = 'AUMX-SELECTED-PANE-INPUT';
      await page.keyboard.type(`printf '${marker}\\n'`);
      await page.keyboard.press('Enter');
      await waitForTmuxContent(firstPane.paneId, marker);
      expect(runTmux(['capture-pane', '-t', secondPane.paneId, '-p', '-S', '-40'])).not.toContain(marker);
    } finally {
      await closePaneBestEffort(page, secondPane);
      await closePaneBestEffort(page, firstPane);
      const secondPaneIndex = createdPanes.indexOf(secondPane);
      if (secondPaneIndex >= 0) createdPanes.splice(secondPaneIndex, 1);
      const firstPaneIndex = createdPanes.indexOf(firstPane);
      if (firstPaneIndex >= 0) createdPanes.splice(firstPaneIndex, 1);
    }
  }, 45_000);

  it('keeps typed input on the same PTY across attention transitions and overlay cycles', async () => {
    await showDashboardMode(page, 'fleet');
    const firstPane = await createShellPane(page, createdPanes);
    const secondPane = await createShellPane(page, createdPanes);

    try {
      await page.locator(`${terminalSelector(secondPane.id)} .xterm-screen`).waitFor({
        state: 'visible',
        timeout: TERMINAL_TIMEOUT_MS,
      });
      await clickTerminalAndWaitForFocus(page, firstPane.id);

      await setRendererPaneStatus(page, [firstPane.id, secondPane.id], 'waiting');
      await page.locator(ATTENTION_STAT).waitFor({ state: 'visible', timeout: TERMINAL_TIMEOUT_MS });

      await cycleOverlay(page, async () => page.locator(ATTENTION_STAT).click(), ATTENTION_PEEK);
      await cycleOverlay(page, async () => page.keyboard.press('Meta+k'), COMMAND_PALETTE);

      await setRendererPaneStatus(page, [firstPane.id, secondPane.id], 'idle');
      await pollUntil(
        async () => ((await page.locator(ATTENTION_STAT).count()) === 0 ? true : null),
        { interval: 50, label: 'attention-stat-cleared', timeout: TERMINAL_TIMEOUT_MS },
      );

      // The overlays borrowed focus; the terminal must still own its own PTY.
      await clickTerminalAndWaitForFocus(page, firstPane.id);
      const marker = 'AUMX-OVERLAY-CYCLE-INPUT';
      await page.keyboard.type(`printf '${marker}\\n'`);
      await page.keyboard.press('Enter');

      await waitForTmuxContent(firstPane.paneId, marker);
      expect(runTmux(['capture-pane', '-t', secondPane.paneId, '-p', '-S', '-40'])).not.toContain(marker);
    } finally {
      await closePaneBestEffort(page, secondPane);
      await closePaneBestEffort(page, firstPane);
      const secondPaneIndex = createdPanes.indexOf(secondPane);
      if (secondPaneIndex >= 0) createdPanes.splice(secondPaneIndex, 1);
      const firstPaneIndex = createdPanes.indexOf(firstPane);
      if (firstPaneIndex >= 0) createdPanes.splice(firstPaneIndex, 1);
    }
  }, 60_000);
});
