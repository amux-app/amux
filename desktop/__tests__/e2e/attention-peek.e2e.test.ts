import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { existsSync } from 'fs';
import { resolve } from 'path';
import { _electron as electron } from 'playwright';
import type { ElectronApplication, Page } from 'playwright';
import {
  closeElectronApp,
  getAppWindow,
  pollUntil,
  waitForAppReady,
  waitForRendererPaneHydration,
} from './e2e-helpers';
import {
  buildBaselinePanes,
  disableBackgroundThrottling,
  waitForSurfaceFocus,
  waitForValue,
  seedBaselineFleet,
} from './ui-baseline';
import type { BaselinePaneFixture, BaselineStoreWindow } from './ui-baseline';

const ROOT = resolve(__dirname, '..', '..');
const MAIN_ENTRY = resolve(ROOT, 'out', 'main', 'index.js');
const APP_STARTUP_TIMEOUT_MS = 60_000;
const APP_SHUTDOWN_TIMEOUT_MS = 30_000;
const STEP_TIMEOUT_MS = 60_000;
const SETTLE_MS = 250;

const WAITING_FLEET_SIZE = 4;
const PROJECT = { projectName: 'muxbase', projectRoot: resolve(ROOT, '..') };

const ATTENTION_STAT_TEST_ID = 'resource-attention-stat';
const ATTENTION_STAT = `[data-testid="${ATTENTION_STAT_TEST_ID}"]`;
const COMMAND_PALETTE = '[role="dialog"][aria-label="Command palette"]';
const PEEK = '[role="menu"][aria-label="Waiting agents"]';
const PEEK_MORE = '[data-testid="attention-peek-more"]';
const PEEK_ROW = '[data-testid="attention-peek-row"]';
const RESOURCE_BAR = '[data-testid="resource-bar"]';

function waitingFleet(): BaselinePaneFixture[] {
  return buildBaselinePanes(WAITING_FLEET_SIZE, PROJECT).map((pane) => ({
    ...pane,
    agentStatus: 'waiting' as const,
  }));
}

async function seedFleet(page: Page, panes: BaselinePaneFixture[]): Promise<void> {
  await seedBaselineFleet(page, panes);
  await pollUntil(
    async () => ((await page.locator(ATTENTION_STAT).count()) === (panes.length > 0 ? 1 : 0) ? true : null),
    { interval: 100, label: `attention-stat(${panes.length})`, timeout: 10_000 },
  );
  await page.waitForTimeout(SETTLE_MS);
}

async function selectedPaneId(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const state = (window as unknown as BaselineStoreWindow).__muxbaseStores?.pane?.getState() as
      | { selectedPaneId?: string | null }
      | undefined;
    return state?.selectedPaneId ?? null;
  });
}

async function activeTestId(page: Page): Promise<string | null> {
  return page.evaluate(() => document.activeElement?.getAttribute('data-testid') ?? null);
}

async function openPeek(page: Page): Promise<void> {
  await page.click(ATTENTION_STAT);
  await page.waitForSelector(PEEK, { timeout: 10_000 });
  await waitForSurfaceFocus(page, PEEK);
}

async function closePeek(page: Page): Promise<void> {
  if ((await page.locator(PEEK).count()) === 0) return;
  await page.keyboard.press('Escape');
  await page.waitForSelector(PEEK, { state: 'detached', timeout: 10_000 });
}

describe.runIf(process.env.MUXBASE_E2E === '1')('Attention peek queue', () => {
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
    await page.waitForSelector(RESOURCE_BAR, { timeout: 15_000 });
    await page.setViewportSize({ height: 900, width: 1440 });
  }, APP_STARTUP_TIMEOUT_MS);

  afterAll(async () => {
    if (page) {
      await closePeek(page).catch(() => {});
      await seedFleet(page, []).catch(() => {});
    }
    if (app) await closeElectronApp(app);
  }, APP_SHUTDOWN_TIMEOUT_MS);

  afterEach(async () => {
    await closePeek(page);
  });

  it('opens a three-row queue that ends in the overflow door', async () => {
    // Arrange
    const fleet = waitingFleet();
    await seedFleet(page, fleet);

    // Act
    await openPeek(page);

    // Assert
    expect(await page.locator(PEEK_ROW).count()).toBe(2);
    expect(await page.locator(PEEK_ROW).nth(0).textContent()).toContain(fleet[0].title);
    expect(await page.locator(PEEK_ROW).nth(1).textContent()).toContain(fleet[1].title);
    expect(await page.locator(PEEK_ROW).nth(0).textContent()).toContain('Waiting · asked a question');
    expect(await page.locator(PEEK_MORE).textContent()).toBe('+2 more');

    await closePeek(page);
  }, STEP_TIMEOUT_MS);

  it('selects the pane behind a clicked row', async () => {
    // Arrange
    const fleet = waitingFleet();
    await seedFleet(page, fleet);
    await openPeek(page);

    // Act
    await page.locator(PEEK_ROW).nth(1).click();
    await page.waitForSelector(PEEK, { state: 'detached', timeout: 10_000 });

    // Assert
    const selected = await waitForValue(() => selectedPaneId(page), (id) => id === fleet[1].id);
    expect(selected).toBe(fleet[1].id);
  }, STEP_TIMEOUT_MS);

  it('hands the rest of the queue to the command palette on the panes tab', async () => {
    // Arrange
    await seedFleet(page, waitingFleet());
    await openPeek(page);

    // Act
    await page.click(PEEK_MORE);
    await page.waitForSelector(COMMAND_PALETTE, { timeout: 10_000 });

    // Assert
    expect(await page.locator(`${COMMAND_PALETTE} input`).getAttribute('placeholder')).toBe('Search panes...');
    expect(await page.locator(PEEK).count()).toBe(0);

    await page.keyboard.press('Escape');
    await page.waitForSelector(COMMAND_PALETTE, { state: 'detached', timeout: 10_000 });
  }, STEP_TIMEOUT_MS);

  it('returns focus to the stat on Escape and leaves no residual node', async () => {
    // Arrange
    await seedFleet(page, waitingFleet());
    await openPeek(page);

    // Act
    await page.keyboard.press('Escape');
    await page.waitForSelector(PEEK, { state: 'detached', timeout: 10_000 });

    // Assert
    const focused = await waitForValue(() => activeTestId(page), (id) => id === ATTENTION_STAT_TEST_ID);
    expect(focused).toBe(ATTENTION_STAT_TEST_ID);
    expect(await page.locator(PEEK_ROW).count()).toBe(0);
    expect(await page.locator(PEEK_MORE).count()).toBe(0);
    expect(await page.locator('[role="menuitem"]').count()).toBe(0);
  }, STEP_TIMEOUT_MS);

  it('walks the queue with the arrow keys and selects with Enter', async () => {
    // Arrange
    const fleet = waitingFleet();
    await seedFleet(page, fleet);
    await openPeek(page);

    // Act
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await page.waitForSelector(PEEK, { state: 'detached', timeout: 10_000 });

    // Assert
    const selected = await waitForValue(() => selectedPaneId(page), (id) => id === fleet[1].id);
    expect(selected).toBe(fleet[1].id);
  }, STEP_TIMEOUT_MS);
});
