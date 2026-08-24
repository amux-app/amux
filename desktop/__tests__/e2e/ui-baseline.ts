import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import type { ElectronApplication, Page } from 'playwright';

// UI/UX baseline capture helpers. Used by the opt-in (AUMX_UI_BASELINE=1) capture
// test in app.e2e.test.ts; they record artifacts and assert nothing.

const BASELINE_ROOT = resolve(__dirname, '..', '..');

export const BASELINE_DIR = resolve(BASELINE_ROOT, 'out', 'ui-baseline');
export const BASELINE_VIEWPORTS = [
  { height: 720, name: '1280x720', width: 1280 },
  { height: 900, name: '1440x900', width: 1440 },
  { height: 1117, name: '1728x1117', width: 1728 },
] as const;
export const BASELINE_THEMES = ['dark', 'light', 'colorful', 'dark-colorful'] as const;
export const BASELINE_PANE_COUNTS = [0, 1, 4, 6, 8] as const;
export const BASELINE_CAPTURE_TIMEOUT_MS = 900_000;
export const BASELINE_MIN_TARGET_PX = 24;

const BASELINE_REPORT_PATH = resolve(BASELINE_DIR, 'ui-baseline.json');
const BASELINE_AXE_PANE_COUNTS: number[] = [0, 4];
const BASELINE_AXE_VIEWPORT = '1440x900';
const BASELINE_AXE_THEME = 'dark';
const BASELINE_RENDER_TIMEOUT_MS = 8_000;
const BASELINE_SETTLE_MS = 700;
const BASELINE_PANE_CELL = '[data-testid="pane-cell"]';
const BASELINE_TITLES = [
  'Refactor auth flow',
  'Optimize render pipeline',
  'Generate API docs',
  'Fix flaky worktree tests',
  'Migrate config loader',
  'Add retry backoff',
  'Harden IPC validation',
  'Tune capture polling',
];
const BASELINE_AGENTS: Array<'claude' | 'codex' | 'opencode'> = ['claude', 'codex', 'opencode'];
const BASELINE_STATUSES: Array<'working' | 'waiting' | 'analyzing' | 'idle'> = [
  'working',
  'waiting',
  'analyzing',
  'idle',
];

export type BaselineTheme = (typeof BASELINE_THEMES)[number];
export type BaselineViewport = (typeof BASELINE_VIEWPORTS)[number];

export interface BaselinePaneFixture {
  agent: 'claude' | 'codex' | 'opencode';
  agentStatus: 'working' | 'waiting' | 'analyzing' | 'idle';
  branchName: string;
  id: string;
  paneId: string;
  projectName: string;
  projectRoot: string;
  prompt: string;
  slug: string;
  title: string;
  type: 'worktree';
  worktreePath: string;
}

interface BaselineStore {
  getState: () => { panes?: unknown[]; theme?: string };
  setState: (partial: Record<string, unknown>) => void;
}

export interface BaselineStoreWindow {
  __aumxStores?: { pane?: BaselineStore; paneActivity?: BaselineStore; ui?: BaselineStore };
}

interface BaselineAxeCheckData {
  bgColor?: string;
  contrastRatio?: number;
  expectedContrastRatio?: string;
  fgColor?: string;
  fontSize?: string;
  fontWeight?: string;
}

interface BaselineAxeNode {
  any: Array<{ data?: BaselineAxeCheckData }>;
  target: string[];
}

export interface BaselineAxeRunner {
  run: (
    context: Document,
    options: { resultTypes: string[] },
  ) => Promise<{
    violations: Array<{
      help: string;
      id: string;
      impact: string | null;
      nodes: BaselineAxeNode[];
    }>;
  }>;
}

interface BaselineContrastFinding {
  bg: string;
  fg: string;
  fontSize: string;
  ratio: number;
  required: string;
  target: string;
}

interface BaselineAxeViolation {
  contrast?: BaselineContrastFinding[];
  help: string;
  id: string;
  impact: string | null;
  nodes: number;
  sample: string[];
}

interface BaselineTargetMetrics {
  interactiveTargets: number;
  smallSamples: string[];
  smallTargets: number;
  unnamedSamples: string[];
  unnamedTargets: number;
}

interface BaselineLayoutMetrics {
  horizontalOverflow: boolean;
  innerHeight: number;
  innerWidth: number;
  paneCellsBelowFold: number;
}

export interface BaselineCell {
  appliedTheme: string;
  axe: BaselineAxeViolation[] | null;
  layout: BaselineLayoutMetrics;
  paneCells: number;
  paneCount: number;
  screenshot: string;
  targets: BaselineTargetMetrics;
  theme: BaselineTheme;
  viewport: string;
}

const SETTLE_INTERVAL_MS = 50;
const SETTLE_TIMEOUT_MS = 10_000;
const STABLE_INTERVAL_MS = 100;
const STABLE_TIMEOUT_MS = 3_000;

interface PollOptions {
  interval?: number;
  timeout?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

/**
 * Reads until the predicate holds, then returns the last value read. A value that
 * never settles is still handed to the caller, so the assertion reports the real
 * state instead of a timeout.
 */
export async function waitForValue<T>(
  read: () => Promise<T>,
  settled: (value: T) => boolean,
  options: PollOptions = {},
): Promise<T> {
  const deadline = Date.now() + (options.timeout ?? SETTLE_TIMEOUT_MS);
  let value = await read();
  while (!settled(value) && Date.now() < deadline) {
    await sleep(options.interval ?? SETTLE_INTERVAL_MS);
    value = await read();
  }
  return value;
}

/** Reads until two consecutive reads agree, so geometry is never sampled mid-animation. */
export async function waitForStable<T>(read: () => Promise<T>, options: PollOptions = {}): Promise<T> {
  const deadline = Date.now() + (options.timeout ?? STABLE_TIMEOUT_MS);
  let previous = await read();
  while (Date.now() < deadline) {
    await sleep(options.interval ?? STABLE_INTERVAL_MS);
    const current = await read();
    if (JSON.stringify(current) === JSON.stringify(previous)) return current;
    previous = current;
  }
  return previous;
}

/**
 * A modal surface or anchored menu only answers Escape and arrow keys once its mount
 * effect has run, and that same effect is what pulls focus into the surface. Waiting
 * for the focus handoff is therefore the signal that the surface is interactive — a
 * key press sent before it is simply dropped.
 */
export async function waitForSurfaceFocus(page: Page, selector: string): Promise<boolean> {
  return waitForValue(
    () => page.evaluate(
      (value) => document.querySelector(value)?.contains(document.activeElement) ?? false,
      selector,
    ),
    (inside) => inside,
  );
}

/**
 * An occluded or backgrounded Electron window freezes requestAnimationFrame, which
 * stalls modal enter/exit animations and the focus handoff scheduled inside them.
 * UI E2E results must not depend on where the window sits in the desktop stack.
 */
export async function disableBackgroundThrottling(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ BrowserWindow }) => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.setBackgroundThrottling(false);
    }
  });
}

export function prepareBaselineDir(): void {
  mkdirSync(BASELINE_DIR, { recursive: true });
}

export function readBaselineAxeSource(): string {
  const axeSourcePath = createRequire(
    realpathSync(resolve(BASELINE_ROOT, 'node_modules', 'vitest-axe', 'package.json')),
  ).resolve('axe-core/axe.min.js');
  return readFileSync(axeSourcePath, 'utf8');
}

export function writeBaselineReport(axeReady: boolean, cells: BaselineCell[]): void {
  const report = {
    axeReady,
    capturedAt: new Date().toISOString(),
    cells,
    minTargetPx: BASELINE_MIN_TARGET_PX,
  };
  writeFileSync(BASELINE_REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);
}

export function buildBaselinePanes(
  count: number,
  project: { projectName: string; projectRoot: string },
): BaselinePaneFixture[] {
  return Array.from({ length: count }, (_unused, index) => ({
    agent: BASELINE_AGENTS[index % BASELINE_AGENTS.length],
    agentStatus: BASELINE_STATUSES[index % BASELINE_STATUSES.length],
    branchName: `feat/ui-baseline-${index + 1}`,
    id: `ui-baseline-${index + 1}`,
    paneId: `%${900 + index}`,
    projectName: project.projectName,
    projectRoot: project.projectRoot,
    prompt: `${BASELINE_TITLES[index % BASELINE_TITLES.length]} and cover the change with tests.`,
    slug: `ui-baseline-${index + 1}`,
    title: BASELINE_TITLES[index % BASELINE_TITLES.length],
    type: 'worktree' as const,
    worktreePath: `/tmp/aumx-ui-baseline/ui-baseline-${index + 1}`,
  }));
}

function shouldScanBaselineAxe(viewport: string, theme: BaselineTheme, paneCount: number): boolean {
  if (!BASELINE_AXE_PANE_COUNTS.includes(paneCount)) return false;
  return viewport === BASELINE_AXE_VIEWPORT || theme === BASELINE_AXE_THEME;
}

async function countBaselinePaneCells(page: Page, expected: number): Promise<number> {
  const deadline = Date.now() + BASELINE_RENDER_TIMEOUT_MS;
  let rendered = await page.locator(BASELINE_PANE_CELL).count();
  while (rendered !== expected && Date.now() < deadline) {
    await page.waitForTimeout(100);
    rendered = await page.locator(BASELINE_PANE_CELL).count();
  }
  return rendered;
}

/**
 * Seeds a fleet into the renderer. Activity is runtime-only state that no
 * longer travels on the pane record, so both stores are written from the one
 * `agentStatus` the fixture declares.
 */
export async function seedBaselineFleet(
  page: Page,
  panes: BaselinePaneFixture[],
  selectedPaneId: string | null = null,
): Promise<void> {
  await page.evaluate(({ fixtures, selected }) => {
    const stores = (window as unknown as BaselineStoreWindow).__aumxStores;
    stores?.pane?.setState({ loaded: true, panes: fixtures, selectedPaneId: selected });
    stores?.paneActivity?.setState({
      activityByPaneId: Object.fromEntries(fixtures.map((pane) => [pane.id, {
        activityRevision: 1,
        adapterHealth: 'degraded',
        certainty: 'provisional',
        liveness: 'running',
        openBackgroundWork: [],
        origin: 'poll',
        paneIncarnationId: `${pane.id}-incarnation`,
        sinceWallMs: 0,
        state: pane.agentStatus === 'analyzing' ? 'working' : pane.agentStatus,
      }])),
      epochId: 'baseline-epoch',
      justFinishedPaneIds: new Set<string>(),
      revision: 1,
    });
  }, { fixtures: panes, selected: selectedPaneId });
}

export async function applyBaselineTheme(page: Page, theme: BaselineTheme): Promise<string> {
  await page.evaluate((value) => {
    (window as unknown as BaselineStoreWindow).__aumxStores?.ui?.setState({ theme: value });
  }, theme);
  await page.waitForTimeout(BASELINE_SETTLE_MS);
  return page.evaluate(() => document.documentElement.getAttribute('data-theme') ?? 'none');
}

async function seedBaselinePanes(page: Page, panes: BaselinePaneFixture[]): Promise<number> {
  await page.evaluate((fixtures) => {
    (window as unknown as BaselineStoreWindow).__aumxStores?.pane?.setState({
      loaded: true,
      panes: fixtures,
      selectedPaneId: null,
    });
  }, panes);
  return countBaselinePaneCells(page, panes.length);
}

async function measureBaselineLayout(page: Page): Promise<BaselineLayoutMetrics> {
  return page.evaluate((selector) => {
    const cells = Array.from(document.querySelectorAll(selector));
    return {
      horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth,
      innerHeight: window.innerHeight,
      innerWidth: window.innerWidth,
      paneCellsBelowFold: cells.filter(
        (cell) => cell.getBoundingClientRect().bottom > window.innerHeight + 1,
      ).length,
    };
  }, BASELINE_PANE_CELL);
}

async function measureBaselineTargets(page: Page): Promise<BaselineTargetMetrics> {
  return page.evaluate((minPx) => {
    const selector = 'a[href], button, input, select, textarea, [role="button"], [role="tab"], [tabindex]:not([tabindex="-1"])';
    const describe = (element: Element): string => {
      const rect = element.getBoundingClientRect();
      const label =
        element.getAttribute('data-testid') ??
        element.getAttribute('aria-label') ??
        element.getAttribute('title') ??
        (element.textContent ?? '').trim().slice(0, 24);
      return `${element.tagName.toLowerCase()}[${label}] ${Math.round(rect.width)}x${Math.round(rect.height)}`;
    };
    const isNamed = (element: Element): boolean =>
      Boolean(
        element.getAttribute('aria-label') ??
          element.getAttribute('aria-labelledby') ??
          element.getAttribute('title'),
      ) || (element.textContent ?? '').trim().length > 0;

    const visible = Array.from(document.querySelectorAll(selector)).filter((element) => {
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    });
    const small = visible.filter((element) => {
      const rect = element.getBoundingClientRect();
      return rect.width < minPx || rect.height < minPx;
    });
    const unnamed = visible.filter((element) => !isNamed(element));

    return {
      interactiveTargets: visible.length,
      smallSamples: small.slice(0, 10).map(describe),
      smallTargets: small.length,
      unnamedSamples: unnamed.slice(0, 10).map(describe),
      unnamedTargets: unnamed.length,
    };
  }, BASELINE_MIN_TARGET_PX);
}

async function runBaselineAxe(page: Page): Promise<BaselineAxeViolation[]> {
  return page.evaluate(async () => {
    const runner = (window as unknown as { axe?: BaselineAxeRunner }).axe;
    if (!runner) return [];
    const contrastOf = (node: BaselineAxeNode): BaselineContrastFinding | null => {
      const data = node.any.find((check) => typeof check.data?.contrastRatio === 'number')?.data;
      if (!data) return null;
      return {
        bg: data.bgColor ?? '',
        fg: data.fgColor ?? '',
        fontSize: data.fontSize ?? '',
        ratio: data.contrastRatio ?? 0,
        required: data.expectedContrastRatio ?? '',
        target: node.target.join(' '),
      };
    };

    const results = await runner.run(document, { resultTypes: ['violations'] });
    return results.violations.map((violation) => {
      const contrast = violation.nodes
        .map(contrastOf)
        .filter((finding): finding is BaselineContrastFinding => finding !== null);
      return {
        ...(contrast.length > 0 ? { contrast } : {}),
        help: violation.help,
        id: violation.id,
        impact: violation.impact,
        nodes: violation.nodes.length,
        sample: violation.nodes.slice(0, 4).map((node) => node.target.join(' ')),
      };
    });
  });
}

export async function captureBaselineCell(
  page: Page,
  cell: {
    appliedTheme: string;
    panes: BaselinePaneFixture[];
    paneCount: number;
    theme: BaselineTheme;
    viewport: BaselineViewport;
  },
): Promise<BaselineCell> {
  const paneCells = await seedBaselinePanes(page, cell.panes);
  await page.waitForTimeout(BASELINE_SETTLE_MS);

  const screenshot = `fleet-${cell.viewport.name}-${cell.theme}-${cell.paneCount}panes.png`;
  await page.screenshot({ path: resolve(BASELINE_DIR, screenshot) });

  const layout = await measureBaselineLayout(page);
  const targets = await measureBaselineTargets(page);
  const axe = shouldScanBaselineAxe(cell.viewport.name, cell.theme, cell.paneCount)
    ? await runBaselineAxe(page)
    : null;

  return {
    appliedTheme: cell.appliedTheme,
    axe,
    layout,
    paneCells,
    paneCount: cell.paneCount,
    screenshot,
    targets,
    theme: cell.theme,
    viewport: cell.viewport.name,
  };
}
