import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync } from 'fs';
import { resolve } from 'path';
import { _electron as electron } from 'playwright';
import type { ElectronApplication, Page } from 'playwright';
import {
  SIDEBAR_LIVE_WIDTH_VAR,
  SIDEBAR_PANEL_ID,
  SIDEBAR_SEPARATOR_ID,
} from '../../src/renderer/components/layout/sidebarLayout';
import {
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
} from '../../src/shared/sidebar-metrics';
import { closeElectronApp, getAppWindow, waitForAppReady, waitForRendererPaneHydration } from './e2e-helpers';
import { disableBackgroundThrottling, waitForStable } from './ui-baseline';

interface SidebarStoreWindow {
  __muxbaseStores?: {
    ui?: { getState: () => { sidebarCollapsed?: boolean; sidebarWidth?: number } };
  };
}

const ROOT = resolve(__dirname, '..', '..');
const MAIN_ENTRY = resolve(ROOT, 'out', 'main', 'index.js');
const APP_STARTUP_TIMEOUT_MS = 60_000;
const APP_SHUTDOWN_TIMEOUT_MS = 30_000;
const STEP_TIMEOUT_MS = 60_000;

const SIDEBAR_PANEL = `#${SIDEBAR_PANEL_ID}`;
const SIDEBAR_SEPARATOR = `#${SIDEBAR_SEPARATOR_ID}`;
const SIDEBAR_TOGGLE = '[data-testid="titlebar-sidebar-toggle"]';
const VIEWPORT = { height: 900, width: 1440 };
// Enough moves that a snapping resolver would visibly quantise the column.
const DRAG_STEPS = 24;
// The column is committed through a rounded pixel width, so it can land a pixel off.
const WIDTH_TOLERANCE_PX = 2;
// Inside the library's inflated hit target (resizeTargetMinimumSize.fine = 14) but
// outside the separator element itself (5px wide), so the press still lands beside it.
const INFLATED_HIT_TARGET_OFFSET_PX = 3;

async function measureSidebarWidth(page: Page): Promise<number> {
  return waitForStable(() => page.evaluate(
    (selector) => document.querySelector(selector)?.getBoundingClientRect().width ?? 0,
    SIDEBAR_PANEL,
  ));
}

async function readSidebarCollapsed(page: Page): Promise<boolean> {
  return page.evaluate(() => Boolean(
    (window as unknown as SidebarStoreWindow).__muxbaseStores?.ui?.getState().sidebarCollapsed,
  ));
}

async function readSidebarLiveWidthVar(page: Page): Promise<number> {
  return waitForStable(() => page.evaluate(
    (varName) => {
      const shell = document.querySelector('[data-testid="app-shell"]');
      if (!shell) return NaN;
      const value = getComputedStyle(shell).getPropertyValue(varName);
      return parseFloat(value);
    },
    SIDEBAR_LIVE_WIDTH_VAR,
  ));
}

async function readSidebarWidthFromStore(page: Page): Promise<number> {
  return waitForStable(() => page.evaluate(() => (
    (window as unknown as SidebarStoreWindow).__muxbaseStores?.ui?.getState().sidebarWidth ?? NaN
  )));
}

function expectWidthNear(actual: number, expected: number, label: string): void {
  expect(Math.abs(actual - expected), `${label}: expected ~${expected}px, measured ${actual}px`)
    .toBeLessThanOrEqual(WIDTH_TOLERANCE_PX);
}

/**
 * Drags the separator by a pointer delta and releases there. The library resolves a
 * drag against the layout captured at pointer-down, so the released column width is
 * the width at pointer-down plus the delta, clamped to the panel's own bounds.
 */
async function dragSeparatorBy(page: Page, deltaX: number): Promise<void> {
  const handle = await page.locator(SIDEBAR_SEPARATOR).boundingBox();
  if (!handle) throw new Error('sidebar separator is not on screen');
  const originX = handle.x + handle.width / 2;
  const originY = handle.y + handle.height / 2;

  await page.mouse.move(originX, originY);
  await page.mouse.down();
  await page.mouse.move(originX + deltaX, originY, { steps: DRAG_STEPS });
  await page.mouse.up();
}

/**
 * Presses just outside the separator element's own bounds, inside the library's
 * inflated document-level hit target, and drags from there. This is the grab that
 * skips the separator's own `onPointerDown`.
 */
async function dragBesideSeparatorBy(page: Page, deltaX: number): Promise<void> {
  const handle = await page.locator(SIDEBAR_SEPARATOR).boundingBox();
  if (!handle) throw new Error('sidebar separator is not on screen');
  const originX = handle.x + handle.width + INFLATED_HIT_TARGET_OFFSET_PX;
  const originY = handle.y + handle.height / 2;

  await page.mouse.move(originX, originY);
  await page.mouse.down();
  await page.mouse.move(originX + deltaX, originY, { steps: DRAG_STEPS });
  await page.mouse.up();
}

describe.runIf(process.env.MUXBASE_E2E === '1')('Sidebar drag resize', () => {
  let app: ElectronApplication;
  let page: Page;

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
    await page.setViewportSize(VIEWPORT);
  }, APP_STARTUP_TIMEOUT_MS);

  afterAll(async () => {
    if (app) await closeElectronApp(app);
  }, APP_SHUTDOWN_TIMEOUT_MS);

  it('opens at the text-fit default width', async () => {
    // Arrange & Act
    const width = await measureSidebarWidth(page);

    // Assert
    expectWidthNear(width, SIDEBAR_DEFAULT_WIDTH, 'default column');
    expect(await readSidebarCollapsed(page)).toBe(false);
  }, STEP_TIMEOUT_MS);

  it('keeps the column where the pointer was released, at any point in the range', async () => {
    // Arrange
    const deltas = [-40, 120, -75];
    let expected = await measureSidebarWidth(page);

    for (const delta of deltas) {
      // Act
      await dragSeparatorBy(page, delta);
      expected += delta;

      // Assert — a resolver that snapped would land on a bound, not on the pointer
      expectWidthNear(await measureSidebarWidth(page), expected, `release after ${delta}px`);
    }
  }, STEP_TIMEOUT_MS);

  it('commits a drag that grabs the inflated hit target beside the separator', async () => {
    // Arrange
    const widthBefore = await measureSidebarWidth(page);

    // Act — grab just outside the separator element, inside its inflated hit target
    await dragBesideSeparatorBy(page, 60);

    // Assert — the panel itself resized
    const widthAfter = await measureSidebarWidth(page);
    expectWidthNear(widthAfter, widthBefore + 60, 'panel width after beside-grab drag');

    // Assert — the live CSS var tracked the drag instead of staying stuck pre-drag
    expectWidthNear(await readSidebarLiveWidthVar(page), widthAfter, 'live width var after beside-grab drag');

    // Assert — the drag was committed to the store instead of being dropped on release
    expectWidthNear(await readSidebarWidthFromStore(page), widthAfter, 'store width after beside-grab drag');
  }, STEP_TIMEOUT_MS);

  it('clamps at its bounds instead of collapsing when the pointer runs off either edge', async () => {
    // Arrange & Act — far past the left window edge
    await dragSeparatorBy(page, -800);

    // Assert — the column floors at its minimum and stays expanded
    expectWidthNear(await measureSidebarWidth(page), SIDEBAR_MIN_WIDTH, 'floor');
    expect(await readSidebarCollapsed(page)).toBe(false);

    // Act — far past the opposite bound
    await dragSeparatorBy(page, 800);

    // Assert
    expectWidthNear(await measureSidebarWidth(page), SIDEBAR_MAX_WIDTH, 'ceiling');
    expect(await readSidebarCollapsed(page)).toBe(false);
  }, STEP_TIMEOUT_MS);

  it('still hides and restores the whole column from the titlebar toggle', async () => {
    // Arrange
    const expanded = await measureSidebarWidth(page);

    // Act
    await page.locator(SIDEBAR_TOGGLE).click();

    // Assert
    expect(await measureSidebarWidth(page)).toBe(0);
    expect(await readSidebarCollapsed(page)).toBe(true);

    // Act
    await page.locator(SIDEBAR_TOGGLE).click();

    // Assert — expanding restores the width the drag committed
    expectWidthNear(await measureSidebarWidth(page), expanded, 'restored column');
    expect(await readSidebarCollapsed(page)).toBe(false);
  }, STEP_TIMEOUT_MS);
});
