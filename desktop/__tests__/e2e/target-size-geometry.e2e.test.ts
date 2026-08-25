import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { resolve } from 'path';
import { _electron as electron } from 'playwright';
import type { ElectronApplication, Page } from 'playwright';
import { IPC, IPC_EVENT } from '../../src/shared/ipc-channels';
import { getAppWindow, getSessionInfo, waitForAppReady, waitForRendererPaneHydration } from './e2e-helpers';
import {
  BASELINE_DIR,
  BASELINE_MIN_TARGET_PX,
  buildBaselinePanes,
  disableBackgroundThrottling,
  waitForStable,
  waitForSurfaceFocus,
  seedBaselineFleet,
} from './ui-baseline';
import type { BaselinePaneFixture, BaselineStoreWindow } from './ui-baseline';

const ROOT = resolve(__dirname, '..', '..');
const MAIN_ENTRY = resolve(ROOT, 'out', 'main', 'index.js');
const REPORT_PATH = resolve(BASELINE_DIR, 'target-size-geometry.json');
const APP_STARTUP_TIMEOUT_MS = 60_000;
const APP_SHUTDOWN_TIMEOUT_MS = 30_000;
const STEP_TIMEOUT_MS = 60_000;
const SETTLE_MS = 350;

const FLEET_SIZE = 8;
// File tabs share the pane's tab strip. A single full-width pane keeps that
// strip unscrolled, so the file tabs are on screen rather than clipped out.
const FILE_TAB_FLEET_SIZE = 1;
const SINGLE_LINE_BAR_MAX_PX = 48;
// At 200% zoom with the sidebar expanded the rigid action cluster moves below
// the untruncated stats. Both rows remain compact and each action stays whole.
const REFLOWED_BAR_MAX_PX = 72;

// SC 2.5.8 spacing exception for an undersized target: >= 24 px centre-to-centre
// against another undersized target, >= 12 px from its centre to a conformant
// neighbour's box. Ancestor/descendant pairs and cross-layer pairs are excluded.
// Full derivation: docs/specs/ui-target-inventory.md.
const RADIUS_PX = BASELINE_MIN_TARGET_PX / 2;
const EPSILON_PX = 0.01;

const TARGET_SELECTOR =
  'a[href], button, input, select, textarea, [role="button"], [role="tab"], [role="menuitem"], [data-testid="file-tab-close"], [tabindex]:not([tabindex="-1"])';

const CLUSTERS = {
  'attention-peek': '[role="menu"][aria-label="Waiting agents"]',
  'kanban-backlog': '[data-testid="kanban-column-backlog"]',
  'kanban-done': '[data-testid="kanban-column-done"]',
  'pane-header': '[data-testid="pane-cell"] [class*="group/header"]',
  'pane-tabs': '[data-testid="pane-cell"] [role="tablist"]',
  'resource-bar': '[data-testid="resource-bar"]',
  'sidebar-row': '[data-testid="app-shell-sidebar"] li [data-sidebar-agent-select="true"]',
  titlebar: '[data-testid="app-titlebar"]',
  toast: '[aria-live="polite"]:has(button[aria-label="Dismiss"])',
  'zen-header': '[class*="group/zen-header"]',
} as const;

const KANBAN_BOARD_BUTTON = 'button:has-text("Board")';
const KANBAN_BACKLOG_COLUMN = CLUSTERS['kanban-backlog'];
const KANBAN_BACKLOG_CARD = `${KANBAN_BACKLOG_COLUMN} [data-card-id^="backlog-"]`;
const KANBAN_DONE_CARD = `${CLUSTERS['kanban-done']} [data-card-id^="done-"]`;

// Backlog and done fixtures are written through the real kanban IPC into an
// isolated temp project, so the measurement runs against production markup
// without touching any real project's .muxbase data.
const KANBAN_BACKLOG_SEED = [
  { agent: 'claude', complexity: 'S', prompt: 'Add retry backoff to the capture loop and cover it with a test.', title: 'Add retry backoff', useWorktree: true },
  { agent: 'codex', complexity: 'M', prompt: 'Harden IPC validation for every kanban channel.', title: 'Harden IPC validation', useWorktree: true },
  { agent: 'claude', complexity: 'L', prompt: 'Migrate the config loader onto the shared schema.', title: 'Migrate config loader', useWorktree: false },
] as const;

const KANBAN_DONE_SEED = [
  { agent: 'claude', branchName: 'feat/tune-capture-polling', prompt: 'Tune capture polling.', slug: 'tune-capture-polling' },
] as const;

const CREATE_MENU = '[role="menu"][aria-label="Create"]';
const FILE_TREE_ROW = '[data-testid="file-tree-row"]';
const OPENABLE_FILE_PATTERN = /\.(json|md|ts|txt|yaml)$/;
const SPLIT_PRIMARY = '[data-testid="resource-new-pane"]';
const SPLIT_CARET = '[data-testid="resource-new-menu"]';
const ATTENTION_STAT = '[data-testid="resource-attention-stat"]';
const PEEK = '[role="menu"][aria-label="Waiting agents"]';
const RESOURCE_BAR = '[data-testid="resource-bar"]';

interface Rect { height: number; width: number; x: number; y: number }

interface MeasuredTarget {
  ancestors: number[];
  clusters: string[];
  label: string;
  layer: number;
  rect: Rect;
}

interface BarLayout { barHeight: number; documentOverflow: number; tallestChild: { height: number; text: string } }

interface InvokeWindow { muxbase: { invoke: (channel: string, payload?: unknown) => Promise<unknown> } }

interface Verdict {
  clusters: string[];
  height: number;
  label: string;
  nearestLabel: string;
  nearestPx: number;
  requiredPx: number;
  scenario: string;
  verdict: 'fail' | 'pass-size' | 'pass-spacing';
  width: number;
}

const inventory: Verdict[] = [];

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function isUndersized(rect: Rect): boolean {
  const min = BASELINE_MIN_TARGET_PX - EPSILON_PX;
  return rect.width < min || rect.height < min;
}

function centerOf(rect: Rect): { x: number; y: number } {
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

function circleGap(
  center: { x: number; y: number },
  neighbor: MeasuredTarget,
): { actual: number; required: number } {
  const rect = neighbor.rect;
  if (isUndersized(rect)) {
    const other = centerOf(rect);
    return { actual: Math.hypot(other.x - center.x, other.y - center.y), required: BASELINE_MIN_TARGET_PX };
  }
  const dx = Math.max(rect.x - center.x, 0, center.x - (rect.x + rect.width));
  const dy = Math.max(rect.y - center.y, 0, center.y - (rect.y + rect.height));
  return { actual: Math.hypot(dx, dy), required: RADIUS_PX };
}

function isNeighbor(all: MeasuredTarget[], index: number, other: number): boolean {
  if (index === other || all[index].layer !== all[other].layer) return false;
  return !all[index].ancestors.includes(other) && !all[other].ancestors.includes(index);
}

function verdictFor(all: MeasuredTarget[], index: number, scenario: string): Verdict {
  const target = all[index];
  const base = {
    clusters: target.clusters,
    height: round2(target.rect.height),
    label: target.label,
    scenario,
    width: round2(target.rect.width),
  };
  if (!isUndersized(target.rect)) {
    return { ...base, nearestLabel: '', nearestPx: 0, requiredPx: 0, verdict: 'pass-size' };
  }

  const center = centerOf(target.rect);
  let worst = { actual: Infinity, label: '', required: 0, slack: Infinity };
  for (let other = 0; other < all.length; other += 1) {
    if (!isNeighbor(all, index, other)) continue;
    const gap = circleGap(center, all[other]);
    const slack = gap.actual - gap.required;
    if (slack < worst.slack) worst = { ...gap, label: all[other].label, slack };
  }

  return {
    ...base,
    nearestLabel: worst.label,
    nearestPx: round2(worst.actual),
    requiredPx: worst.required,
    verdict: worst.slack >= -EPSILON_PX ? 'pass-spacing' : 'fail',
  };
}

function describeRow(row: Verdict): string {
  return `${row.label} ${row.width}x${row.height} nearest=${row.nearestPx} required=${row.requiredPx} (${row.nearestLabel})`;
}

async function measureTargets(page: Page): Promise<MeasuredTarget[]> {
  return page.evaluate(
    ({ clusterEntries, targetSelector }) => {
      // A target is only hittable where it is actually painted: intersect the
      // element box with every clipping ancestor and with the viewport, so
      // scrolled-out tabs never count as targets (or as neighbours).
      const hittableRect = (element: HTMLElement): Rect => {
        let box = element.getBoundingClientRect() as DOMRect;
        let node: HTMLElement | null = element;
        while (node) {
          const style = getComputedStyle(node);
          if (node !== element && (style.overflowX !== 'visible' || style.overflowY !== 'visible')) {
            const clip = node.getBoundingClientRect();
            box = new DOMRect(
              Math.max(box.left, clip.left),
              Math.max(box.top, clip.top),
              Math.min(box.right, clip.right) - Math.max(box.left, clip.left),
              Math.min(box.bottom, clip.bottom) - Math.max(box.top, clip.top),
            );
          }
          if (style.position === 'fixed') break;
          node = node.parentElement;
        }
        return {
          height: Math.min(box.bottom, window.innerHeight) - Math.max(box.top, 0),
          width: Math.min(box.right, window.innerWidth) - Math.max(box.left, 0),
          x: Math.max(box.left, 0),
          y: Math.max(box.top, 0),
        };
      };

      const candidates = Array.from(document.querySelectorAll<HTMLElement>(targetSelector));
      const rects = new Map<HTMLElement, Rect>(candidates.map((element) => [element, hittableRect(element)]));
      const visible = candidates.filter((element) => {
        const rect = rects.get(element)!;
        return rect.width > 0 && rect.height > 0;
      });
      const layers: Element[] = [];
      const layerIndex = (element: HTMLElement): number => {
        let node: HTMLElement | null = element;
        while (node && node !== document.body) {
          if (getComputedStyle(node).position === 'fixed') break;
          node = node.parentElement;
        }
        const root: Element = node ?? document.body;
        const found = layers.indexOf(root);
        if (found !== -1) return found;
        layers.push(root);
        return layers.length - 1;
      };
      const containers = clusterEntries.map(([name, selector]) => ({
        name,
        node: document.querySelector(selector),
      }));
      const describe = (element: HTMLElement): string =>
        element.getAttribute('data-testid') ??
        element.getAttribute('aria-label') ??
        element.getAttribute('title') ??
        (element.textContent ?? '').trim().slice(0, 24);

      return visible.map((element, index) => ({
        ancestors: visible.flatMap((other, position) =>
          position !== index && other.contains(element) ? [position] : [],
        ),
        clusters: containers.filter((entry) => entry.node?.contains(element)).map((entry) => entry.name),
        label: describe(element),
        layer: layerIndex(element),
        rect: rects.get(element)!,
      }));
    },
    { clusterEntries: Object.entries(CLUSTERS), targetSelector: TARGET_SELECTOR },
  );
}

// Menus, toasts and modal surfaces animate in, so the inventory is only sampled
// once two consecutive measurements agree.
async function audit(page: Page, scenario: string): Promise<Verdict[]> {
  const targets = await waitForStable(() => measureTargets(page));
  const rows = targets.map((_target, index) => verdictFor(targets, index, scenario));
  inventory.push(...rows.filter((row) => row.clusters.length > 0));
  return rows;
}

function expectConformant(rows: Verdict[], cluster: string): Verdict[] {
  const scoped = rows.filter((row) => row.clusters.includes(cluster));
  expect(scoped.length, `cluster "${cluster}" matched no targets`).toBeGreaterThan(0);
  expect(
    scoped.filter((row) => row.verdict === 'fail').map(describeRow),
    `SC 2.5.8 failures in cluster "${cluster}"`,
  ).toEqual([]);
  return scoped;
}

function writeInventoryReport(): void {
  mkdirSync(BASELINE_DIR, { recursive: true });
  writeFileSync(
    REPORT_PATH,
    `${JSON.stringify(
      { capturedAt: new Date().toISOString(), minTargetPx: BASELINE_MIN_TARGET_PX, rows: inventory },
      null,
      2,
    )}\n`,
  );
}

async function invokeInPage(page: Page, channel: string, payload: unknown): Promise<void> {
  await page.evaluate(
    async ({ ipcChannel, request }) => {
      await (window as unknown as InvokeWindow).muxbase.invoke(ipcChannel, request);
    },
    { ipcChannel: channel, request: payload },
  );
}

function fleetFixture(
  project: { projectName: string; projectRoot: string },
  options: { rootedAtProject?: boolean; size?: number } = {},
): BaselinePaneFixture[] {
  const panes = buildBaselinePanes(options.size ?? FLEET_SIZE, project);
  if (!options.rootedAtProject) return panes;
  return panes.map((pane) => ({ ...pane, worktreePath: project.projectRoot }));
}

async function seedFleet(page: Page, panes: BaselinePaneFixture[]): Promise<void> {
  await seedBaselineFleet(page, panes, panes[0]?.id ?? null);
  await page.waitForTimeout(SETTLE_MS);
}

async function setUiState(page: Page, partial: Record<string, boolean>): Promise<void> {
  await page.evaluate((value) => {
    (window as unknown as BaselineStoreWindow).__muxbaseStores?.ui?.setState(value);
  }, partial);
  await page.waitForTimeout(SETTLE_MS);
}

async function setZoomFactor(app: ElectronApplication, factor: number): Promise<void> {
  await app.evaluate(({ BrowserWindow }, value) => {
    BrowserWindow.getAllWindows()[0]?.webContents.setZoomFactor(value);
  }, factor);
}

async function pushToasts(app: ElectronApplication, count: number): Promise<void> {
  await app.evaluate(({ BrowserWindow }, payload) => {
    const contents = BrowserWindow.getAllWindows()[0]?.webContents;
    for (let index = 0; index < payload.count; index += 1) {
      contents?.send(payload.channel, {
        message: `Target size probe ${index + 1}`,
        severity: 'error',
      });
    }
  }, { channel: IPC_EVENT.TOAST, count });
}

async function openableFiles(page: Page): Promise<string[]> {
  const paths = await page.$$eval(FILE_TREE_ROW, (rows) =>
    rows.map((row) => row.getAttribute('data-file-path') ?? ''),
  );
  return paths.filter((path) => OPENABLE_FILE_PATTERN.test(path)).slice(0, 2);
}

async function measureBox(page: Page, selector: string): Promise<Rect> {
  const box = await waitForStable(() => page.locator(selector).boundingBox());
  expect(box, `no bounding box for ${selector}`).not.toBeNull();
  return { height: round2(box!.height), width: round2(box!.width), x: box!.x, y: box!.y };
}

async function measureBarLayout(page: Page): Promise<BarLayout> {
  return waitForStable(() => readBarLayout(page));
}

async function readBarLayout(page: Page): Promise<BarLayout> {
  return page.evaluate((selector) => {
    const bar = document.querySelector(selector);
    const children = Array.from(bar?.children ?? []).map((child) => ({
      height: Math.round(child.getBoundingClientRect().height * 100) / 100,
      text: (child.textContent ?? '').trim().slice(0, 20),
    }));
    const tallest = children.reduce(
      (worst, child) => (child.height > worst.height ? child : worst),
      { height: 0, text: '' },
    );
    return {
      barHeight: bar ? Math.round(bar.getBoundingClientRect().height * 100) / 100 : 0,
      documentOverflow: document.documentElement.scrollWidth - window.innerWidth,
      tallestChild: tallest,
    };
  }, RESOURCE_BAR);
}

describe.runIf(process.env.MUXBASE_E2E === '1')('Target size geometry (WCAG 2.2 SC 2.5.8)', () => {
  let app: ElectronApplication;
  let page: Page;
  let project: { projectName: string; projectRoot: string };

  beforeAll(async () => {
    expect(existsSync(MAIN_ENTRY), `Build output missing: ${MAIN_ENTRY}`).toBe(true);

    app = await electron.launch({
      args: [MAIN_ENTRY],
      env: { ...process.env, MUXBASE_DEV: 'true', NODE_ENV: 'test' },
    });
    page = await getAppWindow(app);
    await disableBackgroundThrottling(app);

    await page.waitForSelector('[data-testid="app-shell"]', { timeout: 15_000 });
    await waitForAppReady(page, APP_STARTUP_TIMEOUT_MS);
    await waitForRendererPaneHydration(page, APP_STARTUP_TIMEOUT_MS);
    await page.waitForSelector(RESOURCE_BAR, { timeout: 15_000 });
    await page.setViewportSize({ height: 900, width: 1440 });

    await setUiState(page, { sidebarCollapsed: false });

    const info = await getSessionInfo(page);
    project = { projectName: info.projectName, projectRoot: info.projectRoot };
  }, APP_STARTUP_TIMEOUT_MS);

  afterAll(async () => {
    writeInventoryReport();
    if (page) {
      await setZoomFactor(app, 1).catch(() => {});
      await setUiState(page, { zenMode: false }).catch(() => {});
      await seedFleet(page, []).catch(() => {});
    }
    if (app) await app.close();
  }, APP_SHUTDOWN_TIMEOUT_MS);

  it('keeps fleet chrome conformant at 1440x900 with eight panes', async () => {
    // Arrange
    await seedFleet(page, fleetFixture(project));
    await page.waitForSelector('[data-testid="pane-cell"]', { timeout: 15_000 });

    // Act
    const rows = await audit(page, 'fleet-1440x900-8panes');

    // Assert
    for (const cluster of ['pane-header', 'pane-tabs', 'resource-bar', 'sidebar-row'] as const) {
      expectConformant(rows, cluster);
    }
    // The strip's permanent controls are 32px, so they clear SC 2.5.8 on size alone.
    const titlebar = expectConformant(rows, 'titlebar');
    expect(titlebar.map((row) => row.verdict)).toEqual(titlebar.map(() => 'pass-size'));
    const header = expectConformant(rows, 'pane-header');
    const undersizedHeader = header.filter((row) => row.verdict === 'pass-spacing');
    for (const row of undersizedHeader) {
      expect(row.nearestPx, `pane header ${row.label} spacing`).toBeGreaterThanOrEqual(row.requiredPx);
    }
  }, STEP_TIMEOUT_MS);

  it('keeps the Zen header tab cluster conformant', async () => {
    // Arrange
    await seedFleet(page, fleetFixture(project));
    await setUiState(page, { zenMode: true });
    await page.waitForSelector(CLUSTERS['zen-header'], { timeout: 15_000 });

    // Act
    const rows = await audit(page, 'zen-1440x900-8panes');

    // Assert
    const zen = expectConformant(rows, 'zen-header');
    const tabs = zen.filter((row) => row.width < BASELINE_MIN_TARGET_PX || row.height < BASELINE_MIN_TARGET_PX);
    for (const row of tabs) {
      expect(row.nearestPx, `zen ${row.label} spacing`).toBeGreaterThanOrEqual(BASELINE_MIN_TARGET_PX - EPSILON_PX);
    }

    await setUiState(page, { zenMode: false });
  }, STEP_TIMEOUT_MS);

  it('keeps the attention peek queue and toast dismissal conformant', async () => {
    // Arrange
    await seedFleet(page, fleetFixture(project));
    await page.click(ATTENTION_STAT);
    await page.waitForSelector(PEEK, { timeout: 10_000 });
    await pushToasts(app, 2);
    await page.waitForSelector(`${CLUSTERS.toast} button`, { timeout: 10_000 });

    // Act
    const rows = await audit(page, 'peek-and-toast');

    // Assert
    expectConformant(rows, 'attention-peek');
    expectConformant(rows, 'toast');

    await waitForSurfaceFocus(page, PEEK);
    await page.keyboard.press('Escape');
    await page.waitForSelector(PEEK, { state: 'detached', timeout: 10_000 });
  }, STEP_TIMEOUT_MS);

  it('keeps file tab close buttons conformant', async () => {
    // Arrange
    await seedFleet(page, fleetFixture(project, { rootedAtProject: true, size: FILE_TAB_FLEET_SIZE }));
    await page.click('[data-testid="sidebar-file-browser-toggle"]');
    await page.waitForSelector(FILE_TREE_ROW, { timeout: 15_000 });
    const files = await openableFiles(page);
    expect(files.length, 'file tree exposed no openable files').toBe(2);
    for (const file of files) {
      await page.click(`${FILE_TREE_ROW}[data-file-path="${file}"]`);
      await page.waitForSelector(`[data-testid="file-tab-close"][title="Close ${file.split('/').pop()}"]`, { timeout: 15_000 });
    }

    await page.click('[data-testid="sidebar-file-browser-toggle"]');
    await page.waitForSelector(FILE_TREE_ROW, { state: 'detached', timeout: 15_000 });

    // Act
    const rows = await audit(page, 'file-tabs');

    // Assert
    const tabs = expectConformant(rows, 'pane-tabs');
    expect(tabs.filter((row) => row.label === 'file-tab-close').length).toBe(2);
  }, STEP_TIMEOUT_MS);

  it('gives both create segments a 24px target through ResourceBar reflow', async () => {
    // Arrange
    await seedFleet(page, fleetFixture(project));
    const configurations = [
      { height: 720, width: 1280, zoom: 1 },
      { height: 900, width: 1440, zoom: 1 },
      { height: 900, width: 1440, zoom: 2 },
    ];

    for (const config of configurations) {
      // Act
      await page.setViewportSize({ height: config.height, width: config.width });
      await setZoomFactor(app, config.zoom);
      await page.waitForTimeout(SETTLE_MS);
      const primary = await measureBox(page, SPLIT_PRIMARY);
      const caret = await measureBox(page, SPLIT_CARET);
      const layout = await measureBarLayout(page);

      // Assert
      const label = `${config.width}x${config.height}@${config.zoom}x`;
      const barBudget = config.zoom === 1 ? SINGLE_LINE_BAR_MAX_PX : REFLOWED_BAR_MAX_PX;
      for (const [name, box] of [['primary', primary], ['caret', caret]] as const) {
        expect(box.width, `${name} width ${label}`).toBeGreaterThanOrEqual(BASELINE_MIN_TARGET_PX - EPSILON_PX);
        expect(box.height, `${name} height ${label}`).toBeGreaterThanOrEqual(BASELINE_MIN_TARGET_PX - EPSILON_PX);
      }
      expect(
        layout.barHeight,
        `bar height ${label} (tallest child: ${JSON.stringify(layout.tallestChild)})`,
      ).toBeLessThanOrEqual(barBudget);
      expect(layout.documentOverflow, `document overflow ${label}`).toBeLessThanOrEqual(0);
    }

    await setZoomFactor(app, 1);
    await page.setViewportSize({ height: 900, width: 1440 });
  }, STEP_TIMEOUT_MS);

  it('keeps the create menu and its trigger conformant while the menu is open', async () => {
    // Arrange
    await seedFleet(page, fleetFixture(project));
    await page.click(SPLIT_CARET);
    await page.waitForSelector(CREATE_MENU, { timeout: 10_000 });

    // Act
    const rows = await audit(page, 'split-menu-open');

    // Assert
    const bar = expectConformant(rows, 'resource-bar');
    expect(bar.filter((row) => row.label.startsWith('resource-new-')).length).toBeGreaterThanOrEqual(5);

    await waitForSurfaceFocus(page, CREATE_MENU);
    await page.keyboard.press('Escape');
    await page.waitForSelector(CREATE_MENU, { state: 'detached', timeout: 10_000 });
  }, STEP_TIMEOUT_MS);
});

// The board is feature-flagged and its cards live in a project's .muxbase data, so
// it is measured against a throwaway git project with its own Electron user data
// (NODE_ENV=test + MUXBASE_E2E=1 gives every launch a fresh userData dir, and
// project discovery falls back to cwd). Runs after the suite above so only one
// Electron instance is ever alive.
describe.runIf(process.env.MUXBASE_E2E === '1')('Kanban target size geometry (WCAG 2.2 SC 2.5.8)', () => {
  let app: ElectronApplication;
  let page: Page;
  let projectRoot: string;

  beforeAll(async () => {
    expect(existsSync(MAIN_ENTRY), `Build output missing: ${MAIN_ENTRY}`).toBe(true);

    projectRoot = realpathSync(mkdtempSync(resolve(tmpdir(), 'muxbase-target-size-kanban-')));
    writeFileSync(resolve(projectRoot, '.gitignore'), '.muxbase/\n');
    execSync('git init', { cwd: projectRoot, stdio: 'ignore' });
    execSync('git config user.email "e2e@muxbase.test"', { cwd: projectRoot, stdio: 'ignore' });
    execSync('git config user.name "muxbase-e2e"', { cwd: projectRoot, stdio: 'ignore' });
    execSync('git add .gitignore', { cwd: projectRoot, stdio: 'ignore' });
    execSync('git commit -m "chore: target size fixture"', { cwd: projectRoot, stdio: 'ignore' });

    app = await electron.launch({
      args: [MAIN_ENTRY],
      cwd: projectRoot,
      env: { ...process.env, MUXBASE_DEV: 'true', NODE_ENV: 'test' },
    });
    page = await getAppWindow(app);
    await disableBackgroundThrottling(app);

    await page.waitForSelector('[data-testid="app-shell"]', { timeout: 15_000 });
    await waitForAppReady(page, APP_STARTUP_TIMEOUT_MS);

    const info = await getSessionInfo(page);
    expect(info.projectRoot, 'the board fixture must own its project root').toBe(projectRoot);

    await invokeInPage(page, IPC.ELECTRON_SETTINGS_UPDATE, { key: 'enableKanbanBoard', value: true });
    await invokeInPage(page, IPC.KANBAN_BACKLOG_ADD, { items: [...KANBAN_BACKLOG_SEED], projectRoot });
    for (const item of KANBAN_DONE_SEED) {
      await invokeInPage(page, IPC.KANBAN_DONE_ADD, { item: { ...item }, projectRoot });
    }

    await page.reload();
    await page.waitForSelector('[data-testid="app-shell"]', { timeout: 15_000 });
    await waitForAppReady(page, APP_STARTUP_TIMEOUT_MS);
    await waitForRendererPaneHydration(page, APP_STARTUP_TIMEOUT_MS);
    await page.setViewportSize({ height: 900, width: 1440 });
    // All five columns need 1300 px; the collapsed sidebar leaves 1392, so every
    // column control is fully painted instead of clipped by the board's scroller.
    await setUiState(page, { sidebarCollapsed: true });

    await page.click(KANBAN_BOARD_BUTTON);
    await page.waitForSelector(KANBAN_BACKLOG_CARD, { timeout: 15_000 });
    await page.waitForSelector(KANBAN_DONE_CARD, { timeout: 15_000 });
  }, APP_STARTUP_TIMEOUT_MS);

  afterAll(async () => {
    writeInventoryReport();
    if (app) await app.close();
    if (projectRoot) {
      execSync(`tmux kill-session -t "muxbase-${resolve(projectRoot).split('/').pop()}" 2>/dev/null || true`, {
        stdio: 'ignore',
      });
      rmSync(projectRoot, { force: true, recursive: true });
    }
  }, APP_SHUTDOWN_TIMEOUT_MS);

  it('keeps backlog card actions and column controls conformant', async () => {
    // Act
    const rows = await audit(page, 'kanban-1440x900');

    // Assert
    const backlog = expectConformant(rows, 'kanban-backlog');
    const done = expectConformant(rows, 'kanban-done');
    for (const action of ['Launch agent', 'Edit task', 'Remove']) {
      expect(
        backlog.filter((row) => row.label === action).length,
        `backlog card action "${action}"`,
      ).toBe(KANBAN_BACKLOG_SEED.length);
    }
    expect(backlog.filter((row) => row.label === 'Launch All').length, 'Launch All control').toBe(1);
    expect(backlog.filter((row) => row.label === '+ Add Task').length, '+ Add Task control').toBe(1);
    expect(done.filter((row) => row.label === 'Clear All').length, 'Clear All control').toBe(1);
  }, STEP_TIMEOUT_MS);
});
