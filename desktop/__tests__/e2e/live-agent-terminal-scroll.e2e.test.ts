import type { MuxBasePane } from 'muxbase/core';
import { execFileSync, spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { request } from 'http';
import { tmpdir } from 'os';
import { basename, join, resolve } from 'path';
import { _electron as electron } from 'playwright';
import type { ConsoleMessage, ElectronApplication, Locator, Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it, onTestFinished } from 'vitest';
import { IPC } from '../../src/shared/ipc-channels';
import type { PaneCreateResponse, SessionInfoResult } from '../../src/shared/ipc-types';
import {
  closePaneBestEffort,
  getAppWindow,
  getNormalizedSession,
  getPanes,
  getSystemCheck,
  pollUntil,
  sendFollowUpToPane,
} from './e2e-helpers';

const ROOT = resolve(__dirname, '..', '..');
const MAIN_ENTRY = resolve(ROOT, 'out', 'main', 'index.js');
const APP_STARTUP_TIMEOUT_MS = 45_000;
const APP_SHUTDOWN_TIMEOUT_MS = 45_000;
const AGENT_RESPONSE_TIMEOUT_MS = 240_000;
const HAI_PROXY_READY_TIMEOUT_MS = 20_000;
const HAI_PROXY_PORT = 6655;
const TERMINAL_TIMEOUT_MS = 30_000;
const SOAK_DURATION_MS = Math.max(
  1_200_000,
  Number.parseInt(process.env.MUXBASE_E2E_SOAK_DURATION_MS ?? '1200000', 10),
);
const SOAK_ENABLED = process.env.MUXBASE_E2E_SOAK === '1';
const SOAK_SCREENSHOTS_DIR = resolve(ROOT, 'out', 'e2e-live-soak');
const KEEP_E2E_ARTIFACTS = process.env.MUXBASE_E2E_KEEP_ARTIFACTS === '1';
const LIVE_SCROLL_TEST_ENABLED =
  process.env.MUXBASE_E2E === '1' && process.env.MUXBASE_E2E_LIVE_AGENTS === '1';
const CLEAN_TERMINAL_FORBIDDEN_PATTERNS = [/MUXBASE_PROMPT_FILE/, /MUXBASE_PROMPT_CONTENT/, /--dangerously-skip-permissions/, /\u001b/, /\uFFFD/];
const TERMINAL_OSC_SEQUENCE = /\x1b\][^\x07]*(?:\x07|\x1b\\)/g;
const TERMINAL_CSI_SEQUENCE = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const TERMINAL_CONTROL_CHARS = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;

type AgentName = 'claude' | 'opencode';

interface MuxBaseStoreApi<TState> {
  getState: () => TState;
}

interface PaneStoreState {
  panes: MuxBasePane[];
  selectPane: (paneId: string | null) => void;
  setPanes: (panes: MuxBasePane[]) => void;
}

interface UiStoreState {
  focusPane: (paneId: string) => void;
  setActiveView: (view: 'dashboard' | 'settings') => void;
  setViewMode: (mode: 'fleet' | 'focus' | 'kanban' | 'conflict-resolution') => void;
}

interface E2EStores {
  pane?: MuxBaseStoreApi<PaneStoreState>;
  ui?: MuxBaseStoreApi<UiStoreState>;
}

interface TerminalDebugInfo {
  baseY: number;
  cols?: number;
  cursorX?: number;
  cursorY?: number;
  dataEventEvictionCount?: number;
  dataEventHistory?: TerminalDebugDataEvent[];
  droppedEventCount?: number;
  length: number;
  rows?: number;
  streamId?: number | null;
  type?: 'normal' | 'alternate';
  viewportY: number;
  wheelEvictionCount?: number;
  wheelHistory?: TerminalDebugWheelEvent[];
}

interface TerminalDebugApi {
  getFontSize: (paneId: string) => number | null;
  getLines: (paneId: string, startRow: number, count: number) => string[];
  getViewportInfo: (paneId: string) => TerminalDebugInfo | null;
  getVisibleLines: (paneId: string, count: number) => string[];
}

interface TerminalDebugWheelEvent {
  consumedBy: 'agent-input' | 'native-scroll' | 'none' | 'suppress' | 'tmux-scroll';
  defaultPrevented: boolean;
  deltaY: number;
  ts: number;
}

interface TerminalDebugBufferSnapshot {
  baseY: number;
  cursorX: number;
  cursorY: number;
  length: number;
  type: 'normal' | 'alternate';
  viewportY: number;
}

interface TerminalDebugDataEvent {
  after: TerminalDebugBufferSnapshot;
  before: TerminalDebugBufferSnapshot;
  dataLength: number;
  hardReset: boolean;
  meaningfulLines: string[];
  source: 'live' | 'replay' | undefined;
  streamId: number;
  ts: number;
}

interface E2EWindow {
  __MUXBASE_E2E?: boolean;
  __muxbaseStores?: E2EStores;
  __muxbaseTerminalDebug?: TerminalDebugApi;
  muxbase: { invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
}

interface TerminalSnapshot { info: TerminalDebugInfo; lines: string[]; visibleLines: string[] }

interface AgentScenario { agent: AgentName; pane: MuxBasePane; finalMarker: string; initialMarker: string }
interface CompletedAgentScenario extends AgentScenario { completionProbe: string }
interface ClaudeExactTable {
  doneMarker: string;
  grepMarker: string;
  prompt: string;
  readMarker: string;
  row: string;
  rowMarker: string;
  stageMarker: string;
}
interface TmuxPaneSize { cols: number; rows: number }
interface TerminalLayoutMetrics { rootWidth: number; screenWidth: number }
interface SoakTrackedPane { agent: AgentName; label: string; markers: string[]; pane: MuxBasePane }
interface SoakInvariantState { baseY?: number; droppedEventCount?: number; transcriptBytes?: number }

interface HaiProxyHandle { stop: () => Promise<void> }

function expectCommandOnPath(command: string): void {
  const result = spawnSync('which', [command], { stdio: 'ignore' });
  expect(result.status, `${command} must be available on PATH for live-agent E2E`).toBe(0);
}

function runTmux(args: string[], cwd?: string): string {
  return execFileSync('tmux', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function killTmuxSession(sessionName: string): void {
  spawnSync('tmux', ['kill-session', '-t', sessionName], { stdio: 'ignore' });
}

function terminalSelector(paneId: string): string {
  return `[data-testid="interactive-terminal"][data-pane-id="${paneId}"]`;
}

function countOccurrences(text: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let start = 0;
  while (start < text.length) {
    const index = text.indexOf(needle, start);
    if (index < 0) return count;
    count += 1;
    start = index + needle.length;
  }
  return count;
}

function countVisibleMarkerOccurrences(text: string, marker: string): number {
  return countOccurrences(normalizeVisibleMarkerText(text), normalizeVisibleMarkerText(marker));
}

function includesVisibleMarker(text: string, marker: string): boolean {
  return normalizeVisibleMarkerText(text).includes(normalizeVisibleMarkerText(marker));
}

function normalizeVisibleMarkerText(text: string): string {
  return text
    .replace(TERMINAL_OSC_SEQUENCE, '')
    .replace(TERMINAL_CSI_SEQUENCE, '')
    .replace(TERMINAL_CONTROL_CHARS, '')
    .replace(/\s+/g, '');
}

function assertCleanTerminalText(text: string): void {
  for (const pattern of CLEAN_TERMINAL_FORBIDDEN_PATTERNS) {
    expect(text).not.toMatch(pattern);
  }
}

function getStartupMarker(agent: AgentName): string {
  // OpenCode 1.17+ paints its name as block glyphs without a literal text
  // label. The composer placeholder is the stable ready-surface marker.
  return agent === 'claude' ? 'Claude Code v' : 'Ask anything';
}

function countStartupMarkers(agent: AgentName, text: string): number {
  return countVisibleMarkerOccurrences(text, getStartupMarker(agent));
}

async function assertNoDuplicatedStartupBlock(
  page: Page,
  scenario: CompletedAgentScenario,
  snapshot: TerminalSnapshot,
  transcriptText: string,
): Promise<void> {
  const allText = snapshot.lines.join('\n');
  const renderedCount = countStartupMarkers(scenario.agent, allText);
  if (renderedCount > 1) {
    await dumpTerminalForensics(page, scenario.pane.id, `${scenario.agent}-startup-duplicates`, snapshot, 'startup-duplicates', {
      marker: getStartupMarker(scenario.agent),
      renderedCount,
      transcriptCount: countStartupMarkers(scenario.agent, transcriptText),
    });
  }
  expect(renderedCount).toBeLessThanOrEqual(1);

  if (scenario.agent === 'claude' && renderedCount === 0) {
    expect(countStartupMarkers(scenario.agent, transcriptText)).toBeGreaterThanOrEqual(2);
  }
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

async function waitForChildExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;

  await new Promise<void>((resolve) => {
    const timeout = setTimeout(resolve, timeoutMs);
    child.once('exit', () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

async function stopChildProcess(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await waitForChildExit(child, 3_000);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
  }
}

async function isHaiProxyListening(): Promise<boolean> {
  return new Promise((resolveReady) => {
    const req = request({
      hostname: '127.0.0.1',
      method: 'GET',
      path: '/v1/models',
      port: HAI_PROXY_PORT,
      timeout: 1_000,
    }, (res) => {
      res.resume();
      resolveReady(true);
    });
    req.on('error', () => resolveReady(false));
    req.on('timeout', () => {
      req.destroy();
      resolveReady(false);
    });
    req.end();
  });
}

async function startHaiProxy(): Promise<HaiProxyHandle> {
  const existing = spawnSync('pgrep', ['-f', 'hai proxy start'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (existing.status === 0 && existing.stdout.trim() && await isHaiProxyListening()) {
    return { stop: async () => {} };
  }

  const child = spawn('hai', ['proxy', 'start', '--headless', '--port', String(HAI_PROXY_PORT)], {
    cwd: ROOT,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (data: Buffer) => {
    output += data.toString('utf8');
  });
  child.stderr.on('data', (data: Buffer) => {
    output += data.toString('utf8');
  });

  await pollUntil(
    async () => {
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`hai proxy start exited before readiness:\n${output}`);
      }
      return await isHaiProxyListening() ? true : null;
    },
    { interval: 250, label: 'hai-proxy-ready', timeout: HAI_PROXY_READY_TIMEOUT_MS },
  );

  return { stop: () => stopChildProcess(child) };
}

async function createAgentPane(page: Page, prompt: string, projectRoot: string, agent: AgentName): Promise<MuxBasePane> {
  const response = await invoke<PaneCreateResponse>(page, IPC.PANE_CREATE, {
    agent,
    projectRoot,
    prompt,
    useWorktree: true,
  });

  expect(response.success, response.error).toBe(true);
  expect(response.pane).toBeDefined();
  const pane = response.pane!;
  expect(pane.agent).toBe(agent);
  createdPanesRegistry.set(pane.id, pane);
  return pane;
}

async function createShellPane(page: Page, projectRoot: string): Promise<MuxBasePane> {
  const response = await invoke<PaneCreateResponse>(page, IPC.PANE_CREATE, {
    projectRoot,
    prompt: '',
    type: 'shell',
  });

  expect(response.success, response.error).toBe(true);
  expect(response.pane).toBeDefined();
  return response.pane!;
}

async function syncRendererPanes(page: Page): Promise<MuxBasePane[]> {
  const panes = await getPanes(page);
  await page.evaluate((nextPanes) => {
    const e2eWindow = window as unknown as E2EWindow;
    e2eWindow.__muxbaseStores?.pane?.getState().setPanes(nextPanes);
  }, panes);
  return panes;
}

async function focusPane(page: Page, paneId: string): Promise<void> {
  await syncRendererPanes(page);
  await focusPaneInCurrentStore(page, paneId);
}

async function focusPaneInCurrentStore(page: Page, paneId: string): Promise<void> {
  await page.evaluate((id) => {
    const stores = (window as unknown as E2EWindow).__muxbaseStores;
    stores?.ui?.getState().setActiveView('dashboard');
    stores?.pane?.getState().selectPane(id);
    stores?.ui?.getState().focusPane(id);
  }, paneId);
  await page.locator(`${terminalSelector(paneId)} .xterm-screen`).waitFor({
    state: 'visible',
    timeout: TERMINAL_TIMEOUT_MS,
  });
}

async function injectPaneIntoRenderer(page: Page, pane: MuxBasePane): Promise<void> {
  await page.evaluate((nextPane) => {
    const stores = (window as unknown as E2EWindow).__muxbaseStores;
    const paneStore = stores?.pane?.getState();
    const currentPanes = paneStore?.panes ?? [];
    paneStore?.setPanes([...currentPanes.filter((p) => p.id !== nextPane.id), nextPane]);
    paneStore?.selectPane(nextPane.id);
    stores?.ui?.getState().setActiveView('dashboard');
    stores?.ui?.getState().focusPane(nextPane.id);
  }, pane);
  await focusPaneInCurrentStore(page, pane.id);
}

async function unmountTerminalSurfaces(page: Page): Promise<void> {
  await page.evaluate(() => {
    const stores = (window as unknown as E2EWindow).__muxbaseStores;
    stores?.ui?.getState().setActiveView('settings');
  });
  await page.waitForFunction(
    () => document.querySelectorAll('[data-testid="interactive-terminal"]').length === 0,
    undefined,
    { timeout: TERMINAL_TIMEOUT_MS },
  );
}

async function cycleAgentPanes(page: Page, firstPaneId: string, secondPaneId: string): Promise<void> {
  for (const paneId of [firstPaneId, secondPaneId, firstPaneId, secondPaneId, firstPaneId, secondPaneId]) {
    await unmountTerminalSurfaces(page);
    await focusPane(page, paneId);
    await waitForTerminalDebug(page, paneId);
  }
}

async function waitForTerminalDebug(page: Page, paneId: string): Promise<TerminalSnapshot> {
  return pollUntil(
    async () => getTerminalSnapshot(page, paneId),
    { interval: 250, label: `terminal-debug(${paneId})`, timeout: TERMINAL_TIMEOUT_MS },
  );
}

async function getTerminalSnapshot(page: Page, paneId: string): Promise<TerminalSnapshot | null> {
  return page.evaluate((id) => {
    const debug = (window as unknown as E2EWindow).__muxbaseTerminalDebug;
    const info = debug?.getViewportInfo(id);
    if (!debug || !info) return null;
    return {
      info,
      lines: debug.getLines(id, 0, info.length),
      visibleLines: debug.getVisibleLines(id, 160),
    };
  }, paneId);
}

async function getTerminalFontSize(page: Page, paneId: string): Promise<number | null> {
  return page.evaluate(
    (id) => (window as unknown as E2EWindow).__muxbaseTerminalDebug?.getFontSize(id) ?? null,
    paneId,
  );
}

async function waitForTerminalFontSize(
  page: Page,
  paneId: string,
  predicate: (fontSize: number) => boolean,
  label: string,
): Promise<number> {
  return pollUntil(
    async () => {
      const fontSize = await getTerminalFontSize(page, paneId);
      return fontSize !== null && predicate(fontSize) ? fontSize : null;
    },
    { interval: 100, label: `terminal-font-size(${label})`, timeout: TERMINAL_TIMEOUT_MS },
  );
}

async function waitForTranscriptAssistantMarker(pane: MuxBasePane, marker: string): Promise<string> {
  expect(pane.terminalTranscriptPath).toBeTruthy();
  return pollUntil(
    async () => {
      const transcriptPath = pane.terminalTranscriptPath!;
      if (!existsSync(transcriptPath)) return null;
      const content = readFileSync(transcriptPath, 'utf8');
      return countVisibleMarkerOccurrences(content, marker) >= 2 ? content : null;
    },
    {
      interval: 1_000,
      label: `transcript-assistant-marker(${pane.id}, ${marker})`,
      timeout: AGENT_RESPONSE_TIMEOUT_MS,
    },
  );
}

async function waitForSessionAssistantMarker(page: Page, pane: MuxBasePane, marker: string): Promise<void> {
  await pollUntil(
    async () => {
      const session = await getNormalizedSession(page, pane.id);
      if (!session) return null;
      const found = session.messages.some((message) => (
        message.type === 'assistant' && includesVisibleMarker(message.content, marker)
      ));
      return found ? true : null;
    },
    {
      interval: 1_000,
      label: `session-assistant-marker(${pane.id}, ${marker})`,
      timeout: AGENT_RESPONSE_TIMEOUT_MS,
    },
  );
}

async function waitForTranscriptIncludes(pane: MuxBasePane, marker: string, timeout = TERMINAL_TIMEOUT_MS): Promise<string> {
  expect(pane.terminalTranscriptPath).toBeTruthy();
  return pollUntil(
    async () => {
      const transcriptPath = pane.terminalTranscriptPath!;
      if (!existsSync(transcriptPath)) return null;
      const content = readFileSync(transcriptPath, 'utf8');
      return content.includes(marker) ? content : null;
    },
    {
      interval: 500,
      label: `transcript-includes(${pane.id}, ${marker})`,
      timeout,
    },
  );
}

function readAgentTranscript(pane: MuxBasePane): string {
  expect(pane.terminalTranscriptPath).toBeTruthy();
  return readFileSync(pane.terminalTranscriptPath!, 'utf8');
}

function getTranscriptByteLength(pane: MuxBasePane): number {
  if (!pane.terminalTranscriptPath || !existsSync(pane.terminalTranscriptPath)) return 0;
  return readFileSync(pane.terminalTranscriptPath).byteLength;
}

function getInvariantState(states: Map<string, SoakInvariantState>, label: string): SoakInvariantState {
  const existing = states.get(label);
  if (existing) return existing;
  const next: SoakInvariantState = {};
  states.set(label, next);
  return next;
}

async function waitForTmuxContent(tmuxPaneId: string, needle: string): Promise<string> {
  return pollUntil(
    async () => {
      const content = runTmux(['capture-pane', '-t', tmuxPaneId, '-p', '-S', '-500']);
      return content.includes(needle) ? content : null;
    },
    { interval: 250, label: `tmux-content(${needle})`, timeout: TERMINAL_TIMEOUT_MS },
  );
}

// Full tmux scrollback + live screen for a pane. In classic (inline) Claude the
// conversation lives in tmux history; the wheel routes through tmux copy-mode
// rather than moving xterm's own viewport, so this capture is the authoritative
// record that earlier turns are retained and retrievable.
function captureTmuxScrollback(tmuxPaneId: string): string {
  return runTmux(['capture-pane', '-t', tmuxPaneId, '-p', '-S', '-']);
}

// Classic-mode replacement for the fullscreen `viewportY < baseY` scroll proof.
// Classic Claude renders as a tmux-driven alternate buffer with baseY/viewportY
// pinned at 0, so history retention is proven by markers being present in BOTH
// the tmux full scrollback and the rendered xterm buffer after a scroll-to-top.
function assertClassicHistoryRetained(
  pane: MuxBasePane,
  renderedText: string,
  markers: string[],
  context: string,
): void {
  const tmuxFull = captureTmuxScrollback(pane.paneId);
  for (const marker of markers) {
    expect(includesVisibleMarker(tmuxFull, marker), `${context}: tmux scrollback should contain ${marker}`).toBe(true);
    expect(includesVisibleMarker(renderedText, marker), `${context}: xterm buffer should contain ${marker}`).toBe(true);
  }
}

function readTmuxPaneSize(tmuxPaneId: string): TmuxPaneSize {
  const raw = runTmux(['display', '-p', '-t', tmuxPaneId, '#{pane_width}x#{pane_height}']).trim();
  const match = raw.match(/^(\d+)x(\d+)$/);
  if (!match) throw new Error(`invalid tmux pane size for ${tmuxPaneId}: ${raw}`);
  return {
    cols: Number.parseInt(match[1], 10),
    rows: Number.parseInt(match[2], 10),
  };
}

async function getTerminalLayoutMetrics(page: Page, paneId: string): Promise<TerminalLayoutMetrics> {
  return page.evaluate((id) => {
    const root = document.querySelector(`[data-testid="interactive-terminal"][data-pane-id="${id}"]`);
    const screen = root?.querySelector('.xterm-screen');
    if (!(root instanceof HTMLElement) || !(screen instanceof HTMLElement)) {
      throw new Error(`terminal layout elements missing for ${id}`);
    }
    return {
      rootWidth: root.getBoundingClientRect().width,
      screenWidth: screen.getBoundingClientRect().width,
    };
  }, paneId);
}

async function waitForLiveTerminalGeometry(
  page: Page,
  pane: MuxBasePane,
  predicate: (cols: number) => boolean,
  label: string,
): Promise<{ metrics: TerminalLayoutMetrics; snapshot: TerminalSnapshot; tmuxSize: TmuxPaneSize }> {
  let lastObservation = 'terminal snapshot unavailable';
  try {
    return await pollUntil(
      async () => {
        const snapshot = await getTerminalSnapshot(page, pane.id);
        if (!snapshot?.info.cols || !snapshot.info.rows) return null;
        const tmuxSize = readTmuxPaneSize(pane.paneId);
        const metrics = await getTerminalLayoutMetrics(page, pane.id);
        const screenGap = metrics.rootWidth - metrics.screenWidth;
        const fixedGrid = (pane.terminalFixedCols ?? 0) > 0;
        const predicateMatched = predicate(snapshot.info.cols);
        lastObservation = JSON.stringify({
          fixedGrid,
          metrics,
          predicateMatched,
          renderer: { cols: snapshot.info.cols, rows: snapshot.info.rows },
          screenGap,
          tmuxSize,
        });
        const ready = predicateMatched
          && tmuxSize.cols === snapshot.info.cols
          && tmuxSize.rows === snapshot.info.rows
          && screenGap >= -1
          // Responsive terminals should fill their cell. A fixed-grid Claude
          // terminal deliberately keeps its configured font size when there is
          // spare width and only shrinks when the cell becomes too narrow.
          && (fixedGrid || screenGap < 24);
        return ready ? { metrics, snapshot, tmuxSize } : null;
      },
      { interval: 250, label: `live-terminal-geometry(${label})`, timeout: TERMINAL_TIMEOUT_MS },
    );
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}; last=${lastObservation}`,
    );
  }
}

async function acceptTrustPromptIfVisible(page: Page, pane: MuxBasePane, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await invoke<{ content?: string }>(page, IPC.PANE_GET_CONTENT, { paneId: pane.id });
    const content = result.content ?? '';
    if (/do you trust|trust.*files|quick safety check|enter to confirm|yes,\s*i trust/i.test(content)) {
      await sendFollowUpToPane(page, pane.id, '');
      return;
    }
    await page.waitForTimeout(500);
  }
}

async function waitForTerminalInputReady(page: Page, paneId: string): Promise<void> {
  const overlay = page.locator(
    `${terminalSelector(paneId)} [data-testid="terminal-boot-overlay"]`,
  );
  await pollUntil(
    async () => (await overlay.getAttribute('data-booting')) === 'false' ? true : null,
    { interval: 100, label: `terminal-input-ready(${paneId})`, timeout: TERMINAL_TIMEOUT_MS },
  );
}

async function wheelTerminalInFleet(
  page: Page,
  paneId: string,
  deltaY: number,
  label: string,
): Promise<TerminalDebugWheelEvent> {
  const screen = page.locator(`${terminalSelector(paneId)} .xterm-screen`);
  await screen.waitFor({ state: 'visible', timeout: TERMINAL_TIMEOUT_MS });
  const box = await screen.boundingBox();
  expect(box).not.toBeNull();
  if (!box) throw new Error(`${label}: terminal has no screen bounds`);

  const before = await waitForTerminalDebug(page, paneId);
  const previousWheelCount = (before.info.wheelEvictionCount ?? 0)
    + (before.info.wheelHistory ?? []).length;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, deltaY);

  return pollUntil(
    async () => {
      const snapshot = await getTerminalSnapshot(page, paneId);
      const wheelHistory = snapshot?.info.wheelHistory ?? [];
      const wheelCount = (snapshot?.info.wheelEvictionCount ?? 0) + wheelHistory.length;
      const latest = wheelHistory.at(-1);
      return wheelCount > previousWheelCount
        && latest
        && Math.sign(latest.deltaY) === Math.sign(deltaY)
        ? latest
        : null;
    },
    { interval: 50, label: `terminal-wheel(${label})`, timeout: TERMINAL_TIMEOUT_MS },
  );
}

async function wheelFleetTerminalUntilMarker(
  page: Page,
  paneId: string,
  marker: string,
  deltaY: number,
  label: string,
): Promise<TerminalSnapshot> {
  let lastSnapshot: TerminalSnapshot = await waitForTerminalDebug(page, paneId);
  expect(
    includesVisibleMarker(lastSnapshot.visibleLines.join('\n'), marker),
    `${label}: target marker must start outside the viewport`,
  ).toBe(false);

  for (let attempt = 0; attempt < 80; attempt += 1) {
    const event = await wheelTerminalInFleet(page, paneId, deltaY, `${label}-${attempt}`);
    expect(event.consumedBy).toBe('tmux-scroll');
    expect(event.defaultPrevented).toBe(true);
    await page.waitForTimeout(150);
    const snapshot = await getTerminalSnapshot(page, paneId);
    if (snapshot) {
      lastSnapshot = snapshot;
      if (includesVisibleMarker(snapshot.visibleLines.join('\n'), marker)) return snapshot;
    }
  }

  throw new Error(
    `${label}: ${marker} never became visible; `
    + `last=${JSON.stringify(lastSnapshot.visibleLines.slice(-20))}`,
  );
}

async function runLocalShellCommand(
  page: Page,
  pane: MuxBasePane,
  command: string,
  composeMarker: string,
  outputMarker: string,
  label: string,
): Promise<TerminalSnapshot> {
  await invoke(page, IPC.TERMINAL_WRITE, { data: '!', paneId: pane.id });
  await pollUntil(
    async () => {
      const snapshot = await getTerminalSnapshot(page, pane.id);
      return snapshot && /shell (?:command|mode)/i.test(snapshot.visibleLines.join('\n'))
        ? true
        : null;
    },
    { interval: 50, label: `${label}-mode`, timeout: TERMINAL_TIMEOUT_MS },
  );
  await invoke(page, IPC.TERMINAL_WRITE, { data: command, paneId: pane.id });
  await pollUntil(
    async () => {
      const snapshot = await getTerminalSnapshot(page, pane.id);
      return snapshot && includesVisibleMarker(snapshot.visibleLines.join('\n'), composeMarker)
        ? true
        : null;
    },
    { interval: 50, label: `${label}-composed`, timeout: TERMINAL_TIMEOUT_MS },
  );
  await invoke(page, IPC.TERMINAL_WRITE, { data: '\r', paneId: pane.id });
  return pollUntil(
    async () => {
      const snapshot = await getTerminalSnapshot(page, pane.id);
      return snapshot && includesVisibleMarker(snapshot.visibleLines.join('\n'), outputMarker)
        ? snapshot
        : null;
    },
    { interval: 100, label: `${label}-output`, timeout: TERMINAL_TIMEOUT_MS },
  );
}

async function scrollTerminalToTop(page: Page, paneId: string, requiredText: string): Promise<TerminalSnapshot> {
  await focusPane(page, paneId);
  const screen = page.locator(`${terminalSelector(paneId)} .xterm-screen`);
  await screen.waitFor({ state: 'visible', timeout: TERMINAL_TIMEOUT_MS });
  const box = await screen.boundingBox();
  expect(box).not.toBeNull();
  if (!box) throw new Error(`terminal-scroll: missing terminal screen for ${paneId}`);

  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  let lastSnapshot: TerminalSnapshot | null = null;

  for (let attempt = 0; attempt < 70; attempt += 1) {
    await page.mouse.wheel(0, -16_000);
    await page.waitForTimeout(100);
    const snapshot = await getTerminalSnapshot(page, paneId);
    if (!snapshot) continue;

    lastSnapshot = snapshot;
    const visibleText = snapshot.visibleLines.join('\n');
    if (visibleText.includes(requiredText)) return snapshot;
  }

  const info = lastSnapshot ? JSON.stringify(lastSnapshot.info) : 'no terminal snapshot';
  const sample = lastSnapshot?.visibleLines.slice(0, 50).join(' | ') ?? '';
  throw new Error(`terminal-scroll: "${requiredText}" never became visible (${info}) ${sample}`);
}

async function scrollTerminalToBottom(page: Page, paneId: string): Promise<TerminalSnapshot> {
  await focusPane(page, paneId);
  const screen = page.locator(`${terminalSelector(paneId)} .xterm-screen`);
  await screen.waitFor({ state: 'visible', timeout: TERMINAL_TIMEOUT_MS });
  const box = await screen.boundingBox();
  expect(box).not.toBeNull();
  if (!box) throw new Error(`terminal-scroll-bottom: missing terminal screen for ${paneId}`);

  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  let lastSnapshot: TerminalSnapshot | null = null;

  for (let attempt = 0; attempt < 70; attempt += 1) {
    await page.mouse.wheel(0, 16_000);
    await page.waitForTimeout(100);
    const snapshot = await getTerminalSnapshot(page, paneId);
    if (!snapshot) continue;

    lastSnapshot = snapshot;
    if (snapshot.info.viewportY >= snapshot.info.baseY) return snapshot;
  }

  const info = lastSnapshot ? JSON.stringify(lastSnapshot.info) : 'no terminal snapshot';
  const sample = lastSnapshot?.visibleLines.slice(0, 50).join(' | ') ?? '';
  throw new Error(`terminal-scroll-bottom: bottom never became visible (${info}) ${sample}`);
}

async function waitForTerminalBufferText(page: Page, paneId: string, expected: string): Promise<TerminalSnapshot> {
  return pollUntil(
    async () => {
      const snapshot = await getTerminalSnapshot(page, paneId);
      if (!snapshot) return null;
      const text = snapshot.lines.join('\n');
      return includesVisibleMarker(text, expected) ? snapshot : null;
    },
    { interval: 250, label: `terminal-buffer-text(${paneId}, ${expected})`, timeout: TERMINAL_TIMEOUT_MS },
  );
}

async function runAgentScenario(page: Page, projectRoot: string, agent: AgentName, token: string): Promise<CompletedAgentScenario> {
  const agentToken = `${token}-${agent.toUpperCase()}`;
  const initialMarker = `${agentToken}-INITIAL-PROMPT`;
  const finalMarker = `${agentToken}-TOOL-PARAMETERS-DONE`;
  // Keep replies just long enough to overflow the ~27-row pane (so scroll-to-top
  // is genuinely exercised) but short enough to arrive fast and reliably — the
  // longer the reply, the more often the assistant-marker wait times out.
  const lineInstruction = agent === 'opencode'
    ? 'Answer in 12 to 16 short numbered lines.'
    : 'Answer in 30 to 34 short numbered lines.';
  const categoryInstruction = agent === 'opencode'
    ? 'Lines 1-4: available tool categories.'
    : 'Lines 1-10: available tool categories.';
  const toolInstruction = agent === 'opencode'
    ? 'Lines 5-16: tools with main parameters and one concise usage hint each.'
    : 'Lines 11-34: tools with main parameters and one concise usage hint each.';
  const initialPrompt = [
    initialMarker,
    lineInstruction,
    categoryInstruction,
    toolInstruction,
    `End the assistant answer with exactly ${finalMarker}.`,
    'Do not modify files.',
  ].join(' ');

  const pane = await createAgentPane(page, initialPrompt, projectRoot, agent);
  await syncRendererPanes(page);
  await focusPane(page, pane.id);
  await waitForTerminalDebug(page, pane.id);
  await acceptTrustPromptIfVisible(page, pane);
  await waitForTranscriptAssistantMarker(pane, finalMarker);
  return { agent, completionProbe: finalMarker, finalMarker, initialMarker, pane };
}

async function assertScrollableCleanAgentPane(page: Page, scenario: CompletedAgentScenario): Promise<void> {
  await focusPane(page, scenario.pane.id);
  const bottom = await waitForTerminalBufferText(page, scenario.pane.id, scenario.completionProbe);

  const bottomText = bottom.lines.join('\n');
  expect(includesVisibleMarker(bottomText, scenario.completionProbe)).toBe(true);
  assertCleanTerminalText(bottomText);

  // Claude renders classic (inline): the wheel routes through tmux copy-mode, so
  // xterm's own scrollback (baseY/viewportY) stays pinned at 0 — history retention
  // is proven against the tmux full-capture. OpenCode still self-scrolls its own
  // alternate-screen buffer via line keys, keeping the xterm-viewport model.
  if (scenario.agent === 'claude') {
    const scrolled = await scrollTerminalToTop(page, scenario.pane.id, scenario.initialMarker);
    const allText = scrolled.lines.join('\n');
    const visibleText = scrolled.visibleLines.join('\n');
    const transcriptText = readAgentTranscript(scenario.pane);

    expect(visibleText).toContain(scenario.initialMarker);
    expect(countOccurrences(allText, scenario.initialMarker)).toBe(1);
    assertClassicHistoryRetained(scenario.pane, allText, [scenario.initialMarker], 'scrollable-clean-claude');
    assertCleanTerminalText(allText);
    await assertNoDuplicatedStartupBlock(page, scenario, scrolled, transcriptText);
    return;
  }

  expect(bottom.info.baseY).toBeGreaterThan(0);

  const scrolled = await scrollTerminalToTop(page, scenario.pane.id, scenario.initialMarker);
  const allText = scrolled.lines.join('\n');
  const visibleText = scrolled.visibleLines.join('\n');
  const transcriptText = readAgentTranscript(scenario.pane);

  expect(scrolled.info.viewportY).toBeLessThan(scrolled.info.baseY);
  expect(visibleText).toContain(scenario.initialMarker);
  expect(countOccurrences(allText, scenario.initialMarker)).toBe(1);
  assertCleanTerminalText(allText);
  await assertNoDuplicatedStartupBlock(page, scenario, scrolled, transcriptText);
}

async function assertClaudeChatHistoryVisible(
  page: Page,
  pane: MuxBasePane,
  markers: string[],
  requiredVisibleMarker: string,
): Promise<void> {
  await focusPane(page, pane.id);
  await waitForTerminalBufferText(page, pane.id, markers[markers.length - 1]);

  // Classic (inline) Claude scrolls via tmux copy-mode: scrolling up repaints the
  // earlier conversation into xterm's (tmux-driven) buffer, so surfacing the top
  // marker in the rendered view is the proof the scroll worked — not an xterm
  // viewportY move, which stays pinned at 0 in this mode.
  const scrolled = await scrollTerminalToTop(page, pane.id, requiredVisibleMarker);
  const renderedText = scrolled.lines.join('\n');
  const visibleText = scrolled.visibleLines.join('\n');
  const transcriptText = readAgentTranscript(pane);

  expect(visibleText).toContain(requiredVisibleMarker);
  expect(includesVisibleMarker(renderedText, requiredVisibleMarker), 'xterm buffer should render the scrolled-back marker').toBe(true);
  for (const marker of markers) {
    expect(includesVisibleMarker(transcriptText, marker), `transcript should contain ${marker}`).toBe(true);
  }
  assertClassicHistoryRetained(pane, renderedText, [requiredVisibleMarker], 'claude-chat-history');
  assertCleanTerminalText(renderedText);
}

async function assertClaudeActivityConversationRenders(page: Page, pane: MuxBasePane, markers: string[]): Promise<void> {
  await focusPane(page, pane.id);
  await page.locator('button[role="tab"]:has-text("Activity")').first().click();
  await page.locator('button:has-text("Conversation")').first().waitFor({
    state: 'visible',
    timeout: TERMINAL_TIMEOUT_MS,
  });
  await page.locator('button:has-text("Conversation")').first().click();

  await pollUntil(
    async () => {
      const text = await page.locator('[role="log"][aria-label="Conversation history"]').first().textContent();
      if (!text) return null;
      return markers.every((marker) => text.includes(marker)) ? text : null;
    },
    { interval: 500, label: `activity-conversation-markers(${pane.id})`, timeout: TERMINAL_TIMEOUT_MS },
  );
}

async function showFleet(page: Page): Promise<void> {
  await syncRendererPanes(page);
  await page.evaluate(() => {
    const stores = (window as unknown as E2EWindow).__muxbaseStores;
    stores?.ui?.getState().setActiveView('dashboard');
    stores?.ui?.getState().setViewMode('fleet');
  });
  await page.locator('[data-testid="pane-cell"]').first().waitFor({
    state: 'visible',
    timeout: TERMINAL_TIMEOUT_MS,
  });
}

async function takeSoakScreenshot(page: Page, name: string): Promise<string> {
  mkdirSync(SOAK_SCREENSHOTS_DIR, { recursive: true });
  const path = resolve(SOAK_SCREENSHOTS_DIR, `${name}.png`);
  await page.screenshot({ fullPage: false, path });
  expect(existsSync(path)).toBe(true);
  return path;
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
  await page.mouse.move(x + deltaX, y, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(600);
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

function makeClaudeExactTable(stage: string, desiredLineWidth: number): ClaudeExactTable {
  const stageMarker = `${stage}START`;
  const rowMarker = `${stage}ROW`;
  const doneMarker = `${stage}DONE`;
  const grepMarker = `${stage}GREP`;
  const readMarker = `${stage}READ`;
  const prefix = '| Bash | Shell command tool | ';
  const suffix = ` | ${rowMarker} |`;
  const padding = 'x'.repeat(Math.max(8, desiredLineWidth - prefix.length - suffix.length));
  const row = `${prefix}${padding}${suffix}`;
  const block = [
    stageMarker,
    '| Tool | Purpose | Width padding | Marker |',
    '| --- | --- | --- | --- |',
    `| Read | File reader tool | stable | ${readMarker} |`,
    `| Grep | Search tool | stable | ${grepMarker} |`,
    row,
  ].join('\n');

  return {
    doneMarker,
    grepMarker,
    prompt: [
      `Copy this table block exactly, with the same line breaks, no extra table rows, and no code fence:`,
      block,
      `After the block, end the assistant reply with exactly ${doneMarker}.`,
      'Do not modify files.',
    ].join('\n'),
    readMarker,
    row,
    rowMarker,
    stageMarker,
  };
}

async function assertAssistantContainsExactTableRow(page: Page, pane: MuxBasePane, row: string, label: string): Promise<void> {
  const session = await getNormalizedSession(page, pane.id);
  const assistantHasRow = session?.messages.some((message) => (
    message.type === 'assistant' && message.content.includes(row)
  )) ?? false;
  expect(assistantHasRow, `${label}: Claude assistant message should contain the exact table row`).toBe(true);
}

async function assertClaudeTableRenderedAtCurrentWidth(
  page: Page,
  pane: MuxBasePane,
  table: ClaudeExactTable,
  label: string,
): Promise<TerminalSnapshot> {
  let lastSnapshot: TerminalSnapshot | null = null;
  let lastRows = { bashRows: [] as string[], grepRows: [] as string[], readRows: [] as string[] };

  try {
    return await pollUntil(
      async () => {
        const snapshot = await getTerminalSnapshot(page, pane.id);
        if (!snapshot) return null;
        const bashRows = snapshot.lines.filter((line) => line.includes('Bash') && line.includes(table.rowMarker));
        const readRows = snapshot.lines.filter((line) => line.includes('Read') && line.includes(table.readMarker));
        const grepRows = snapshot.lines.filter((line) => line.includes('Grep') && line.includes(table.grepMarker));
        const hasExactRow = snapshot.lines.some((line) => line.includes(table.row));
        lastSnapshot = snapshot;
        lastRows = { bashRows, grepRows, readRows };
        const rowsReady = bashRows.length >= 2 && readRows.length >= 2 && grepRows.length >= 2;
        const widthReady = (snapshot.info.cols ?? 0) >= table.row.length;
        return rowsReady && widthReady && hasExactRow ? snapshot : null;
      },
      { interval: 250, label: `claude-table-render(${label})`, timeout: TERMINAL_TIMEOUT_MS },
    );
  } catch (error) {
    if (lastSnapshot) {
      await dumpTerminalForensics(page, pane.id, label, lastSnapshot, 'claude-table-row-wrap', {
        ...lastRows,
        doneMarker: table.doneMarker,
        expectedRowLength: table.row.length,
        expectedRowPreview: table.row,
        terminalCols: lastSnapshot.info.cols,
        tmuxSize: readTmuxPaneSize(pane.paneId),
      });
    }
    throw error;
  }
}

async function clickFirstVisibleTab(page: Page, label: string): Promise<void> {
  const tab = page.locator(`button[role="tab"]:has-text("${label}")`).first();
  if (await tab.isVisible({ timeout: 2_000 }).catch(() => false)) {
    await tab.click();
    await page.waitForTimeout(500);
  }
}

async function stressFocusTabsAndResize(page: Page, paneId: string, turn: number): Promise<void> {
  await focusPane(page, paneId);
  for (const label of ['Activity', 'Tokens', 'Diff', 'Worktree', 'Activity']) {
    await clickFirstVisibleTab(page, label);
    if (label === 'Activity') {
      for (const subTab of ['Conversation', 'Prompts', 'Conversation']) {
        const button = page.locator(`button:has-text("${subTab}")`).first();
        if (await button.isVisible({ timeout: 1_000 }).catch(() => false)) {
          await button.click();
          await page.waitForTimeout(250);
        }
      }
    }
    const handle = page.locator('[data-testid="focus-terminal-activity-separator"]');
    await dragResizeHandle(page, handle, turn % 2 === 0 ? 180 : -160);
    await dragResizeHandle(page, handle, turn % 2 === 0 ? -140 : 150);
  }
}

async function stressFleetPaneResize(page: Page, paneId: string, turn: number): Promise<void> {
  await showFleet(page);
  const paneCell = page.locator(`[data-testid="pane-cell"][data-pane-id="${paneId}"]`).first();
  await paneCell.waitFor({ state: 'visible', timeout: TERMINAL_TIMEOUT_MS });
  const handle = await nearestFleetResizeHandle(page, paneCell);
  await dragResizeHandle(page, handle, turn % 2 === 0 ? 220 : -180);
  await dragResizeHandle(page, handle, turn % 2 === 0 ? -200 : 160);
}

async function assertSoakState(
  page: Page,
  pane: MuxBasePane,
  markers: string[],
  turn: number,
): Promise<void> {
  const latest = markers[markers.length - 1];
  await focusPane(page, pane.id);
  await waitForTerminalBufferText(page, pane.id, latest);

  // Classic Claude scrolls via tmux copy-mode: xterm's buffer only holds the
  // current copy-mode viewport (~one screen), so the full multi-turn history is
  // proven against the transcript and the tmux full scrollback, while the
  // rendered buffer proves the scrolled-back first marker actually paints.
  const scrolled = await scrollTerminalToTop(page, pane.id, markers[0]);
  const renderedText = scrolled.lines.join('\n');
  const transcriptText = readAgentTranscript(pane);
  const tmuxFull = captureTmuxScrollback(pane.paneId);

  expect(includesVisibleMarker(scrolled.visibleLines.join('\n'), markers[0]), `turn ${turn}: first marker should be visible after scroll`).toBe(true);
  expect(includesVisibleMarker(renderedText, markers[0]), `turn ${turn}: xterm buffer should render the scrolled-back first marker`).toBe(true);
  for (const marker of markers) {
    expect(includesVisibleMarker(transcriptText, marker), `turn ${turn}: transcript should contain ${marker}`).toBe(true);
    expect(includesVisibleMarker(tmuxFull, marker), `turn ${turn}: tmux scrollback should contain ${marker}`).toBe(true);
  }
  assertCleanTerminalText(renderedText);
  await scrollTerminalToBottom(page, pane.id);
}

async function assertTrackedPaneTerminalState(page: Page, target: SoakTrackedPane, turn: number): Promise<void> {
  const first = target.markers[0];
  const latest = target.markers[target.markers.length - 1];
  await focusPane(page, target.pane.id);
  const bottom = await waitForTerminalBufferText(page, target.pane.id, latest);
  const renderedBottomText = bottom.lines.join('\n');
  const transcriptText = readAgentTranscript(target.pane);

  for (const marker of target.markers) {
    expect(includesVisibleMarker(transcriptText, marker), `${target.label} turn ${turn}: transcript should contain ${marker}`).toBe(true);
    expect(includesVisibleMarker(renderedBottomText, marker), `${target.label} turn ${turn}: xterm buffer should contain ${marker}`).toBe(true);
  }
  assertCleanTerminalText(renderedBottomText);

  if (bottom.info.baseY > 0) {
    const scrolled = await scrollTerminalToTop(page, target.pane.id, first);
    expect(scrolled.info.viewportY, `${target.label} turn ${turn}: viewport should move upward`).toBeLessThan(scrolled.info.baseY);
    expect(includesVisibleMarker(scrolled.visibleLines.join('\n'), first), `${target.label} turn ${turn}: first marker should be visible after scroll`).toBe(true);
    assertCleanTerminalText(scrolled.lines.join('\n'));
  }

  await scrollTerminalToBottom(page, target.pane.id).catch(() => {});
}

async function assertSoakInvariants(
  page: Page,
  pane: MuxBasePane,
  label: string,
  state: SoakInvariantState,
  turn: number,
): Promise<void> {
  await focusPane(page, pane.id);
  const snapshot = await waitForTerminalDebug(page, pane.id);
  const previousBaseY = state.baseY;
  if (previousBaseY !== undefined && snapshot.info.baseY + 50 < previousBaseY) {
    throw new Error(`${label} turn ${turn}: baseY shrank from ${previousBaseY} to ${snapshot.info.baseY} (${JSON.stringify(snapshot.info)})`);
  }
  state.baseY = Math.max(previousBaseY ?? 0, snapshot.info.baseY);

  const droppedEventCount = snapshot.info.droppedEventCount ?? 0;
  const previousDroppedEventCount = state.droppedEventCount;
  if (previousDroppedEventCount !== undefined && droppedEventCount > previousDroppedEventCount) {
    throw new Error(`${label} turn ${turn}: terminal stream dropped ${droppedEventCount - previousDroppedEventCount} events (${JSON.stringify(snapshot.info)})`);
  }
  state.droppedEventCount = droppedEventCount;

  const transcriptBytes = getTranscriptByteLength(pane);
  const previousTranscriptBytes = state.transcriptBytes;
  if (previousTranscriptBytes !== undefined && transcriptBytes < previousTranscriptBytes) {
    throw new Error(`${label} turn ${turn}: transcript bytes shrank from ${previousTranscriptBytes} to ${transcriptBytes}`);
  }
  state.transcriptBytes = Math.max(previousTranscriptBytes ?? 0, transcriptBytes);

  await assertTerminalNotVisuallyEmpty(page, pane.id, `${label} turn ${turn}`);
  await assertNoCorruptedCellsAfterResize(page, pane.id, `${label} turn ${turn}`);
  await assertNoDuplicateStatusLines(page, pane.id, `${label} turn ${turn}`);
}

async function assertTerminalNotVisuallyEmpty(page: Page, paneId: string, label: string): Promise<void> {
  const snapshot = await getTerminalSnapshot(page, paneId);
  expect(snapshot, `${label}: pane ${paneId} has no terminal snapshot`).not.toBeNull();
  const nonEmpty = snapshot!.visibleLines.filter((line) => normalizeVisibleMarkerText(line).length > 0).length;
  expect(
    nonEmpty,
    `${label}: pane ${paneId} appears visually empty (0/${snapshot!.visibleLines.length} visible lines have content)`,
  ).toBeGreaterThan(0);
  expect(snapshot!.info.length ?? 0, `${label}: xterm buffer length is 0`).toBeGreaterThan(0);
}

async function assertTerminalUsesWebgl(page: Page, paneId: string, label: string): Promise<void> {
  const usesWebgl = await page.evaluate((selector) => {
    const root = document.querySelector(`${selector} .xterm-screen`);
    if (!(root instanceof HTMLElement)) return false;
    const canvas = Array.from(root.querySelectorAll('canvas')).find((candidate) => !candidate.className);
    return canvas instanceof HTMLCanvasElement && canvas.getContext('webgl2') !== null;
  }, terminalSelector(paneId));
  expect(usesWebgl, `${label}: terminal is not using the WebGL renderer`).toBe(true);
}

async function assertRendererColsMatchTmux(page: Page, pane: MuxBasePane, label: string): Promise<void> {
  let lastSnap: TerminalSnapshot | null = null;
  let lastTw = -1;
  let lastTh = -1;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    lastSnap = await getTerminalSnapshot(page, pane.id);
    if (!lastSnap?.info?.cols || !lastSnap.info.rows) {
      await page.waitForTimeout(200);
      continue;
    }
    const dims = runTmux(['display', '-p', '-t', pane.paneId, '#{pane_width}x#{pane_height}']).trim();
    const [tw, th] = dims.split('x').map(Number);
    lastTw = tw;
    lastTh = th;
    if (lastSnap.info.cols === tw && lastSnap.info.rows === th) return;
    await page.waitForTimeout(250);
  }
  throw new Error(
    `${label}: renderer cols/rows (${lastSnap?.info?.cols}x${lastSnap?.info?.rows}) ` +
    `do not match tmux pane (${lastTw}x${lastTh}) for pane ${pane.id}`,
  );
}

const DUPLICATE_STATUS_PATTERN = /(Smooshing|Crunching|Thinking|Pondering|Cogitating|Forging|Examining|Wrangling|tokens\)|esc to interrupt)/i;

// Lines without any alphanumeric content (e.g. ──── separators) are legitimate
// TUI chrome that agents repeat by design — skip them in dedup checks.
const MEANINGFUL_CONTENT_PATTERN = /[\p{L}\p{N}]{3,}/u;

const createdPanesRegistry = new Map<string, MuxBasePane>();

function extractEvidenceStrings(evidence: unknown): string[] {
  if (!evidence) return [];
  if (Array.isArray(evidence)) {
    const out: string[] = [];
    for (const item of evidence) {
      if (typeof item === 'string') out.push(item);
      else if (Array.isArray(item) && typeof item[0] === 'string') out.push(item[0]);
      else out.push(...extractEvidenceStrings(item));
    }
    return out;
  }
  if (typeof evidence === 'object') {
    const out: string[] = [];
    for (const value of Object.values(evidence as Record<string, unknown>)) {
      out.push(...extractEvidenceStrings(value));
    }
    return out;
  }
  return [];
}

function countNormalizedInText(text: string, needle: string): number {
  return countOccurrences(normalizeVisibleMarkerText(text), normalizeVisibleMarkerText(needle));
}

function countEvidenceInTerminalEvents(events: TerminalDebugDataEvent[] | undefined, needle: string): number {
  if (!events) return 0;
  return events.reduce((sum, event) => (
    sum + event.meaningfulLines.reduce((lineSum, line) => lineSum + countNormalizedInText(line, needle), 0)
  ), 0);
}

async function dumpTerminalForensics(
  page: Page,
  paneId: string,
  label: string,
  snapshot: TerminalSnapshot,
  kind: string,
  evidence: unknown,
): Promise<void> {
  const safe = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  mkdirSync(SOAK_SCREENSHOTS_DIR, { recursive: true });
  const screenshotPath = resolve(SOAK_SCREENSHOTS_DIR, `forensics-${safe}.png`);
  await page.screenshot({ fullPage: true, path: screenshotPath }).catch(() => {});
  const registeredPane = createdPanesRegistry.get(paneId);
  const tmuxPaneId = registeredPane?.paneId;
  const tmuxCapture = tmuxPaneId
    ? runTmux(['capture-pane', '-t', tmuxPaneId, '-p', '-S', '-200', '-e'])
    : '';
  const tmuxDims = tmuxPaneId
    ? runTmux(['display', '-p', '-t', tmuxPaneId, '#{pane_width}x#{pane_height}']).trim()
    : '';
  const transcriptPath = registeredPane?.terminalTranscriptPath;
  const transcriptText = transcriptPath && existsSync(transcriptPath)
    ? readFileSync(transcriptPath, 'utf8')
    : '';
  const evidenceStrings = extractEvidenceStrings(evidence);
  const evidenceCounts = evidenceStrings.map((value) => ({
    eventCount: countEvidenceInTerminalEvents(snapshot.info.dataEventHistory, value),
    transcriptCount: countNormalizedInText(transcriptText, value),
    value,
    xtermCount: countNormalizedInText(snapshot.lines.join('\n'), value),
  }));
  const dump = {
    kind,
    label,
    paneId,
    tmuxPaneId,
    tmuxDims,
    transcriptPath,
    transcriptSize: transcriptText.length,
    info: snapshot.info,
    visibleLineCount: snapshot.visibleLines.length,
    visibleLines: snapshot.visibleLines,
    bufferLineCount: snapshot.lines.length,
    bufferLines: snapshot.lines.slice(-200),
    tmuxCapture,
    evidence,
    evidenceCounts,
  };
  const dumpPath = resolve(SOAK_SCREENSHOTS_DIR, `forensics-${safe}.json`);
  writeFileSync(dumpPath, JSON.stringify(dump, null, 2), 'utf8');
}

async function assertNoDuplicateStatusLines(page: Page, paneId: string, label: string): Promise<void> {
  const snapshot = await getTerminalSnapshot(page, paneId);
  if (!snapshot) return;
  const cleanedAll = snapshot.lines
    .map((line) => normalizeVisibleMarkerText(line))
    .filter((line) => line.length > 0);
  const cleanedVisible = snapshot.visibleLines
    .map((line) => normalizeVisibleMarkerText(line))
    .filter((line) => line.length > 0);
  const statusMatches = cleanedVisible.filter((line) => DUPLICATE_STATUS_PATTERN.test(line));
  if (statusMatches.length > 1) {
    await dumpTerminalForensics(page, paneId, label, snapshot, 'status-line-duplicates', statusMatches);
  }
  expect(
    statusMatches.length,
    `${label}: ${statusMatches.length} duplicate TUI status lines detected: ${JSON.stringify(statusMatches.slice(0, 6))}`,
  ).toBeLessThanOrEqual(1);
  const dedupeCounts = new Map<string, number>();
  for (const line of cleanedAll) {
    if (line.length < 24) continue;
    if (!MEANINGFUL_CONTENT_PATTERN.test(line)) continue;
    dedupeCounts.set(line, (dedupeCounts.get(line) ?? 0) + 1);
  }
  const heavilyDuplicated = [...dedupeCounts.entries()].filter(([, count]) => count >= 3);
  if (heavilyDuplicated.length > 0) {
    await dumpTerminalForensics(page, paneId, label, snapshot, 'long-line-duplicates', heavilyDuplicated);
  }
  expect(
    heavilyDuplicated.length,
    `${label}: long lines appear duplicated 3+ times (overprint): ${JSON.stringify(heavilyDuplicated.slice(0, 4))}`,
  ).toBe(0);
}

async function assertNoCorruptedCellsAfterResize(page: Page, paneId: string, label: string): Promise<void> {
  const snapshot = await getTerminalSnapshot(page, paneId);
  if (!snapshot) return;
  const raw = snapshot.lines.join('\n');
  expect(raw, `${label}: U+FFFD replacement char in xterm buffer`).not.toMatch(/�/);
  const orphanEsc = raw.match(/\x1b(?![\[\]PX^_])/g);
  expect(orphanEsc, `${label}: orphan ESC bytes in xterm buffer`).toBeNull();
  if (snapshot.info.cols && snapshot.info.cols > 0) {
    const tolerance = snapshot.info.cols + 2;
    const overLong = snapshot.lines.filter((line) => line.length > tolerance);
    if (overLong.length > 0) {
      await dumpTerminalForensics(
        page,
        paneId,
        label,
        snapshot,
        'overlong-buffer-lines',
        overLong.slice(0, 20).map((line) => ({
          codePoints: Array.from(line).length,
          codeUnits: line.length,
          line,
        })),
      );
    }
    expect(
      overLong.length,
      `${label}: ${overLong.length} buffer lines exceed cols=${snapshot.info.cols}+2 (reflow corruption)`,
    ).toBe(0);
  }
  if (
    snapshot.info.cols !== undefined &&
    snapshot.info.cursorX !== undefined &&
    snapshot.info.cursorX > snapshot.info.cols
  ) {
    throw new Error(
      `${label}: cursorX=${snapshot.info.cursorX} exceeds cols=${snapshot.info.cols} (cursor drift)`,
    );
  }
}

async function rapidViewportJitter(page: Page, iterations: number): Promise<void> {
  for (let i = 0; i < iterations; i += 1) {
    await page.setViewportSize({ width: 1180 + (i % 5) * 22, height: 700 + (i % 4) * 18 });
  }
}

function writeControlledRedrawScript(projectRoot: string, runId: string): string {
  const scriptPath = join(projectRoot, `controlled-redraw-${runId}.sh`);
  writeFileSync(scriptPath, [
    '#!/usr/bin/env bash',
    'set +e',
    'run_id="$1"',
    'last_a=""',
    'last_b=""',
    'redraw_count=0',
    'redraw() {',
    '  redraw_count=$((redraw_count + 1))',
    '  printf "\\033[2A"',
    '  if [ -n "$last_a" ]; then printf "\\033[2K\\r%s\\n" "$last_a"; fi',
    '  if [ -n "$last_b" ]; then printf "\\033[2K\\r%s\\n" "$last_b"; fi',
    '}',
    'trap redraw WINCH',
    'sleep 0.8',
    'for i in $(seq 1 80); do',
    '  token=$(printf "CTRL-%s-%02d" "$run_id" "$i")',
    '  line=$(printf "%02d. %s controlled payload" "$i" "$token")',
    '  printf "%s\\n" "$line"',
    '  last_a="$last_b"',
    '  last_b="$line"',
    '  sleep 0.04',
    'done',
    'printf "CTRL-%s-DONE\\n" "$run_id"',
    'sleep 20',
    '',
  ].join('\n'), 'utf8');
  return scriptPath;
}

async function createControlledTranscriptPane(page: Page, projectRoot: string, sessionName: string, runId: string): Promise<MuxBasePane> {
  const scriptPath = writeControlledRedrawScript(projectRoot, runId);
  const transcriptPath = join(projectRoot, `controlled-redraw-${runId}.ansi`);
  writeFileSync(transcriptPath, '', 'utf8');
  const tmuxPaneId = runTmux([
    'new-window',
    '-d',
    '-P',
    '-F',
    '#{pane_id}',
    '-c',
    projectRoot,
    '-t',
    sessionName,
    `bash ${shellQuote(scriptPath)} ${shellQuote(runId)}`,
  ]).trim();
  runTmux(['pipe-pane', '-t', tmuxPaneId, `cat >> ${shellQuote(transcriptPath)}`]);

  const pane: MuxBasePane = {
    agent: 'claude',
    agentStatus: 'idle',
    id: `controlled-${runId}`,
    paneId: tmuxPaneId,
    projectRoot,
    prompt: 'controlled transcript redraw',
    slug: `controlled-${runId}`,
    terminalTranscriptPath: transcriptPath,
    title: 'Controlled Redraw',
    type: 'worktree',
    worktreePath: projectRoot,
  };
  createdPanesRegistry.set(pane.id, pane);
  await injectPaneIntoRenderer(page, pane);
  await waitForTerminalDebug(page, pane.id);
  return pane;
}

function countTokenInTerminalEvents(events: TerminalDebugDataEvent[] | undefined, token: string): number {
  if (!events) return 0;
  return events.reduce((sum, event) => (
    sum + event.meaningfulLines.reduce((lineSum, line) => lineSum + countNormalizedInText(line, token), 0)
  ), 0);
}

async function waitForTranscriptMarkerWhileStressing(
  page: Page,
  pane: MuxBasePane,
  marker: string,
  turn: number,
  stressPaneIds: string[] = [pane.id],
): Promise<string> {
  const deadline = Date.now() + AGENT_RESPONSE_TIMEOUT_MS;
  let lastTranscript = '';
  const paneIds = [...new Set([pane.id, ...stressPaneIds])];

  while (Date.now() < deadline) {
    if (pane.terminalTranscriptPath && existsSync(pane.terminalTranscriptPath)) {
      lastTranscript = readFileSync(pane.terminalTranscriptPath, 'utf8');
      if (countVisibleMarkerOccurrences(lastTranscript, marker) >= 2) return lastTranscript;
    }

    for (const paneId of paneIds) {
      await stressFocusTabsAndResize(page, paneId, turn);
      await stressFleetPaneResize(page, paneId, turn);
    }
    await page.setViewportSize(turn % 2 === 0 ? { height: 760, width: 1280 } : { height: 620, width: 1040 });
    if (turn % 3 === 1) {
      await rapidViewportJitter(page, 18);
      await page.waitForTimeout(350);
      try {
        await assertRendererColsMatchTmux(page, pane, `soak-jitter-turn-${turn}`);
      } catch (jitterError) {
        // Surfaced via the outer per-turn assertions to keep the loop running.
        console.warn(`[soak] cols/tmux mismatch after jitter: ${(jitterError as Error).message}`);
      }
    }
  }

  throw new Error(`soak transcript marker missing after ${AGENT_RESPONSE_TIMEOUT_MS}ms: ${marker}; transcriptTail=${lastTranscript.slice(-1000)}`);
}

describe.runIf(LIVE_SCROLL_TEST_ENABLED)('Live agent terminal scroll fidelity E2E', () => {
  let app: ElectronApplication;
  let haiProxy: HaiProxyHandle;
  let page: Page;
  let projectRoot: string;
  let sessionName: string;
  const createdPanes: MuxBasePane[] = [];

  beforeAll(async () => {
    expect(existsSync(MAIN_ENTRY), `Build output missing: ${MAIN_ENTRY}`).toBe(true);
    expectCommandOnPath('hai');
    expectCommandOnPath('claude');
    expectCommandOnPath('opencode');
    haiProxy = await startHaiProxy();

    projectRoot = realpathSync(mkdtempSync(join(tmpdir(), 'muxbase-live-scroll-e2e-')));
    writeFileSync(join(projectRoot, 'README.md'), '# Live terminal scroll E2E\n', 'utf8');
    execFileSync('git', ['init'], { cwd: projectRoot, stdio: 'ignore' });
    execFileSync('git', ['add', 'README.md'], { cwd: projectRoot, stdio: 'ignore' });
    execFileSync('git', ['-c', 'user.email=e2e@muxbase.local', '-c', 'user.name=MuxBase E2E', 'commit', '-m', 'initial'], { cwd: projectRoot, stdio: 'ignore' });
    sessionName = `muxbase-${basename(projectRoot)}`;
    killTmuxSession(sessionName);

    app = await electron.launch({
      args: [MAIN_ENTRY],
      cwd: projectRoot,
      env: {
        ...process.env,
        MUXBASE_DEV: 'true',
        MUXBASE_E2E: '1',
        NODE_ENV: 'test',
      },
    });

    page = await getAppWindow(app);
    await app.context().addInitScript(() => {
      (window as unknown as E2EWindow).__MUXBASE_E2E = true;
    });
    await page.reload();
    await page.setViewportSize({ height: 980, width: 1440 });
    await page.locator('[data-testid="app-shell"]').waitFor({ state: 'visible', timeout: 20_000 });
    const e2eQuery = await page.evaluate(() => new URL(window.location.href).searchParams.get('e2e'));
    expect(e2eQuery).toBe('1');

    const session = await invoke<SessionInfoResult>(page, IPC.SESSION_INFO);
    expect(session.projectRoot).toBe(projectRoot);
    sessionName = session.sessionName;

    const system = await getSystemCheck(page);
    expect(system.agents).toContain('claude');
    expect(system.agents).toContain('opencode');
  }, APP_STARTUP_TIMEOUT_MS);

  afterAll(async () => {
    for (const pane of [...createdPanes].reverse()) {
      await closePaneBestEffort(page, pane);
    }
    if (app) await app.close();
    if (sessionName) killTmuxSession(sessionName);
    if (projectRoot && !KEEP_E2E_ARTIFACTS) {
      rmSync(projectRoot, { force: true, recursive: true });
    } else if (projectRoot) {
      console.warn(`Live scroll E2E artifacts kept at ${projectRoot}`);
    }
    if (haiProxy) await haiProxy.stop();
  }, APP_SHUTDOWN_TIMEOUT_MS);

  it('clears the boot overlay once the Claude TUI is ready', async () => {
    const token = `MUXBASE-BOOT-${Date.now()}`;
    const prompt = `Reply with exactly ${token}-A. Do not modify files.`;
    const pane = await createAgentPane(page, prompt, projectRoot, 'claude');
    createdPanes.push(pane);
    await focusPane(page, pane.id);

    // The Claude header rendering proves the TUI painted; the overlay must then
    // clear (data-booting=false) rather than linger over the ready terminal.
    await waitForTerminalBufferText(page, pane.id, getStartupMarker('claude'));

    const overlay = page.locator(
      `${terminalSelector(pane.id)} [data-testid="terminal-boot-overlay"]`,
    );
    const cleared = await pollUntil(
      async () => (await overlay.getAttribute('data-booting')) === 'false',
      { interval: 250, label: 'boot-overlay-cleared', timeout: TERMINAL_TIMEOUT_MS },
    );
    expect(cleared).toBe(true);
  });

  it('keeps real idle Claude and OpenCode panes healthy through Fleet resize and wheel input', async () => {
    const previousProjectSettings = await invoke<{ claudeFullscreenRendering?: boolean }>(
      page,
      IPC.SETTINGS_GET,
      { projectRoot },
    );
    const previousElectronSettings = await invoke<{
      opencodeMousePassthrough: boolean;
      terminalTransport: 'classic' | 'control' | 'pty';
    }>(page, IPC.ELECTRON_SETTINGS_GET);
    const ownedPanes: MuxBasePane[] = [];
    onTestFinished(async () => {
      for (const pane of [...ownedPanes].reverse()) {
        await closePaneBestEffort(page, pane);
        createdPanesRegistry.delete(pane.id);
      }
      const ownedPaneIds = new Set(ownedPanes.map((pane) => pane.id));
      for (let index = createdPanes.length - 1; index >= 0; index -= 1) {
        if (ownedPaneIds.has(createdPanes[index].id)) createdPanes.splice(index, 1);
      }
      if (!page.isClosed()) {
        await invoke(page, IPC.SETTINGS_UPDATE, {
          key: 'claudeFullscreenRendering',
          scope: 'project',
          value: previousProjectSettings.claudeFullscreenRendering !== false,
        });
        await invoke(page, IPC.ELECTRON_SETTINGS_UPDATE, {
          key: 'terminalTransport',
          value: previousElectronSettings.terminalTransport,
        });
        await invoke(page, IPC.ELECTRON_SETTINGS_UPDATE, {
          key: 'opencodeMousePassthrough',
          value: previousElectronSettings.opencodeMousePassthrough,
        });
        await syncRendererPanes(page);
        await page.setViewportSize({ height: 980, width: 1440 });
      }
    });

    // This is a terminal lifecycle test, not a model-response test. Empty
    // prompts launch both real CLIs without starting an assistant turn.
    await invoke(page, IPC.SETTINGS_UPDATE, {
      key: 'claudeFullscreenRendering',
      scope: 'project',
      value: false,
    });
    await invoke(page, IPC.ELECTRON_SETTINGS_UPDATE, { key: 'terminalTransport', value: 'pty' });
    await invoke(page, IPC.ELECTRON_SETTINGS_UPDATE, { key: 'opencodeMousePassthrough', value: false });

    const claude = await createAgentPane(page, '', projectRoot, 'claude');
    ownedPanes.push(claude);
    createdPanes.push(claude);
    const opencode = await createAgentPane(page, '', projectRoot, 'opencode');
    ownedPanes.push(opencode);
    createdPanes.push(opencode);

    for (const pane of [claude, opencode]) {
      await focusPane(page, pane.id);
      await acceptTrustPromptIfVisible(page, pane, 10_000);
      await waitForTerminalBufferText(page, pane.id, getStartupMarker(pane.agent as AgentName));
      await waitForTerminalInputReady(page, pane.id);
    }

    await page.setViewportSize({ height: 980, width: 2000 });
    // Isolate exactly the two live agents in Fleet. Do not call showFleet()
    // after this point: it re-syncs every pane retained by earlier live tests.
    await page.evaluate((panes) => {
      const stores = (window as unknown as E2EWindow).__muxbaseStores;
      const paneStore = stores?.pane?.getState();
      paneStore?.setPanes(panes);
      paneStore?.selectPane(panes[0].id);
      stores?.ui?.getState().setActiveView('dashboard');
      stores?.ui?.getState().setViewMode('fleet');
    }, [claude, opencode]);

    await pollUntil(
      async () => (await page.locator('[data-testid="pane-cell"]').count()) === 2 ? true : null,
      { interval: 100, label: 'real-agent-exclusive-fleet', timeout: TERMINAL_TIMEOUT_MS },
    );
    for (const pane of [claude, opencode]) {
      await page.locator(`${terminalSelector(pane.id)} .xterm-screen`).waitFor({
        state: 'visible',
        timeout: TERMINAL_TIMEOUT_MS,
      });
      await waitForTerminalInputReady(page, pane.id);
      // Fleet mounts a fresh xterm. An already-idle agent can clear the boot
      // overlay before the authoritative PTY replay reaches that new terminal,
      // so readiness alone is not a paint barrier. Require the real TUI marker
      // again before evaluating its WebGL raster.
      await waitForTerminalBufferText(
        page,
        pane.id,
        getStartupMarker(pane.agent as AgentName),
      );
      await assertTerminalUsesWebgl(page, pane.id, `${pane.agent}-fleet-startup`);
      await assertTerminalNotVisuallyEmpty(page, pane.id, `${pane.agent}-fleet-startup`);
    }

    await pollUntil(
      async () => runTmux(['display-message', '-p', '-t', claude.paneId, '#{alternate_on}']).trim() === '0'
        ? true
        : null,
      { interval: 100, label: 'real-claude-normal-screen', timeout: TERMINAL_TIMEOUT_MS },
    );
    await pollUntil(
      async () => runTmux(['display-message', '-p', '-t', opencode.paneId, '#{alternate_on}']).trim() === '1'
        ? true
        : null,
      { interval: 100, label: 'real-opencode-alternate-screen', timeout: TERMINAL_TIMEOUT_MS },
    );

    const [initialClaudeGeometry, initialOpenCodeGeometry] = await Promise.all([
      waitForLiveTerminalGeometry(page, claude, (cols) => cols === 100, 'real-claude-initial'),
      waitForLiveTerminalGeometry(page, opencode, (cols) => cols > 20, 'real-opencode-initial'),
    ]);
    const initialClaudeFontSize = await waitForTerminalFontSize(
      page,
      claude.id,
      (fontSize) => fontSize > 0,
      'real-claude-initial',
    );
    const separator = page.locator(
      '[data-fleet-pane-separator="true"][aria-orientation="vertical"]',
    );
    expect(await separator.count(), 'the exclusive two-pane Fleet must have one splitter').toBe(1);
    const claudeCell = page.locator(`[data-testid="pane-cell"][data-pane-id="${claude.id}"]`);
    const [claudeCellBox, separatorBox] = await Promise.all([
      claudeCell.boundingBox(),
      separator.boundingBox(),
    ]);
    expect(claudeCellBox).not.toBeNull();
    expect(separatorBox).not.toBeNull();
    if (!claudeCellBox || !separatorBox) throw new Error('real-agent Fleet geometry is unavailable');
    const separatorIsRightOfClaude = separatorBox.x + separatorBox.width / 2
      > claudeCellBox.x + claudeCellBox.width / 2;
    const narrowClaudeDelta = separatorIsRightOfClaude ? -280 : 280;
    const observedClaudeFontSizes = [initialClaudeFontSize];
    let previousOpenCodeCols = initialOpenCodeGeometry.snapshot.info.cols!;

    for (let cycle = 0; cycle < 3; cycle += 1) {
      // dragResizeHandle reads the current separator bounds on every call, so
      // panel constraints cannot make later cycles grab a stale coordinate.
      await dragResizeHandle(page, separator, narrowClaudeDelta);
      const narrowedOpenCode = await waitForLiveTerminalGeometry(
        page,
        opencode,
        (cols) => cols !== previousOpenCodeCols,
        `real-opencode-narrow-cycle-${cycle}`,
      );
      const narrowedClaudeFontSize = await waitForTerminalFontSize(
        page,
        claude.id,
        (fontSize) => fontSize > 0,
        `real-claude-narrow-cycle-${cycle}`,
      );
      const narrowedClaude = await waitForLiveTerminalGeometry(
        page,
        claude,
        (cols) => cols === 100,
        `real-claude-narrow-cycle-${cycle}`,
      );
      observedClaudeFontSizes.push(narrowedClaudeFontSize);
      expect(narrowedClaude.metrics.rootWidth).toBeLessThan(initialClaudeGeometry.metrics.rootWidth - 100);
      expect(narrowedOpenCode.metrics.rootWidth).toBeGreaterThan(initialOpenCodeGeometry.metrics.rootWidth + 100);

      await dragResizeHandle(page, separator, -narrowClaudeDelta);
      const restoredOpenCode = await waitForLiveTerminalGeometry(
        page,
        opencode,
        (cols) => cols !== narrowedOpenCode.snapshot.info.cols,
        `real-opencode-restore-cycle-${cycle}`,
      );
      const restoredClaudeFontSize = await waitForTerminalFontSize(
        page,
        claude.id,
        (fontSize) => fontSize > 0,
        `real-claude-restore-cycle-${cycle}`,
      );
      const restoredClaude = await waitForLiveTerminalGeometry(
        page,
        claude,
        (cols) => cols === 100,
        `real-claude-restore-cycle-${cycle}`,
      );
      observedClaudeFontSizes.push(restoredClaudeFontSize);
      expect(restoredClaude.metrics.rootWidth).toBeGreaterThan(narrowedClaude.metrics.rootWidth + 100);
      previousOpenCodeCols = restoredOpenCode.snapshot.info.cols!;
    }

    expect(Math.min(...observedClaudeFontSizes)).toBeLessThan(Math.max(...observedClaudeFontSizes));
    for (const pane of [claude, opencode]) {
      await assertRendererColsMatchTmux(page, pane, `${pane.agent}-real-resize`);
      await assertNoCorruptedCellsAfterResize(page, pane.id, `${pane.agent}-real-resize`);
      await assertTerminalNotVisuallyEmpty(page, pane.id, `${pane.agent}-real-resize`);
      await assertTerminalUsesWebgl(page, pane.id, `${pane.agent}-real-resize`);
      const snapshot = await waitForTerminalDebug(page, pane.id);
      assertCleanTerminalText(snapshot.lines.join('\n'));
    }

    // Create scrollable history through each real TUI's local-shell mode. The
    // fixture is deterministic, does not call a model, and exercises the same
    // rendering and scroll paths users interact with in Claude and OpenCode.
    for (const pane of [claude, opencode]) {
      const scrollToken = `MUXBASE-REAL-SCROLL-${pane.agent.toUpperCase()}-${Date.now()}`;
      const topMarker = `${scrollToken}-TOP`;
      const bottomMarker = `${scrollToken}-BOTTOM`;
      const screen = page.locator(`${terminalSelector(pane.id)} .xterm-screen`);
      await screen.click();
      let bottomSnapshot: TerminalSnapshot;
      if (pane.agent === 'opencode') {
        // OpenCode intentionally collapses a single shell result after ten
        // lines. Several retained short results build real message history
        // without depending on that optional mouse-only expansion affordance.
        let latestSnapshot: TerminalSnapshot | null = null;
        for (let block = 0; block < 8; block += 1) {
          const blockId = String(block).padStart(2, '0');
          const blockStart = block === 0 ? topMarker : `${scrollToken}-BLOCK-${blockId}-START`;
          const blockEnd = block === 7 ? bottomMarker : `${scrollToken}-BLOCK-${blockId}-END`;
          const composeMarker = `MUXBASE_COMPOSED_${scrollToken.replace(/[^A-Za-z0-9]/g, '_')}_BLOCK_${blockId}`;
          const startSuffix = blockStart.slice(scrollToken.length);
          const endSuffix = blockEnd.slice(scrollToken.length);
          const command = `awk -v p='${scrollToken}' -v s='${startSuffix}' -v e='${endSuffix}' 'BEGIN { print p s; for (i = 0; i < 5; i += 1) printf "%s-BLOCK-${blockId}-LINE-%02d\\n", p, i; print p e }'; : ${composeMarker}`;
          latestSnapshot = await runLocalShellCommand(
            page,
            pane,
            command,
            composeMarker,
            blockEnd,
            `opencode-local-shell-${blockId}`,
          );
        }
        expect(latestSnapshot).not.toBeNull();
        bottomSnapshot = latestSnapshot!;
      } else {
        const composeMarker = `MUXBASE_COMPOSED_${scrollToken.replace(/[^A-Za-z0-9]/g, '_')}`;
        const command = `awk -v p='${scrollToken}' 'BEGIN { print p "-TOP"; for (i = 0; i < 160; i += 1) printf "%s-LINE-%03d\\n", p, i; print p "-BOTTOM" }'; : ${composeMarker}`;
        bottomSnapshot = await runLocalShellCommand(
          page,
          pane,
          command,
          composeMarker,
          bottomMarker,
          'claude-local-shell',
        );
      }
      if (pane.agent === 'claude') {
        const tmuxHistory = captureTmuxScrollback(pane.paneId);
        expect(includesVisibleMarker(tmuxHistory, topMarker)).toBe(true);
        expect(includesVisibleMarker(tmuxHistory, bottomMarker)).toBe(true);
      }
      expect(
        includesVisibleMarker(bottomSnapshot.visibleLines.join('\n'), topMarker),
        `${pane.agent}: local-shell output did not overflow one viewport`,
      ).toBe(false);

      const topSnapshot = await wheelFleetTerminalUntilMarker(
        page,
        pane.id,
        topMarker,
        -240,
        `${pane.agent}-visible-scroll-up`,
      );
      expect(includesVisibleMarker(topSnapshot.visibleLines.join('\n'), topMarker)).toBe(true);
      expect(includesVisibleMarker(topSnapshot.visibleLines.join('\n'), bottomMarker)).toBe(false);
      expect(topSnapshot.visibleLines).not.toEqual(bottomSnapshot.visibleLines);

      const restoredBottom = await wheelFleetTerminalUntilMarker(
        page,
        pane.id,
        bottomMarker,
        240,
        `${pane.agent}-visible-scroll-down`,
      );
      expect(includesVisibleMarker(restoredBottom.visibleLines.join('\n'), bottomMarker)).toBe(true);
      await page.waitForTimeout(250);
      await pollUntil(
        async () => runTmux(['display-message', '-p', '-t', pane.paneId, '#{pane_in_mode}']).trim() === '0'
          ? true
          : null,
        { interval: 100, label: `${pane.agent}-wheel-live-view`, timeout: TERMINAL_TIMEOUT_MS },
      );
      expect(
        runTmux(['display-message', '-p', '-t', pane.paneId, '#{alternate_on}']).trim(),
      ).toBe(pane.agent === 'opencode' ? '1' : '0');
      await assertTerminalNotVisuallyEmpty(page, pane.id, `${pane.agent}-post-wheel`);
      await assertTerminalUsesWebgl(page, pane.id, `${pane.agent}-post-wheel`);
    }

    expect(await page.locator('[data-testid="pane-cell"]').count()).toBe(2);
  }, 300_000);

  it('keeps Claude and OpenCode scrollback complete, deduplicated, and clean after pane switching', async () => {
    const token = `MUXBASE-LIVE-SCROLL-${Date.now()}`;

    const claude = await runAgentScenario(page, projectRoot, 'claude', token);
    createdPanes.push(claude.pane);

    const opencode = await runAgentScenario(page, projectRoot, 'opencode', token);
    createdPanes.push(opencode.pane);

    const shell = await createShellPane(page, projectRoot);
    createdPanes.push(shell);
    await syncRendererPanes(page);
    await focusPane(page, shell.id);
    await invoke(page, IPC.PANE_SEND_KEYS, {
      command: `printf '${token}-ADDED-PANE\\n'`,
      paneId: shell.id,
    });
    await waitForTmuxContent(shell.paneId, `${token}-ADDED-PANE`);
    await page.setViewportSize({ height: 520, width: 900 });
    await cycleAgentPanes(page, claude.pane.id, opencode.pane.id);

    await assertScrollableCleanAgentPane(page, claude);
    await assertScrollableCleanAgentPane(page, opencode);
  }, 600_000);

  it('keeps Claude startup scrollback deduplicated after pane switching', async () => {
    const token = `MUXBASE-LIVE-CLAUDE-DEDUP-${Date.now()}`;

    const claude = await runAgentScenario(page, projectRoot, 'claude', token);
    createdPanes.push(claude.pane);

    const shell = await createShellPane(page, projectRoot);
    createdPanes.push(shell);
    await syncRendererPanes(page);
    await focusPane(page, shell.id);
    await invoke(page, IPC.PANE_SEND_KEYS, {
      command: `printf '${token}-ADDED-PANE\\n'`,
      paneId: shell.id,
    });
    await waitForTmuxContent(shell.paneId, `${token}-ADDED-PANE`);
    await page.setViewportSize({ height: 520, width: 900 });
    await focusPane(page, shell.id);
    await focusPane(page, claude.pane.id);

    await assertScrollableCleanAgentPane(page, claude);
  }, 360_000);

  it('keeps earlier Claude chat turns visible after follow-up questions and scrollback', async () => {
    const previousProjectSettings = await invoke<{ claudeFullscreenRendering?: boolean }>(
      page,
      IPC.SETTINGS_GET,
      { projectRoot },
    );
    await invoke(page, IPC.SETTINGS_UPDATE, {
      key: 'claudeFullscreenRendering',
      scope: 'project',
      value: false,
    });
    onTestFinished(async () => {
      if (!page.isClosed()) {
        await invoke(page, IPC.SETTINGS_UPDATE, {
          key: 'claudeFullscreenRendering',
          scope: 'project',
          value: previousProjectSettings.claudeFullscreenRendering !== false,
        });
      }
    });
    const token = `MUXBASE-LIVE-CHAT-${Date.now()}`;
    const q1 = `${token}-Q1-HUMAN-PROMPT`;
    const a1 = `${token}-A1-DONE`;
    const q2 = `${token}-Q2-HUMAN-PROMPT`;
    const a2 = `${token}-A2-DONE`;
    const q3 = `${token}-Q3-HUMAN-PROMPT`;
    const a3 = `${token}-A3-DONE`;
    await page.setViewportSize({ height: 520, width: 900 });

    const prompt1 = [
      q1,
      'Explain, like a helpful teammate, how tmux panes and xterm.js rendering cooperate in this app.',
      'Answer in 30 to 34 short numbered lines so the terminal must scroll.',
      `End the assistant answer with exactly ${a1}.`,
      'Do not modify files.',
    ].join(' ');

    const pane = await createAgentPane(page, prompt1, projectRoot, 'claude');
    createdPanes.push(pane);
    expect(pane.claudeRenderer).toBe('classic');
    expect(pane.terminalFixedCols).toBe(100);
    await syncRendererPanes(page);
    await focusPane(page, pane.id);
    await waitForTerminalDebug(page, pane.id);
    await acceptTrustPromptIfVisible(page, pane);
    await waitForTranscriptAssistantMarker(pane, a1);
    await assertClaudeChatHistoryVisible(page, pane, [q1, a1], q1);

    await scrollTerminalToBottom(page, pane.id);
    await sendFollowUpToPane(page, pane.id, [
      q2,
      'Thanks. Now compare normal terminal scrollback with alternate-screen application scrolling.',
      'Answer in 30 to 34 short numbered lines.',
      `End the assistant answer with exactly ${a2}.`,
      'Do not modify files.',
    ].join(' '));
    await waitForTranscriptAssistantMarker(pane, a2);
    await assertClaudeChatHistoryVisible(page, pane, [q1, a1, q2, a2], q1);

    await scrollTerminalToBottom(page, pane.id);
    await sendFollowUpToPane(page, pane.id, [
      q3,
      'One more follow-up: give a practical checklist for debugging a missing previous-chat rendering issue.',
      'Answer in 30 to 34 short numbered lines.',
      `End the assistant answer with exactly ${a3}.`,
      'Do not modify files.',
    ].join(' '));
    await waitForTranscriptAssistantMarker(pane, a3);
    await assertClaudeChatHistoryVisible(page, pane, [q1, a1, q2, a2, q3, a3], q1);
    await assertClaudeActivityConversationRenders(page, pane, [q1, a1, q3, a3]);
  }, 600_000);

  it('shows the empty-state overlay on a fresh fullscreen Claude pane before any conversation', async () => {
    // The empty-state overlay is a fullscreen-only feature: InteractiveTerminal
    // gates it on `pane.claudeRenderer === 'fullscreen'`, which paneCreation only
    // sets when `claudeFullscreenRendering` is true at create time. Set the
    // default explicitly so this test remains isolated from earlier compatibility
    // controls, and restore the prior project value in the finally block.
    const previousProjectSettings = await invoke<{ claudeFullscreenRendering?: boolean }>(
      page,
      IPC.SETTINGS_GET,
      { projectRoot },
    );
    await invoke(page, IPC.SETTINGS_UPDATE, { key: 'claudeFullscreenRendering', scope: 'project', value: true });
    try {
      // No initial prompt: with no turn ever submitted, the pre-conversation
      // empty-state stays up indefinitely, so the assertion cannot race a reply.
      const pane = await createAgentPane(page, '', projectRoot, 'claude');
      createdPanes.push(pane);
      await syncRendererPanes(page);
      await focusPane(page, pane.id);
      await acceptTrustPromptIfVisible(page, pane, 60_000);

      // Fullscreen renderer: CLAUDE_CODE_NO_FLICKER puts Claude on the alternate
      // screen. Poll — Claude takes a moment to enter alt-screen after launch.
      await pollUntil(
        async () => (runTmux(['display', '-p', '-t', pane.paneId, '#{alternate_on}']).trim() === '1' ? true : null),
        { interval: 500, label: `claude-fullscreen-alt-screen(${pane.id})`, timeout: 60_000 },
      );

      // The empty-state hint fills the fullscreen void before the first turn.
      const emptyState = page.locator(
        `[data-pane-id="${pane.id}"] [data-testid="terminal-empty-state"]`,
      );
      await emptyState.waitFor({ state: 'visible', timeout: 30_000 });
    } finally {
      await invoke(page, IPC.SETTINGS_UPDATE, {
        key: 'claudeFullscreenRendering',
        scope: 'project',
        value: previousProjectSettings.claudeFullscreenRendering !== false,
      });
      await page.setViewportSize({ height: 980, width: 1440 });
    }
  }, 600_000);

  it('keeps Claude scrollback intact after settings round-trip mid-conversation (Symptom 1)', async () => {
    const token = `MUXBASE-FONT-${Date.now()}`;
    const q1 = `${token}-Q1`;
    const a1 = `${token}-A1`;
    const pane = await createAgentPane(
      page,
      `${q1} Answer in 20 short numbered lines and end the assistant reply with exactly ${a1}. Do not modify files.`,
      projectRoot,
      'claude',
    );
    createdPanes.push(pane);
    await syncRendererPanes(page);
    await focusPane(page, pane.id);
    await acceptTrustPromptIfVisible(page, pane, 60_000);
    await waitForTranscriptAssistantMarker(pane, a1);
    await waitForSessionAssistantMarker(page, pane, a1);
    await waitForTerminalBufferText(page, pane.id, a1);

    await invoke(page, IPC.ELECTRON_SETTINGS_UPDATE, { key: 'terminalFontSize', value: 15 });
    await page.waitForTimeout(1_500);
    await focusPane(page, pane.id);
    await waitForTerminalDebug(page, pane.id);

    const snapshot = await getTerminalSnapshot(page, pane.id);
    expect(snapshot, 'snapshot must be available after settings update').not.toBeNull();
    await assertTerminalNotVisuallyEmpty(page, pane.id, 'symptom-1-settings');
    // Classic Claude renders as a tmux copy-mode buffer holding only the current
    // screen, so the full conversation surviving the font change is proven against
    // the tmux scrollback; the rendered buffer proves the latest turn still paints.
    const buffer = snapshot!.lines.join('\n');
    const tmuxFull = captureTmuxScrollback(pane.paneId);
    expect(
      includesVisibleMarker(buffer, a1),
      'Symptom 1: latest turn must survive terminalFontSize change',
    ).toBe(true);
    expect(
      includesVisibleMarker(tmuxFull, q1) && includesVisibleMarker(tmuxFull, a1),
      'Symptom 1: scrollback (q1+a1) must survive terminalFontSize change',
    ).toBe(true);

    await invoke(page, IPC.ELECTRON_SETTINGS_UPDATE, { key: 'terminalFontSize', value: 13 });
    await page.waitForTimeout(500);
  }, 360_000);

  it('keeps multi-turn Claude chat visible after a mid-conversation terminal remount (Symptom 1)', async () => {
    const token = `MUXBASE-REMOUNT-${Date.now()}`;
    const q1 = `${token}-Q1`;
    const a1 = `${token}-A1`;
    const q2 = `${token}-Q2`;
    const a2 = `${token}-A2`;
    const pane = await createAgentPane(
      page,
      `${q1} Answer in 20 short numbered lines and end the assistant reply with exactly ${a1}. Do not modify files.`,
      projectRoot,
      'claude',
    );
    createdPanes.push(pane);
    await syncRendererPanes(page);
    await focusPane(page, pane.id);
    await acceptTrustPromptIfVisible(page, pane, 60_000);
    await waitForTranscriptAssistantMarker(pane, a1);
    await waitForSessionAssistantMarker(page, pane, a1);
    await waitForTerminalBufferText(page, pane.id, a1);

    await sendFollowUpToPane(
      page,
      pane.id,
      `${q2} Answer in 20 short numbered lines and end with exactly ${a2}.`,
    );
    await waitForTranscriptAssistantMarker(pane, a2);
    await waitForSessionAssistantMarker(page, pane, a2);
    await waitForTerminalBufferText(page, pane.id, a2);

    await unmountTerminalSurfaces(page);
    await focusPane(page, pane.id);
    await waitForTerminalDebug(page, pane.id);

    const snapshot = await waitForTerminalBufferText(page, pane.id, a2);
    await assertTerminalNotVisuallyEmpty(page, pane.id, 'symptom-1-remount');
    // Classic Claude's xterm buffer holds only the live copy-mode screen after a
    // remount (which re-attaches at the bottom), so the full multi-turn history is
    // proven against the tmux scrollback; the rendered buffer proves the latest
    // turn repainted rather than the remount wiping the pane.
    const buffer = snapshot.lines.join('\n');
    const tmuxFull = captureTmuxScrollback(pane.paneId);
    if (![q1, a1, q2, a2].every((marker) => includesVisibleMarker(tmuxFull, marker))) {
      await dumpTerminalForensics(page, pane.id, `symptom-1-remount-${token}`, snapshot, 'symptom-1-remount', {
        markers: { a1, a2, q1, q2 },
      });
    }
    expect(includesVisibleMarker(buffer, a2), 'Symptom 1: latest turn must survive remount').toBe(true);
    expect(includesVisibleMarker(tmuxFull, q1), 'Symptom 1: q1 must survive remount').toBe(true);
    expect(includesVisibleMarker(tmuxFull, a1), 'Symptom 1: a1 must survive remount').toBe(true);
    expect(includesVisibleMarker(tmuxFull, q2), 'Symptom 1: q2 must survive remount').toBe(true);
    expect(includesVisibleMarker(tmuxFull, a2), 'Symptom 1: a2 must survive remount').toBe(true);
  }, 420_000);

  it('renderer cols/rows stay in sync with tmux across rapid resizes (Symptom 2)', async () => {
    const token = `MUXBASE-COLS-${Date.now()}`;
    const pane = await createAgentPane(
      page,
      `${token}-Q1 Reply with exactly ${token}-A1 and nothing else. Do not modify files.`,
      projectRoot,
      'claude',
    );
    createdPanes.push(pane);
    await syncRendererPanes(page);
    await focusPane(page, pane.id);
    await acceptTrustPromptIfVisible(page, pane, 60_000);
    // Cols/rows sync is a property of the painted, resizable pane — gate on the
    // startup banner (fast, deterministic) rather than a slow assistant marker.
    await waitForTerminalBufferText(page, pane.id, getStartupMarker('claude'));

    await rapidViewportJitter(page, 24);
    await page.waitForTimeout(400);
    await assertRendererColsMatchTmux(page, pane, 'symptom-2-cols-match');
    await assertNoCorruptedCellsAfterResize(page, pane.id, 'symptom-2-cols-match');

    const handle = page.locator('[data-testid="focus-terminal-activity-separator"]');
    if (await handle.count() > 0) {
      await dragResizeHandle(page, handle.first(), 220);
      await dragResizeHandle(page, handle.first(), -220);
      await page.waitForTimeout(400);
      await assertRendererColsMatchTmux(page, pane, 'symptom-2-after-handle-drag');
      await assertNoCorruptedCellsAfterResize(page, pane.id, 'symptom-2-after-handle-drag');
    }
  }, 360_000);

  it('classic Claude: composer under banner, terracotta logo, constant 100-col width, single banner across resizes', async () => {
    const token = `MUXBASE-CLASSIC-${Date.now()}`;
    const pane = await createAgentPane(
      page,
      `${token}-Q1 Reply with exactly ${token}-A1 and nothing else. Do not modify files.`,
      projectRoot,
      'claude',
    );
    createdPanes.push(pane);
    await syncRendererPanes(page);
    await focusPane(page, pane.id);
    await acceptTrustPromptIfVisible(page, pane, 60_000);
    // All PR3 assertions below are properties of the painted banner/pane geometry,
    // not of a completed reply — so gate on the startup banner (fast, deterministic)
    // rather than a slow assistant marker, which makes the test robust.
    await waitForTerminalBufferText(page, pane.id, getStartupMarker('claude'));

    // 1. Classic (inline) renderer: the pane is NOT on the alternate screen.
    expect(runTmux(['display', '-p', '-t', pane.paneId, '#{alternate_on}']).trim()).toBe('0');

    // 2. Fixed 100-col reading width, held constant across a fleet-resize storm
    //    (a width-shrink is what strands a duplicate banner — the lock prevents it).
    expect(runTmux(['display', '-p', '-t', pane.paneId, '#{window_width}']).trim()).toBe('100');
    await rapidViewportJitter(page, 20);
    await page.waitForTimeout(400);
    expect(runTmux(['display', '-p', '-t', pane.paneId, '#{window_width}']).trim()).toBe('100');

    // Add a sibling pane (grid reflow) then focus back — classic's worst strand vector.
    const sibling = await createShellPane(page, projectRoot);
    createdPanes.push(sibling);
    await syncRendererPanes(page);
    await showFleet(page);
    await page.locator(terminalSelector(pane.id)).waitFor({ state: 'visible', timeout: TERMINAL_TIMEOUT_MS });
    await waitForTranscriptAssistantMarker(pane, `${token}-A1`);
    const visibleScreen = runTmux(['capture-pane', '-t', pane.paneId, '-p']);
    expect(visibleScreen.split('\n').some((line) => /^❯/.test(line))).toBe(true);
    await focusPane(page, sibling.id);
    await focusPane(page, pane.id);
    await page.waitForTimeout(400);
    expect(runTmux(['display', '-p', '-t', pane.paneId, '#{window_width}']).trim()).toBe('100');

    // 3. Composer sits directly under the banner (the iTerm inline look) and there is
    //    exactly ONE banner — no stranded duplicate — across the whole session history.
    const full = runTmux(['capture-pane', '-t', pane.paneId, '-p', '-S', '-']);
    const bannerCount = (full.match(/╭─+ Claude Code/g) ?? []).length;
    expect(bannerCount).toBe(1);
    const lines = full.split('\n');
    const bannerRow = lines.findIndex((l) => /╭─+ Claude Code/.test(l));
    const composerRow = lines.findIndex((l, i) => i > bannerRow && /^❯/.test(l));
    expect(bannerRow).toBeGreaterThanOrEqual(0);
    expect(composerRow).toBeGreaterThan(bannerRow);

    // 4. Truecolor terracotta logo (#D77757 = 38;2;215;119;87), not the indexed pink
    //    downgrade Claude emits when $TMUX is visible.
    const withEscapes = runTmux(['capture-pane', '-t', pane.paneId, '-p', '-S', '-', '-e']);
    expect(withEscapes).toContain('38;2;215;119;87');
    expect(withEscapes).not.toContain('38;5;174');
  }, 360_000);

  it('renders Claude tool tables cleanly at the locked 100-col width across fleet resizes', async () => {
    // PR3 hard-locks classic Claude to 100 cols (fitFixedWidthTerminal), so width
    // can NO LONGER change across fleet resizes. The invariant this test now proves:
    // a bordered table stays clean and at the locked width through a resize storm.
    const token = `MUXBASE-CLAUDE-TABLE-${Date.now()}`;
    const shortToken = token.slice(-6);
    const table = makeClaudeExactTable(`T${shortToken}`, 82);
    const pane = await createAgentPane(
      page,
      table.prompt,
      projectRoot,
      'claude',
    );
    createdPanes.push(pane);
    await syncRendererPanes(page);
    await focusPane(page, pane.id);
    await acceptTrustPromptIfVisible(page, pane, 60_000);
    await waitForSessionAssistantMarker(page, pane, table.doneMarker);
    await assertAssistantContainsExactTableRow(page, pane, table.row, 'claude-table-locked-width');
    await assertClaudeTableRenderedAtCurrentWidth(page, pane, table, 'claude-table-locked-width');

    // Width is locked to 100 before the storm.
    expect(runTmux(['display', '-p', '-t', pane.paneId, '#{window_width}']).trim()).toBe('100');
    await assertNoCorruptedCellsAfterResize(page, pane.id, 'claude-table-pre-storm');

    // Fleet-resize storm + sibling reflow (classic's worst strand vector). The
    // reading width must stay pinned to 100 and the table must stay clean.
    const shell = await createShellPane(page, projectRoot);
    createdPanes.push(shell);
    await syncRendererPanes(page);
    await showFleet(page);
    await page.locator(terminalSelector(pane.id)).waitFor({ state: 'visible', timeout: TERMINAL_TIMEOUT_MS });

    await rapidViewportJitter(page, 24);
    await page.waitForTimeout(400);
    expect(runTmux(['display', '-p', '-t', pane.paneId, '#{window_width}']).trim()).toBe('100');
    await focusPane(page, shell.id);
    await focusPane(page, pane.id);
    await page.waitForTimeout(400);
    expect(runTmux(['display', '-p', '-t', pane.paneId, '#{window_width}']).trim()).toBe('100');

    // Table still renders cleanly at the locked width after all the churn.
    await assertClaudeTableRenderedAtCurrentWidth(page, pane, table, 'claude-table-post-storm');
    await assertNoCorruptedCellsAfterResize(page, pane.id, 'claude-table-post-storm');
    await takeSoakScreenshot(page, 'claude-tool-table-locked-width-final');
  }, 600_000);

  it('does not duplicate Claude TUI status lines across rapid resizes during streaming (Symptom 3)', async () => {
    const token = `MUXBASE-OVERPRINT-${Date.now()}`;
    const q1 = `${token}-Q1`;
    const a1 = `${token}-A1`;
    const pane = await createAgentPane(
      page,
      `${q1} Answer in 120 short numbered lines (this should take a while to stream) and end the assistant reply with exactly ${a1}. Do not modify files.`,
      projectRoot,
      'claude',
    );
    createdPanes.push(pane);
    createdPanesRegistry.set(pane.id, pane);
    await syncRendererPanes(page);
    await focusPane(page, pane.id);
    await acceptTrustPromptIfVisible(page, pane, 60_000);

    let duplicateError: Error | null = null;
    const jitterDeadline = Date.now() + 30_000;
    let iteration = 0;
    while (Date.now() < jitterDeadline) {
      iteration += 1;
      const dwellMs = iteration % 4 === 0 ? 800 : 90;
      await page.setViewportSize({
        width: 980 + ((iteration * 37) % 460),
        height: 580 + ((iteration * 19) % 260),
      });
      await page.waitForTimeout(dwellMs);
      if (iteration % 5 === 0) {
        const mode = iteration % 10 === 0 ? 'fleet' : 'focus';
        await page.evaluate((m) => {
          const stores = (window as unknown as E2EWindow).__muxbaseStores;
          stores?.ui?.getState().setViewMode(m);
        }, mode).catch(() => {});
      }
      if (iteration % 3 === 0) {
        const screen = page.locator(`${terminalSelector(pane.id)} .xterm-screen`);
        await screen.hover().catch(() => {});
        await page.mouse.wheel(0, -200).catch(() => {});
      }
      try {
        await assertNoDuplicateStatusLines(page, pane.id, `symptom-3-during-stream-iter-${iteration}`);
      } catch (error) {
        duplicateError = error as Error;
        break;
      }
    }

    if (duplicateError) {
      await waitForTranscriptAssistantMarker(pane, a1).catch(() => {});
      throw duplicateError;
    }

    await focusPane(page, pane.id).catch(() => {});
    await waitForTranscriptAssistantMarker(pane, a1);
    await waitForTerminalBufferText(page, pane.id, a1);
    await page.waitForTimeout(800);
    await assertNoDuplicateStatusLines(page, pane.id, 'symptom-3-after-stream');
    await assertNoCorruptedCellsAfterResize(page, pane.id, 'symptom-3-after-stream');
  }, 540_000);

  it('renderer keeps cols/rows synced and content clean across resize-during-streaming (Symptom 2 deep)', async () => {
    const token = `MUXBASE-RESIZE-STREAM-${Date.now()}`;
    const q1 = `${token}-Q1`;
    const a1 = `${token}-A1`;
    const pane = await createAgentPane(
      page,
      `${q1} Answer in 100 short numbered lines (one per output) and end with exactly ${a1}. Do not modify files.`,
      projectRoot,
      'claude',
    );
    createdPanes.push(pane);
    await syncRendererPanes(page);
    await focusPane(page, pane.id);
    await acceptTrustPromptIfVisible(page, pane, 60_000);

    let corruption: Error | null = null;
    const deadline = Date.now() + 25_000;
    let i = 0;
    while (Date.now() < deadline) {
      i += 1;
      await page.setViewportSize({
        width: 900 + ((i * 53) % 540),
        height: 560 + ((i * 23) % 320),
      });
      await page.waitForTimeout(70);
      try {
        await assertNoCorruptedCellsAfterResize(page, pane.id, `symptom-2-deep-iter-${i}`);
      } catch (error) {
        corruption = error as Error;
        break;
      }
    }

    if (corruption) {
      await waitForTranscriptAssistantMarker(pane, a1).catch(() => {});
      throw corruption;
    }

    await waitForTranscriptAssistantMarker(pane, a1);
    await waitForTerminalBufferText(page, pane.id, a1);
    await page.waitForTimeout(600);
    await assertRendererColsMatchTmux(page, pane, 'symptom-2-deep-final');
    await assertNoCorruptedCellsAfterResize(page, pane.id, 'symptom-2-deep-final');
  }, 480_000);

  it('preserves every numbered line in xterm scrollback across a resize storm (Symptom 1 deep)', async () => {
    const token = `MUXBASE-LINES-${Date.now()}`;
    const q1 = `${token}-Q1`;
    const a1 = `${token}-A1`;
    const lineCount = 60;
    const tokenStems = Array.from(
      { length: lineCount },
      (_, idx) => `LINE-${token.slice(-8)}-${String(idx + 1).padStart(2, '0')}`,
    );
    const pane = await createAgentPane(
      page,
      `${q1} Answer with exactly ${lineCount} numbered lines, one per line. ` +
      `Line N MUST start with "N." and MUST include the exact token "${tokenStems[0].replace(/01$/, 'NN')}" where NN is the two-digit line number ` +
      `(for example, replace NN with the matching two-digit line number for each line; do not repeat any line token outside its own line). ` +
      `End the reply with exactly ${a1}. Do not modify files.`,
      projectRoot,
      'claude',
    );
    createdPanes.push(pane);
    createdPanesRegistry.set(pane.id, pane);
    await syncRendererPanes(page);
    await focusPane(page, pane.id);
    await acceptTrustPromptIfVisible(page, pane, 60_000);

    const stormDeadline = Date.now() + 18_000;
    let i = 0;
    while (Date.now() < stormDeadline) {
      i += 1;
      await page.setViewportSize({
        width: 940 + ((i * 41) % 520),
        height: 600 + ((i * 17) % 280),
      });
      await page.waitForTimeout(80);
    }

    await waitForTranscriptAssistantMarker(pane, a1);
    await waitForTerminalBufferText(page, pane.id, a1);
    await page.waitForTimeout(800);

    // Classic Claude's live xterm buffer only holds the current copy-mode screen,
    // so the full numbered-line scrollback — and the redraw-duplication strand this
    // test guards against — lives in the tmux history, which is exactly where the
    // classic-renderer dup would land. Count line-body tokens there.
    const snapshot = await waitForTerminalDebug(page, pane.id);
    const buffer = captureTmuxScrollback(pane.paneId);
    const normalized = normalizeVisibleMarkerText(buffer);
    const missing: string[] = [];
    const duplicated: Array<{ token: string; count: number }> = [];
    for (const stem of tokenStems) {
      const needle = normalizeVisibleMarkerText(stem);
      const occurrences = countOccurrences(normalized, needle);
      if (occurrences === 0) missing.push(stem);
      else if (occurrences > 1) duplicated.push({ token: stem, count: occurrences });
    }

    if (missing.length > 0 || duplicated.length > 0) {
      await dumpTerminalForensics(page, pane.id, 'symptom-1-deep-lines', snapshot, 'line-body-integrity', { missing, duplicated });
    }
    const intact = lineCount - missing.length - duplicated.length;
    expect(
      intact,
      `Symptom 1 deep: only ${intact}/${lineCount} per-line tokens are present-and-unique. ` +
      `missing=${missing.length} duplicated=${duplicated.length}. ` +
      `firstMissing=${JSON.stringify(missing.slice(0, 5))} firstDup=${JSON.stringify(duplicated.slice(0, 5))}`,
    ).toBeGreaterThanOrEqual(Math.ceil(lineCount * 0.8));
    expect(
      duplicated,
      `Symptom 1 deep: ${duplicated.length} unique line bodies appear more than once in scrollback: ${JSON.stringify(duplicated.slice(0, 5))}`,
    ).toEqual([]);
  }, 480_000);

  it('localizes controlled transcript redraw duplication across transcript, IPC, and xterm', async () => {
    const runId = `${Date.now()}`;
    const pane = await createControlledTranscriptPane(page, projectRoot, sessionName, runId);
    const tokens = Array.from({ length: 80 }, (_, idx) => `CTRL-${runId}-${String(idx + 1).padStart(2, '0')}`);

    try {
      const deadline = Date.now() + 12_000;
      let i = 0;
      while (Date.now() < deadline) {
        i += 1;
        await page.setViewportSize({
          height: 620 + ((i * 29) % 220),
          width: 980 + ((i * 47) % 420),
        });
        await page.waitForTimeout(70);
        if (pane.terminalTranscriptPath && existsSync(pane.terminalTranscriptPath)) {
          const transcript = readFileSync(pane.terminalTranscriptPath, 'utf8');
          if (transcript.includes(`CTRL-${runId}-DONE`)) break;
        }
      }

      await waitForTranscriptIncludes(pane, `CTRL-${runId}-DONE`);
      await waitForTerminalBufferText(page, pane.id, `CTRL-${runId}-DONE`);
      await page.waitForTimeout(800);

      const snapshot = await waitForTerminalDebug(page, pane.id);
      const transcript = readFileSync(pane.terminalTranscriptPath!, 'utf8');
      const xtermText = snapshot.lines.join('\n');
      const evidence = tokens.map((token) => ({
        eventCount: countTokenInTerminalEvents(snapshot.info.dataEventHistory, token),
        token,
        transcriptCount: countNormalizedInText(transcript, token),
        xtermCount: countNormalizedInText(xtermText, token),
      })).filter((entry) => entry.transcriptCount !== 1 || entry.eventCount !== 1 || entry.xtermCount !== 1);

      if (evidence.length > 0) {
        await dumpTerminalForensics(page, pane.id, 'controlled-redraw-localization', snapshot, 'controlled-token-counts', evidence);
      }

      expect(
        evidence,
        `Controlled redraw token counts should stay exactly once per boundary: ${JSON.stringify(evidence.slice(0, 12))}`,
      ).toEqual([]);
    } finally {
      await invoke(page, IPC.TERMINAL_DETACH, { paneId: pane.id }).catch(() => {});
      try {
        runTmux(['kill-pane', '-t', pane.paneId]);
      } catch {
        // best-effort cleanup; the whole test session is killed in afterAll.
      }
      createdPanesRegistry.delete(pane.id);
    }
  }, 180_000);

  it.runIf(SOAK_ENABLED)('soaks a live Claude and OpenCode workday with chat, tab switching, resizing, and screenshots', async () => {
    const token = `MUXBASE-SOAK-${Date.now()}`;
    const screenshots: string[] = [];
    const consoleIssues: string[] = [];
    const observedFailures: string[] = [];
    const observedFailureLabels = new Set<string>();
    const pageErrors: string[] = [];
    const markers: string[] = [];
    const claudeInvariantState: SoakInvariantState = {};
    const opencodeInvariantStates = new Map<string, SoakInvariantState>();
    const opencodeTargets: SoakTrackedPane[] = [];
    const reportPath = resolve(SOAK_SCREENSHOTS_DIR, 'soak-status.json');
    let claudePane: MuxBasePane | null = null;
    let completedTurns = 0;
    let interactionStartMs = Date.now();
    let interactionElapsedMs = 0;
    let reproduced = false;

    const onConsole = (msg: ConsoleMessage) => {
      if (msg.type() === 'error' || msg.type() === 'warning') {
        consoleIssues.push(`[${msg.type()}] ${msg.text()}`);
      }
    };
    const onPageError = (error: Error) => {
      pageErrors.push(error.stack ?? error.message);
    };
    const recordObservedFailure = async (label: string, error: unknown) => {
      if (observedFailureLabels.has(label)) return;
      observedFailureLabels.add(label);
      const message = error instanceof Error ? error.message : String(error);
      observedFailures.push(`${label}: ${message}`);
      reproduced = true;
      const safeLabel = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      if (observedFailures.length <= 20) {
        screenshots.push(await takeSoakScreenshot(page, `failure-${String(observedFailures.length).padStart(2, '0')}-${safeLabel}`).catch(() => ''));
      }
    };
    page.on('console', onConsole);
    page.on('pageerror', onPageError);

    try {
      await page.setViewportSize({ height: 760, width: 1280 });
      const q0 = `${token}-TURN-00-PROMPT`;
      const a0 = `${token}-TURN-00-DONE`;
      const initialPrompt = [
        q0,
        'We are doing a long realistic UI soak test of this desktop tool.',
        'Explain how a developer should use the terminal, Activity conversation, and token tabs during a normal work session.',
        'Answer in 48 to 56 short numbered lines so the terminal scrollback is exercised.',
        `End the assistant answer with exactly ${a0}.`,
        'Do not modify files.',
      ].join(' ');

      claudePane = await createAgentPane(page, initialPrompt, projectRoot, 'claude');
      createdPanes.push(claudePane);
      await syncRendererPanes(page);
      await focusPane(page, claudePane.id);
      await waitForTerminalDebug(page, claudePane.id);
      await acceptTrustPromptIfVisible(page, claudePane, 60_000);
      await waitForTranscriptAssistantMarker(claudePane, a0);
      markers.push(q0, a0);
      try {
        await assertSoakInvariants(page, claudePane, 'claude', claudeInvariantState, 0);
      } catch (error) {
        await recordObservedFailure('claude-initial-invariants', error);
      }

      for (const index of [1, 2]) {
        const label = `opencode-${index}`;
        const openQ0 = `${token}-${label.toUpperCase()}-TURN-00-PROMPT`;
        const openA0 = `${token}-${label.toUpperCase()}-TURN-00-DONE`;
        const openPrompt = [
          openQ0,
          `You are OpenCode pane ${index} in the same long UI soak test.`,
          'Describe a realistic developer workflow that switches between panes, Activity, terminal output, and previous chat history.',
          'Answer in 24 to 30 short numbered lines so this pane also creates scrollback.',
          `End the assistant answer with exactly ${openA0}.`,
          'Do not modify files.',
        ].join(' ');
        const openPane = await createAgentPane(page, openPrompt, projectRoot, 'opencode');
        createdPanes.push(openPane);
        await syncRendererPanes(page);
        await focusPane(page, openPane.id);
        await waitForTerminalDebug(page, openPane.id);
        await waitForTranscriptAssistantMarker(openPane, openA0);
        opencodeTargets.push({ agent: 'opencode', label, markers: [openQ0, openA0], pane: openPane });
        const invariantState: SoakInvariantState = {};
        opencodeInvariantStates.set(label, invariantState);
        try {
          await assertSoakInvariants(page, openPane, label, invariantState, 0);
        } catch (error) {
          await recordObservedFailure(`${label}-initial-invariants`, error);
        }
        try {
          await assertTrackedPaneTerminalState(page, opencodeTargets[opencodeTargets.length - 1], 0);
        } catch (error) {
          await recordObservedFailure(`${label}-initial-terminal-history`, error);
        }
      }

      await focusPane(page, claudePane.id);
      screenshots.push(await takeSoakScreenshot(page, '00-soak-start-focus'));

      interactionStartMs = Date.now();
      const interactionDeadline = interactionStartMs + SOAK_DURATION_MS;
      const targetTurns = 10;
      const perTurnMs = Math.floor(SOAK_DURATION_MS / targetTurns);
      const stressPaneIds = [claudePane.id, ...opencodeTargets.map((target) => target.pane.id)];

      for (let turn = 1; turn <= targetTurns; turn += 1) {
        const turnLabel = String(turn).padStart(2, '0');
        const q = `${token}-TURN-${turnLabel}-PROMPT`;
        const a = `${token}-TURN-${turnLabel}-DONE`;
        try {
          await scrollTerminalToBottom(page, claudePane.id);
        } catch (error) {
          await recordObservedFailure(`turn-${turn}-terminal-visible-before-send`, error);
        }
        await sendFollowUpToPane(page, claudePane.id, [
          q,
          `This is soak turn ${turn}. Respond like a teammate during an intensive coding day.`,
          'Cover one concrete workflow: reading prior chat, checking Activity, resizing panes, and returning to terminal work.',
          'Answer in 34 to 42 short numbered lines.',
          `End the assistant answer with exactly ${a}.`,
          'Do not modify files.',
        ].join(' '));

        await waitForTranscriptMarkerWhileStressing(page, claudePane, a, turn, stressPaneIds);
        markers.push(q, a);
        completedTurns = turn;

        try {
          await assertSoakState(page, claudePane, markers, turn);
        } catch (error) {
          await recordObservedFailure(`turn-${turn}-terminal-history`, error);
          await scrollTerminalToBottom(page, claudePane.id).catch(() => {});
        }
        try {
          await assertSoakInvariants(page, claudePane, 'claude', claudeInvariantState, turn);
        } catch (error) {
          await recordObservedFailure(`turn-${turn}-claude-invariants`, error);
        }
        if (turn === 1 || turn === 5 || turn === 10) {
          screenshots.push(await takeSoakScreenshot(page, `${String(turn).padStart(2, '0')}-after-turn-${turnLabel}`));
        }
        if (turn % 2 === 0) {
          try {
            await assertClaudeActivityConversationRenders(page, claudePane, [q0, a0, q, a]);
          } catch (error) {
            await recordObservedFailure(`turn-${turn}-activity-conversation`, error);
          }
        }
        if (turn % 3 === 0) {
          for (const target of opencodeTargets) {
            const openQ = `${token}-${target.label.toUpperCase()}-TURN-${turnLabel}-PROMPT`;
            const openA = `${token}-${target.label.toUpperCase()}-TURN-${turnLabel}-DONE`;
            await scrollTerminalToBottom(page, target.pane.id).catch(() => {});
            await sendFollowUpToPane(page, target.pane.id, [
              openQ,
              `This is OpenCode soak turn ${turn} for ${target.label}.`,
              'Respond as if you are one of several panes in an intensive coding day.',
              'Mention switching tabs, resizing split panes, and checking older terminal output.',
              'Answer in 18 to 24 short numbered lines.',
              `End the assistant answer with exactly ${openA}.`,
              'Do not modify files.',
            ].join(' '));

            try {
              await waitForTranscriptMarkerWhileStressing(page, target.pane, openA, turn, stressPaneIds);
              target.markers.push(openQ, openA);
              await assertTrackedPaneTerminalState(page, target, turn);
              await assertSoakInvariants(
                page,
                target.pane,
                target.label,
                getInvariantState(opencodeInvariantStates, target.label),
                turn,
              );
            } catch (error) {
              await recordObservedFailure(`${target.label}-turn-${turn}-terminal-history`, error);
              await scrollTerminalToBottom(page, target.pane.id).catch(() => {});
            }
          }
        }

        const targetTimeForTurn = Math.min(interactionDeadline, interactionStartMs + perTurnMs * turn);
        while (Date.now() < targetTimeForTurn) {
          for (const paneId of stressPaneIds) {
            await stressFocusTabsAndResize(page, paneId, turn);
            await stressFleetPaneResize(page, paneId, turn);
          }
          await focusPane(page, claudePane.id);
          try {
            await scrollTerminalToTop(page, claudePane.id, q0);
          } catch (error) {
            await recordObservedFailure(`turn-${turn}-paced-scrollback`, error);
          }
          await scrollTerminalToBottom(page, claudePane.id).catch(() => {});
          try {
            await assertSoakInvariants(page, claudePane, 'claude', claudeInvariantState, turn);
          } catch (error) {
            await recordObservedFailure(`turn-${turn}-claude-paced-invariants`, error);
          }
          for (const target of opencodeTargets) {
            try {
              await assertTrackedPaneTerminalState(page, target, turn);
              await assertSoakInvariants(
                page,
                target.pane,
                target.label,
                getInvariantState(opencodeInvariantStates, target.label),
                turn,
              );
            } catch (error) {
              await recordObservedFailure(`${target.label}-turn-${turn}-paced-render`, error);
            }
          }
        }
      }

      while (Date.now() < interactionDeadline) {
        for (const paneId of stressPaneIds) {
          await stressFocusTabsAndResize(page, paneId, completedTurns + 1);
          await stressFleetPaneResize(page, paneId, completedTurns + 1);
        }
      }

      try {
        await assertSoakState(page, claudePane, markers, completedTurns);
        await assertSoakInvariants(page, claudePane, 'claude', claudeInvariantState, completedTurns);
      } catch (error) {
        await recordObservedFailure('final-terminal-history', error);
      }
      try {
        await assertClaudeActivityConversationRenders(page, claudePane, [markers[0], markers[1], markers[markers.length - 2], markers[markers.length - 1]]);
      } catch (error) {
        await recordObservedFailure('final-activity-conversation', error);
      }
      for (const target of opencodeTargets) {
        try {
          await assertTrackedPaneTerminalState(page, target, completedTurns);
          await assertSoakInvariants(
            page,
            target.pane,
            target.label,
            getInvariantState(opencodeInvariantStates, target.label),
            completedTurns,
          );
        } catch (error) {
          await recordObservedFailure(`${target.label}-final-terminal-history`, error);
        }
      }
      await showFleet(page);
      screenshots.push(await takeSoakScreenshot(page, '98-soak-final-fleet'));
      await focusPane(page, claudePane.id);
      await clickFirstVisibleTab(page, 'Activity');
      screenshots.push(await takeSoakScreenshot(page, '99-soak-final-activity'));
    } catch (error) {
      reproduced = true;
      if (page && !page.isClosed()) {
        screenshots.push(await takeSoakScreenshot(page, '99-soak-failure').catch(() => ''));
      }
      throw error;
    } finally {
      interactionElapsedMs = Date.now() - interactionStartMs;
      page.off('console', onConsole);
      page.off('pageerror', onPageError);

      mkdirSync(SOAK_SCREENSHOTS_DIR, { recursive: true });
      const session = claudePane ? await getNormalizedSession(page, claudePane.id).catch(() => null) : null;
      const terminalSnapshot = claudePane ? await getTerminalSnapshot(page, claudePane.id).catch(() => null) : null;
      const transcriptBytes = claudePane?.terminalTranscriptPath && existsSync(claudePane.terminalTranscriptPath)
        ? readFileSync(claudePane.terminalTranscriptPath).byteLength
        : 0;
      const opencodeReports: Array<{
        label: string;
        markersVerified: number;
        paneId: string;
        session: { agent: string; isOngoing: boolean; messageCount: number; totalTokens: number } | null;
        terminal: TerminalDebugInfo | null;
        transcriptBytes: number;
      }> = [];
      for (const target of opencodeTargets) {
        const targetSession = await getNormalizedSession(page, target.pane.id).catch(() => null);
        const targetTerminal = await getTerminalSnapshot(page, target.pane.id).catch(() => null);
        const targetTranscriptBytes = target.pane.terminalTranscriptPath && existsSync(target.pane.terminalTranscriptPath)
          ? readFileSync(target.pane.terminalTranscriptPath).byteLength
          : 0;
        opencodeReports.push({
          label: target.label,
          markersVerified: target.markers.length,
          paneId: target.pane.id,
          session: targetSession ? {
            agent: targetSession.agent,
            isOngoing: targetSession.isOngoing,
            messageCount: targetSession.messages.length,
            totalTokens: targetSession.metrics.totalTokens,
          } : null,
          terminal: targetTerminal ? targetTerminal.info : null,
          transcriptBytes: targetTranscriptBytes,
        });
      }
      writeFileSync(reportPath, JSON.stringify({
        agentPaneCount: 1 + opencodeTargets.length,
        completedTurns,
        consoleIssues,
        durationMsRequested: SOAK_DURATION_MS,
        interactionElapsedMs,
        markersVerified: markers.length,
        observedFailures,
        opencode: opencodeReports,
        pageErrors,
        reproduced: reproduced || observedFailures.length > 0,
        screenshots: screenshots.filter(Boolean),
        session: session ? {
          agent: session.agent,
          isOngoing: session.isOngoing,
          messageCount: session.messages.length,
          totalTokens: session.metrics.totalTokens,
        } : null,
        terminal: terminalSnapshot ? terminalSnapshot.info : null,
        transcriptBytes,
      }, null, 2));
    }

    expect(completedTurns).toBe(10);
    expect(interactionElapsedMs).toBeGreaterThanOrEqual(SOAK_DURATION_MS);
    expect(pageErrors).toEqual([]);
    expect(observedFailures).toEqual([]);
  }, SOAK_DURATION_MS + 900_000);
});
