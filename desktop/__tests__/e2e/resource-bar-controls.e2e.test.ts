import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync } from 'fs';
import { resolve } from 'path';
import { _electron as electron } from 'playwright';
import type { ElectronApplication, Page } from 'playwright';
import { SIDEBAR_DEFAULT_WIDTH } from '../../src/shared/sidebar-metrics';
import { getAppWindow, pollUntil, waitForAppReady, waitForRendererPaneHydration } from './e2e-helpers';
import {
  buildBaselinePanes,
  disableBackgroundThrottling,
  waitForStable,
  BASELINE_MIN_TARGET_PX,
  seedBaselineFleet,
} from './ui-baseline';
import type { BaselinePaneFixture, BaselineStoreWindow } from './ui-baseline';

const ROOT = resolve(__dirname, '..', '..');
const MAIN_ENTRY = resolve(ROOT, 'out', 'main', 'index.js');
const APP_STARTUP_TIMEOUT_MS = 60_000;
const APP_SHUTDOWN_TIMEOUT_MS = 30_000;
const STEP_TIMEOUT_MS = 60_000;
const SETTLE_MS = 250;

const FLEET_SIZE = 3;
const PROJECT = { projectName: 'aumx', projectRoot: resolve(ROOT, '..') };
// One populated row measures ~40px. At 200% with the sidebar expanded the
// rigid action cluster moves below the stats; the measured result is 71px.
const SINGLE_LINE_BAR_MAX_PX = 48;
const REFLOWED_BAR_MAX_PX = 72;

const RESOURCE_BAR = '[data-testid="resource-bar"]';
const STATS_GROUP = '[data-testid="resource-bar-stats"]';
const ATTENTION_STAT = '[data-testid="resource-attention-stat"]';
const COMMAND_PALETTE = '[data-testid="resource-command-palette"]';
const ZEN_ATTENTION = '[data-testid="zen-attention-stat"]';
const ZEN_NEW_PANE = '[data-testid="zen-new-pane"]';
const ZEN_EXIT = '[data-testid="zen-exit-chip"]';
// Sub-pixel slack: a control that sits exactly on the bar's content edge is reachable.
const EDGE_TOLERANCE_PX = 1;
const REACHABLE_CONTROLS = ['attention stat', 'command palette', 'zen toggle', 'create pane', 'create menu'];

interface Box {
  height: number;
  width: number;
  x: number;
  y: number;
}

interface TargetGeometry {
  height: number;
  nearestNeighborPx: number;
  width: number;
}

interface ControlReach {
  height: number;
  name: string;
  overflowLeft: number;
  overflowRight: number;
  width: number;
}

interface BarLayout {
  barHeight: number;
  barOverflow: number;
  documentOverflow: number;
  innerWidth: number;
  statsClipped: boolean;
  statClipped: boolean;
}

function expectControlsReachable(controls: ControlReach[], label: string): void {
  expect(controls.map((control) => control.name), `controls present ${label}`).toEqual(REACHABLE_CONTROLS);
  for (const control of controls) {
    expect(control.overflowRight, `${control.name} past right edge ${label}`).toBeLessThanOrEqual(EDGE_TOLERANCE_PX);
    expect(control.overflowLeft, `${control.name} past left edge ${label}`).toBeLessThanOrEqual(EDGE_TOLERANCE_PX);
    expect(control.width, `${control.name} width ${label}`).toBeGreaterThan(0);
    expect(control.height, `${control.name} height ${label}`).toBeGreaterThan(0);
  }
}

function buildWaitingFleet(waitingCount: number): BaselinePaneFixture[] {
  return buildBaselinePanes(FLEET_SIZE, PROJECT).map((pane, index) => ({
    ...pane,
    agentStatus: index < waitingCount ? ('waiting' as const) : ('idle' as const),
  }));
}

function round(box: Box): Box {
  const to2 = (value: number): number => Math.round(value * 100) / 100;
  return { height: to2(box.height), width: to2(box.width), x: to2(box.x), y: to2(box.y) };
}

async function setWaitingCount(
  page: Page,
  waitingCount: number,
  selector: string = ATTENTION_STAT,
): Promise<void> {
  await seedBaselineFleet(page, buildWaitingFleet(waitingCount));

  const expectedNodes = waitingCount === 0 ? 0 : 1;
  await pollUntil(
    async () => ((await page.locator(selector).count()) === expectedNodes ? true : null),
    { interval: 100, label: `${selector}(${waitingCount})`, timeout: 10_000 },
  );
  await page.waitForTimeout(SETTLE_MS);
}

async function setZenMode(page: Page, zenMode: boolean): Promise<void> {
  await page.evaluate((value) => {
    (window as unknown as BaselineStoreWindow).__aumxStores?.ui?.setState({ zenMode: value });
  }, zenMode);
  await page.waitForTimeout(SETTLE_MS);
}

// Every geometry read below settles first: the attention numeral and the modal
// surfaces animate in, so a single sample can land mid-transition.
async function measureStatSpans(page: Page): Promise<Box[]> {
  return waitForStable(() => readStatSpans(page));
}

async function readStatSpans(page: Page): Promise<Box[]> {
  const boxes = await page.evaluate((selector) => {
    const group = document.querySelector(selector);
    if (!group) return [];
    const spans = Array.from(group.children).filter((el) => el.tagName === 'SPAN');
    return [0, 2, 4].map((index) => {
      const rect = spans[index].getBoundingClientRect();
      return { height: rect.height, width: rect.width, x: rect.x, y: rect.y };
    });
  }, STATS_GROUP);
  return boxes.map(round);
}

async function measureStatText(page: Page): Promise<string[]> {
  return waitForStable(() => readStatText(page));
}

async function readStatText(page: Page): Promise<string[]> {
  return page.evaluate((selector) => {
    const group = document.querySelector(selector);
    if (!group) return [];
    const spans = Array.from(group.children).filter((el) => el.tagName === 'SPAN');
    return [0, 2, 4].map((index) => spans[index].textContent ?? '');
  }, STATS_GROUP);
}

async function measureControls(page: Page): Promise<Record<string, Box | null>> {
  return waitForStable(() => readControls(page));
}

async function readControls(page: Page): Promise<Record<string, Box | null>> {
  const boxes = await page.evaluate((selector) => {
    const bar = document.querySelector(selector);
    if (!bar) return {};
    const toBox = (element: Element | null | undefined): Box | null => {
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      return { height: rect.height, width: rect.width, x: rect.x, y: rect.y };
    };
    const byText = (text: string): Element | undefined =>
      Array.from(bar.querySelectorAll('button')).find((btn) => btn.textContent?.trim() === text);

    return {
      commandPalette: toBox(bar.querySelector('[data-testid="resource-command-palette"]')),
      fleet: toBox(byText('Fleet')),
      focus: toBox(byText('Focus')),
      newPane: toBox(bar.querySelector('[data-testid="resource-new-pane"]')),
      zen: toBox(bar.querySelector('[data-testid="resource-zen-toggle"]')),
    };
  }, RESOURCE_BAR);

  return Object.fromEntries(
    Object.entries(boxes).map(([key, value]) => [key, value ? round(value) : null]),
  );
}

async function measureControlReach(page: Page): Promise<ControlReach[]> {
  return waitForStable(() => readControlReach(page));
}

async function readControlReach(page: Page): Promise<ControlReach[]> {
  return page.evaluate((barSelector) => {
    const bar = document.querySelector(barSelector) as HTMLElement | null;
    if (!bar) return [];
    const to2 = (value: number): number => Math.round(value * 100) / 100;
    const style = getComputedStyle(bar);
    const barRect = bar.getBoundingClientRect();
    const contentLeft = barRect.left + parseFloat(style.paddingLeft);
    const contentRight = barRect.right - parseFloat(style.paddingRight);
    const targets: Array<[string, string]> = [
      ['attention stat', '[data-testid="resource-attention-stat"]'],
      ['command palette', '[data-testid="resource-command-palette"]'],
      ['zen toggle', '[data-testid="resource-zen-toggle"]'],
      ['create pane', '[data-testid="resource-new-pane"]'],
      ['create menu', '[data-testid="resource-new-menu"]'],
    ];
    return targets.flatMap(([name, selector]) => {
      const element = bar.querySelector(selector);
      if (!element) return [];
      const rect = element.getBoundingClientRect();
      return [{
        height: to2(rect.height),
        name,
        overflowLeft: to2(contentLeft - rect.left),
        overflowRight: to2(rect.right - contentRight),
        width: to2(rect.width),
      }];
    });
  }, RESOURCE_BAR);
}

async function measureTarget(page: Page, selector: string): Promise<TargetGeometry | null> {
  return waitForStable(() => readTarget(page, selector));
}

async function readTarget(page: Page, selector: string): Promise<TargetGeometry | null> {
  return page.evaluate(([target, barSelector]) => {
    const element = document.querySelector(target);
    const bar = document.querySelector(barSelector);
    if (!element || !bar) return null;
    const centerOf = (node: Element): { x: number; y: number } => {
      const rect = node.getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    };
    const self = centerOf(element);
    const neighbors = Array.from(bar.querySelectorAll('a[href], button, [role="button"]'))
      .filter((node) => node !== element && node.getBoundingClientRect().width > 0)
      .map((node) => {
        const other = centerOf(node);
        return Math.hypot(other.x - self.x, other.y - self.y);
      });
    const rect = element.getBoundingClientRect();
    return {
      height: Math.round(rect.height * 100) / 100,
      nearestNeighborPx: Math.round(Math.min(...neighbors) * 100) / 100,
      width: Math.round(rect.width * 100) / 100,
    };
  }, [selector, RESOURCE_BAR]);
}

async function measureBarLayout(page: Page): Promise<BarLayout> {
  return waitForStable(() => readBarLayout(page));
}

async function readBarLayout(page: Page): Promise<BarLayout> {
  return page.evaluate(([barSelector, statsSelector, statSelector]) => {
    const bar = document.querySelector(barSelector) as HTMLElement | null;
    const stats = document.querySelector(statsSelector) as HTMLElement | null;
    const stat = document.querySelector(statSelector) as HTMLElement | null;
    return {
      barHeight: bar ? Math.round(bar.getBoundingClientRect().height * 100) / 100 : 0,
      barOverflow: bar ? bar.scrollWidth - bar.clientWidth : 0,
      documentOverflow: document.documentElement.scrollWidth - window.innerWidth,
      innerWidth: window.innerWidth,
      statsClipped: stats !== null && stats.scrollWidth > stats.clientWidth + 1,
      statClipped: stat !== null && stat.scrollWidth > stat.clientWidth + 1,
    };
  }, [RESOURCE_BAR, STATS_GROUP, ATTENTION_STAT]);
}

async function measureBox(page: Page, selector: string): Promise<Box | null> {
  return waitForStable(() => page.locator(selector).boundingBox());
}

// A collapsed sidebar is 0px wide, which Playwright reports as invisible, so the
// width is read straight off the layout box instead of through boundingBox().
async function measureSidebarWidth(page: Page): Promise<number> {
  return page.evaluate(() => {
    const sidebar = document.querySelector('aside');
    return sidebar ? Math.round(sidebar.getBoundingClientRect().width) : 0;
  });
}

async function setSidebarCollapsed(page: Page, collapsed: boolean): Promise<void> {
  await page.evaluate((value) => {
    (window as unknown as BaselineStoreWindow).__aumxStores?.ui?.setState({ sidebarCollapsed: value });
  }, collapsed);
  await page.waitForTimeout(SETTLE_MS);
}

async function setZoomFactor(app: ElectronApplication, factor: number): Promise<void> {
  await app.evaluate(({ BrowserWindow }, value) => {
    const win = BrowserWindow.getAllWindows()[0];
    win?.webContents.setZoomFactor(value);
  }, factor);
}

describe.runIf(process.env.AUMX_E2E === '1')('ResourceBar attention + command controls', () => {
  let app: ElectronApplication;
  let page: Page;
  let originalViewport: { height: number; width: number };

  beforeAll(async () => {
    expect(existsSync(MAIN_ENTRY), `Build output missing: ${MAIN_ENTRY}`).toBe(true);

    app = await electron.launch({
      args: [MAIN_ENTRY],
      env: { ...process.env, AUMX_DEV: 'true', NODE_ENV: 'test' },
    });
    page = await getAppWindow(app);
    await disableBackgroundThrottling(app);

    await page.waitForSelector('[data-testid="app-shell"]', { timeout: 15_000 });
    await waitForAppReady(page, APP_STARTUP_TIMEOUT_MS);
    await waitForRendererPaneHydration(page, APP_STARTUP_TIMEOUT_MS);
    await page.waitForSelector(RESOURCE_BAR, { timeout: 15_000 });

    originalViewport = page.viewportSize() ?? { height: 900, width: 1440 };
  }, APP_STARTUP_TIMEOUT_MS);

  afterAll(async () => {
    if (page) {
      await setZoomFactor(app, 1).catch(() => {});
      await setSidebarCollapsed(page, true).catch(() => {});
      await setZenMode(page, false).catch(() => {});
      await setWaitingCount(page, 0).catch(() => {});
      await page.setViewportSize(originalViewport).catch(() => {});
    }
    if (app) await app.close();
  }, APP_SHUTDOWN_TIMEOUT_MS);

  it('keeps every sibling stat and right-hand control pinned as the attention term appears', async () => {
    // Arrange
    await page.setViewportSize({ height: 900, width: 1440 });
    await setWaitingCount(page, 0);
    const baselineStats = await measureStatSpans(page);
    const baselineControls = await measureControls(page);
    const baselineLayout = await measureBarLayout(page);
    expect(await measureStatText(page)).toEqual(['3 panes', '3 worktrees', '0 active']);

    // Act + Assert
    for (const waitingCount of [1, 2, 0]) {
      await setWaitingCount(page, waitingCount);
      if (waitingCount > 0) {
        expect(await page.locator(ATTENTION_STAT).textContent()).toBe(`${waitingCount} waiting`);
      }
      expect(await measureStatSpans(page), `stats @${waitingCount}`).toEqual(baselineStats);
      expect(await measureStatText(page), `stat text @${waitingCount}`).toEqual([
        '3 panes',
        '3 worktrees',
        '0 active',
      ]);
      expect(await measureControls(page), `controls @${waitingCount}`).toEqual(baselineControls);
      expect((await measureBarLayout(page)).barHeight, `bar height @${waitingCount}`).toBe(
        baselineLayout.barHeight,
      );
    }
  }, STEP_TIMEOUT_MS);

  it('gives the attention stat and the ⌘K door a conformant pointer target', async () => {
    // Arrange
    await setWaitingCount(page, 2);

    // Act
    const stat = await measureTarget(page, ATTENTION_STAT);
    const palette = await measureTarget(page, COMMAND_PALETTE);

    // Assert
    for (const [name, target] of [['attention stat', stat], ['⌘K', palette]] as const) {
      expect(target, name).not.toBeNull();
      const meetsSize =
        (target?.width ?? 0) >= BASELINE_MIN_TARGET_PX && (target?.height ?? 0) >= BASELINE_MIN_TARGET_PX;
      const meetsSpacing = (target?.nearestNeighborPx ?? 0) >= BASELINE_MIN_TARGET_PX;
      expect(
        meetsSize || meetsSpacing,
        `${name} geometry ${JSON.stringify(target)} fails both the 24px size rule and the 24px spacing exception`,
      ).toBe(true);
    }
  }, STEP_TIMEOUT_MS);

  it('preserves every label without horizontal overflow across viewports and 200% zoom', async () => {
    // Arrange
    const configurations = [
      { height: 720, width: 1280, zoom: 1 },
      { height: 900, width: 1440, zoom: 1 },
      { height: 900, width: 1440, zoom: 2 },
    ];

    for (const config of configurations) {
      // Act
      await page.setViewportSize({ height: config.height, width: config.width });
      await setZoomFactor(app, config.zoom);
      await setWaitingCount(page, 0);
      const quiet = await measureBarLayout(page);
      await setWaitingCount(page, 2);
      const busy = await measureBarLayout(page);

      // Assert
      const label = `${config.width}x${config.height}@${config.zoom}x`;
      expect(busy.barHeight, `bar height ${label}`).toBe(quiet.barHeight);
      const heightBudget = config.zoom === 1 ? SINGLE_LINE_BAR_MAX_PX : REFLOWED_BAR_MAX_PX;
      expect(busy.barHeight, `bar height ${label}`).toBeLessThanOrEqual(heightBudget);
      expect(busy.barOverflow, `bar overflow ${label}`).toBeLessThanOrEqual(0);
      expect(busy.documentOverflow, `document overflow ${label}`).toBeLessThanOrEqual(0);
      expect(quiet.documentOverflow, `document overflow without attention ${label}`).toBeLessThanOrEqual(0);
      expect(busy.statsClipped, `informational stats clipped ${label}`).toBe(false);
      expect(busy.statClipped, `attention stat clipped ${label}`).toBe(false);
    }

    await setZoomFactor(app, 1);
  }, STEP_TIMEOUT_MS);

  it('keeps every control reachable at 200% zoom through the minimum window width', async () => {
    // Arrange
    await page.setViewportSize({ height: 900, width: 1440 });
    await setZoomFactor(app, 1);
    await setSidebarCollapsed(page, true);
    await setWaitingCount(page, 2);
    const baselineStats = await measureStatSpans(page);
    const baselineControls = await measureControls(page);
    const baselineText = await measureStatText(page);

    const configurations = [
      { collapsed: true, expectedSidebarWidth: 0, heightBudget: SINGLE_LINE_BAR_MAX_PX, width: 1440 },
      { collapsed: false, expectedSidebarWidth: SIDEBAR_DEFAULT_WIDTH, heightBudget: REFLOWED_BAR_MAX_PX, width: 1440 },
      { collapsed: false, expectedSidebarWidth: 0, heightBudget: REFLOWED_BAR_MAX_PX, width: 800 },
    ];

    for (const config of configurations) {
      // Act
      await page.setViewportSize({ height: 900, width: config.width });
      await setSidebarCollapsed(page, config.collapsed);
      await setZoomFactor(app, 2);
      await page.waitForTimeout(SETTLE_MS);
      const controls = await measureControlReach(page);
      const layout = await measureBarLayout(page);
      const sidebarWidth = await measureSidebarWidth(page);

      // Assert
      const label = `${config.width}px, sidebar ${config.collapsed ? 'collapsed' : 'expanded'} @200%`;
      expectControlsReachable(controls, label);
      expect(sidebarWidth, `sidebar width ${label}`).toBe(config.expectedSidebarWidth);
      expect(layout.barHeight, `bar height ${label}`).toBeLessThanOrEqual(config.heightBudget);
      expect(layout.barOverflow, `bar overflow ${label}`).toBeLessThanOrEqual(0);
      expect(layout.documentOverflow, `document overflow ${label}`).toBeLessThanOrEqual(0);
      expect(layout.statsClipped, `informational stats clipped ${label}`).toBe(false);
      expect(layout.statClipped, `attention stat clipped ${label}`).toBe(false);
      await setZoomFactor(app, 1);
    }

    // Assert — the narrow-width behaviour leaves the normal layout untouched
    await page.setViewportSize({ height: 900, width: 1440 });
    await setSidebarCollapsed(page, true);
    expect(await measureStatSpans(page), 'stats @100%').toEqual(baselineStats);
    expect(await measureStatText(page), 'stat text @100%').toEqual(baselineText);
    expect(await measureControls(page), 'controls @100%').toEqual(baselineControls);
  }, STEP_TIMEOUT_MS);

  it('extends the Zen chip leftward without moving New Pane or Exit Zen', async () => {
    // Arrange
    await page.setViewportSize({ height: 900, width: 1440 });
    await setWaitingCount(page, 0);
    await setZenMode(page, true);
    await setWaitingCount(page, 0, ZEN_ATTENTION);
    const quietNewPane = await measureBox(page, ZEN_NEW_PANE);
    const quietExit = await measureBox(page, ZEN_EXIT);
    expect(await page.locator(ZEN_ATTENTION).count()).toBe(0);

    // Act
    await setWaitingCount(page, 2, ZEN_ATTENTION);
    const numeral = await measureBox(page, ZEN_ATTENTION);

    // Assert
    expect(await page.locator(ZEN_ATTENTION).textContent()).toBe('2');
    expect(await page.locator(ZEN_ATTENTION).getAttribute('aria-label')).toBe(
      '2 agents waiting for input. Jump to next.',
    );
    expect(numeral?.width ?? 0).toBeGreaterThanOrEqual(BASELINE_MIN_TARGET_PX);
    expect(numeral?.height ?? 0).toBeGreaterThanOrEqual(BASELINE_MIN_TARGET_PX);
    expect(numeral!.x).toBeLessThan(quietNewPane!.x);
    expect(await measureBox(page, ZEN_NEW_PANE)).toEqual(quietNewPane);
    expect(await measureBox(page, ZEN_EXIT)).toEqual(quietExit);

    await setZenMode(page, false);
  }, STEP_TIMEOUT_MS);
});
