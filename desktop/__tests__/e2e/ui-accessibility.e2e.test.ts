import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
  waitForStable,
  waitForSurfaceFocus,
  waitForValue,
  seedBaselineFleet,
} from './ui-baseline';
import type { BaselinePaneFixture } from './ui-baseline';

const ROOT = resolve(__dirname, '..', '..');
const MAIN_ENTRY = resolve(ROOT, 'out', 'main', 'index.js');
const APP_STARTUP_TIMEOUT_MS = 60_000;
const APP_SHUTDOWN_TIMEOUT_MS = 30_000;
const STEP_TIMEOUT_MS = 90_000;
const SETTLE_MS = 250;
const OVERLAY_CLOSE_TIMEOUT_MS = 5_000;
const TAB_WALK_LIMIT = 80;

const FLEET_SIZE = 4;
const PROJECT = { projectName: 'muxbase', projectRoot: resolve(ROOT, '..') };

const APP_SHELL_TEST_ID = 'app-shell';
const ATTENTION_STAT_TEST_ID = 'resource-attention-stat';
const PEEK_ROW_TEST_ID = 'attention-peek-row';

const APP_SHELL = `[data-testid="${APP_SHELL_TEST_ID}"]`;
const ATTENTION_STAT = `[data-testid="${ATTENTION_STAT_TEST_ID}"]`;
const ATTENTION_NUMERALS = `${ATTENTION_STAT}, [data-testid="zen-attention-stat"]`;
const COMMAND_PALETTE = '[role="dialog"][aria-label="Command palette"]';
const FLEET_SEPARATOR = '[data-fleet-pane-separator], [data-fleet-row-separator]';
const HELP_OVERLAY = '[role="dialog"][aria-modal="true"][aria-labelledby]';
const OPEN_OVERLAYS = '[role="dialog"], [role="menu"]';
const PALETTE_SELECTED_ITEM = `${COMMAND_PALETTE} [cmdk-item][data-selected="true"]`;
const PANE_ACTIONS_MENU = '[role="menu"][aria-label="Pane actions"]';
const PANE_CELL = '[data-testid="pane-cell"]';
const PEEK = '[role="menu"][aria-label="Waiting agents"]';
const PEEK_ROW = `[data-testid="${PEEK_ROW_TEST_ID}"]`;
const RESOURCE_BAR = '[data-testid="resource-bar"]';
const TERMINAL_INPUT = 'textarea.xterm-helper-textarea';
const RESOURCE_BAR_STATS = '[data-testid="resource-bar-stats"]';
const ZEN_ATTENTION = '[data-testid="zen-attention-stat"]';
const ZEN_EXIT = '[data-testid="zen-exit-chip"]';
const ZEN_NEW_PANE = '[data-testid="zen-new-pane"]';

const NODE_TAG_ATTRIBUTE = 'data-a11y-node';

interface StoreApi<TState> {
  getState: () => TState;
  setState: (partial: Record<string, unknown>) => void;
}

interface PaneStoreState {
  panes: Array<Record<string, unknown>>;
  selectedPaneId: string | null;
}

interface UiStoreState {
  zenMode: boolean;
}

interface A11yWindow {
  __muxbaseFocusProbe?: Element | null;
  __muxbaseStores?: { pane?: StoreApi<PaneStoreState>; ui?: StoreApi<UiStoreState> };
}

interface FocusInfo {
  focusVisible: boolean;
  isBody: boolean;
  label: string | null;
  paneId: string | null;
  tag: string;
  testId: string | null;
  visibleArea: number;
}

interface ProbeState {
  activeLabel: string | null;
  activePane: string | null;
  paneCells: number;
  probeConnected: boolean;
  probePane: string | null;
  restored: boolean;
  storePanes: number;
}

interface Rect {
  height: number;
  width: number;
  x: number;
  y: number;
}

function fleet(waitingCount: number): BaselinePaneFixture[] {
  return buildBaselinePanes(FLEET_SIZE, PROJECT).map((pane, index) => ({
    ...pane,
    agentStatus: index < waitingCount ? ('waiting' as const) : ('idle' as const),
  }));
}

async function seedFleet(page: Page, panes: BaselinePaneFixture[]): Promise<void> {
  await seedBaselineFleet(page, panes);
  await pollUntil(
    async () => ((await page.locator(PANE_CELL).count()) === panes.length ? true : null),
    { interval: 100, label: `pane-cells(${panes.length})`, timeout: 15_000 },
  );
  await page.waitForTimeout(SETTLE_MS);
}

async function setWaitingCount(page: Page, waitingCount: number): Promise<void> {
  await seedBaselineFleet(page, fleet(waitingCount));
  await pollUntil(
    async () => (
      (await page.locator(ATTENTION_NUMERALS).count()) === (waitingCount > 0 ? 1 : 0) ? true : null
    ),
    { interval: 100, label: `attention-numeral(${waitingCount})`, timeout: 10_000 },
  );
  await page.waitForTimeout(SETTLE_MS);
}

async function dismissOverlays(page: Page): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    if ((await page.locator(OPEN_OVERLAYS).count()) === 0) return;
    await page.keyboard.press('Escape');
    await waitForValue(
      () => page.locator(OPEN_OVERLAYS).count(),
      (count) => count === 0,
      { timeout: OVERLAY_CLOSE_TIMEOUT_MS },
    );
  }
  expect(await page.locator(OPEN_OVERLAYS).count(), 'an overlay survived four Escapes').toBe(0);
}

async function resetUi(page: Page): Promise<void> {
  await dismissOverlays(page);
  await page.evaluate(() => {
    (window as unknown as A11yWindow).__muxbaseStores?.ui?.setState({
      activeView: 'dashboard',
      focusPaneId: null,
      helpOverlayOpen: false,
      viewMode: 'fleet',
      zenMode: false,
    });
    (document.activeElement as HTMLElement | null)?.blur();
  });
  await page.waitForTimeout(SETTLE_MS);
}

async function focusInfo(page: Page): Promise<FocusInfo> {
  return page.evaluate(() => {
    const element = document.activeElement;
    if (!element || element === document.body) {
      return {
        focusVisible: false,
        isBody: true,
        label: null,
        paneId: null,
        tag: 'body',
        testId: null,
        visibleArea: 0,
      };
    }
    const rect = element.getBoundingClientRect();
    return {
      focusVisible: element.matches(':focus-visible'),
      isBody: false,
      label: element.getAttribute('aria-label'),
      paneId: element.closest('[data-pane-id]')?.getAttribute('data-pane-id') ?? null,
      tag: element.tagName.toLowerCase(),
      testId: element.getAttribute('data-testid'),
      visibleArea: Math.round(rect.width * rect.height),
    };
  });
}

async function markFocusProbe(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as unknown as A11yWindow).__muxbaseFocusProbe = document.activeElement;
  });
}

async function focusProbeState(page: Page): Promise<ProbeState> {
  return page.evaluate(() => {
    const probe = (window as unknown as A11yWindow).__muxbaseFocusProbe ?? null;
    const paneOf = (element: Element | null): string | null =>
      element?.closest('[data-pane-id]')?.getAttribute('data-pane-id') ?? null;
    const active = document.activeElement;
    return {
      activeLabel: active?.getAttribute('aria-label') ?? active?.getAttribute('data-testid') ?? active?.tagName ?? null,
      activePane: paneOf(active),
      paneCells: document.querySelectorAll('[data-testid="pane-cell"]').length,
      probeConnected: probe?.isConnected ?? false,
      probePane: paneOf(probe),
      restored: probe !== null && active === probe,
      storePanes: (window as unknown as A11yWindow).__muxbaseStores?.pane?.getState().panes.length ?? -1,
    };
  });
}

async function settledFocusProbe(page: Page): Promise<ProbeState> {
  return waitForValue(() => focusProbeState(page), (state) => state.restored);
}

async function focusedTestId(page: Page): Promise<string | null> {
  return page.evaluate(() => document.activeElement?.getAttribute('data-testid') ?? null);
}

// Overlays hand focus over from a rAF callback or a passive effect, so every
// post-transition focus read polls until the handoff lands.
async function settledFocusTestId(page: Page, expected: string | null): Promise<string | null> {
  return waitForValue(() => focusedTestId(page), (testId) => testId === expected);
}

async function settledFocusInfo(page: Page, settled: (info: FocusInfo) => boolean): Promise<FocusInfo> {
  return waitForValue(() => focusInfo(page), settled);
}

async function selectedPaneId(page: Page): Promise<string | null> {
  return page.evaluate(() => (
    (window as unknown as A11yWindow).__muxbaseStores?.pane?.getState().selectedPaneId ?? null
  ));
}

async function zenMode(page: Page): Promise<boolean> {
  return page.evaluate(() => (
    (window as unknown as A11yWindow).__muxbaseStores?.ui?.getState().zenMode === true
  ));
}

async function blurActiveElement(page: Page): Promise<void> {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
}

// Chrome keeps the sequential-focus starting point where the last focused element
// was, so Tab walks start from the shell root to always enter the app at the top.
async function focusAppShell(page: Page): Promise<void> {
  await page.evaluate((selector) => {
    const shell = document.querySelector<HTMLElement>(selector);
    if (!shell) return;
    if (!shell.hasAttribute('tabindex')) shell.setAttribute('tabindex', '-1');
    shell.focus();
  }, APP_SHELL);
}

async function pressJumpShortcut(page: Page): Promise<void> {
  await page.keyboard.press('Meta+Shift+KeyJ');
}

// A pane only accepts the keyboard once its terminal is mounted: the handoff runs
// from a one-shot effect on selection, so a jump that lands first is never retried.
async function waitForPaneTerminal(page: Page, paneId: string): Promise<void> {
  await page.waitForSelector(`[data-pane-id="${paneId}"] ${TERMINAL_INPUT}`, {
    state: 'attached',
    timeout: 20_000,
  });
}

async function focusDescription(page: Page): Promise<string> {
  return page.evaluate(() => {
    const element = document.activeElement;
    if (!element || element === document.body) return 'body';
    return [
      element.tagName.toLowerCase(),
      element.getAttribute('data-testid') ?? '',
      element.getAttribute('aria-label') ?? '',
    ].filter(Boolean).join('|');
  });
}

async function walkTabsTo(page: Page, testId: string): Promise<number> {
  const trace: string[] = [];
  for (let presses = 1; presses <= TAB_WALK_LIMIT; presses += 1) {
    await page.keyboard.press('Tab');
    if ((await focusedTestId(page)) === testId) return presses;
    trace.push(await focusDescription(page));
  }
  throw new Error(
    `Tab walk never reached ${testId} within ${TAB_WALK_LIMIT} presses — visited ${JSON.stringify(trace.slice(0, 20))}`,
  );
}

async function openPalette(page: Page): Promise<void> {
  await page.keyboard.press('Meta+k');
  await page.waitForSelector(COMMAND_PALETTE, { timeout: 10_000 });
  await page.waitForSelector(PALETTE_SELECTED_ITEM, { timeout: 10_000 }).catch(async (error: Error) => {
    const items = await page.locator(`${COMMAND_PALETTE} [cmdk-item]`).count();
    const query = await page.locator(`${COMMAND_PALETTE} input`).inputValue();
    throw new Error(`${error.message} — items=${items} query="${query}"`);
  });
  await waitForSurfaceFocus(page, COMMAND_PALETTE);
}

async function closeTopSurface(page: Page, selector: string): Promise<void> {
  await waitForSurfaceFocus(page, selector);
  await page.keyboard.press('Escape');
  await page.waitForSelector(selector, { state: 'detached', timeout: 10_000 });
}

async function openPeekFromStat(page: Page): Promise<void> {
  await page.keyboard.press('Enter');
  await page.waitForSelector(PEEK, { timeout: 10_000 });
  await waitForSurfaceFocus(page, PEEK);
}

async function tagPaneCells(page: Page): Promise<string[]> {
  return page.evaluate(({ attribute, selector }) => (
    Array.from(document.querySelectorAll(selector)).map((cell, index) => {
      const tag = `${cell.getAttribute('data-pane-id') ?? ''}#${index}`;
      cell.setAttribute(attribute, tag);
      return tag;
    })
  ), { attribute: NODE_TAG_ATTRIBUTE, selector: PANE_CELL });
}

async function readPaneCellTags(page: Page): Promise<Array<string | null>> {
  return page.evaluate(({ attribute, selector }) => (
    Array.from(document.querySelectorAll(selector)).map((cell) => cell.getAttribute(attribute))
  ), { attribute: NODE_TAG_ATTRIBUTE, selector: PANE_CELL });
}

async function statRects(page: Page): Promise<Array<{ label: string; rect: Rect }>> {
  return waitForStable(() => readStatRects(page));
}

async function readStatRects(page: Page): Promise<Array<{ label: string; rect: Rect }>> {
  const measured = await page.$$eval(`${RESOURCE_BAR_STATS} > span`, (spans) => (
    spans.map((span) => {
      const rect = span.getBoundingClientRect();
      return {
        label: (span.textContent ?? '').trim(),
        rect: {
          height: Math.round(rect.height),
          width: Math.round(rect.width),
          x: Math.round(rect.x),
          y: Math.round(rect.y),
        },
      };
    })
  ));
  return measured.filter((entry) => /^\d+ (panes?|worktrees?|active)$/.test(entry.label));
}

async function boxOf(page: Page, selector: string): Promise<Rect> {
  const box = await waitForStable(() => page.locator(selector).boundingBox());
  expect(box, `no bounding box for ${selector}`).not.toBeNull();
  return {
    height: Math.round(box!.height),
    width: Math.round(box!.width),
    x: Math.round(box!.x),
    y: Math.round(box!.y),
  };
}

describe.runIf(process.env.MUXBASE_E2E === '1')('Keyboard and accessibility release stories', () => {
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

    await page.waitForSelector(APP_SHELL, { timeout: 15_000 });
    await waitForAppReady(page, APP_STARTUP_TIMEOUT_MS);
    await waitForRendererPaneHydration(page, APP_STARTUP_TIMEOUT_MS);
    await page.waitForSelector(RESOURCE_BAR, { timeout: 15_000 });
    await page.setViewportSize({ height: 900, width: 1440 });
  }, APP_STARTUP_TIMEOUT_MS);

  afterAll(async () => {
    if (page && !page.isClosed()) {
      await resetUi(page).catch(() => {});
      await seedFleet(page, []).catch(() => {});
    }
    if (app) await closeElectronApp(app);
  }, APP_SHUTDOWN_TIMEOUT_MS);

  it('story A: drives the palette and help overlay from the keyboard with exact focus return', async () => {
    // Arrange
    const panes = fleet(2);
    await resetUi(page);
    await seedFleet(page, panes);

    // Act
    await openPalette(page);

    // Assert — the palette owns focus on its own input
    const paletteFocus = await settledFocusInfo(page, (info) => info.tag === 'input');
    expect(paletteFocus.isBody).toBe(false);
    expect(paletteFocus.tag).toBe('input');
    expect(paletteFocus.visibleArea).toBeGreaterThan(0);

    // Act — arrowing moves the selected option, not DOM focus
    const firstOption = await page.locator(PALETTE_SELECTED_ITEM).getAttribute('id');
    await page.keyboard.press('ArrowDown');
    const secondOption = await waitForValue(
      () => page.locator(PALETTE_SELECTED_ITEM).getAttribute('id'),
      (id) => id !== firstOption,
    );

    // Assert
    expect(firstOption).not.toBeNull();
    expect(secondOption).not.toBe(firstOption);
    expect(await page.locator(PALETTE_SELECTED_ITEM).count()).toBe(1);
    expect(await page.locator(PALETTE_SELECTED_ITEM).getAttribute('aria-selected')).toBe('true');
    expect((await focusInfo(page)).tag).toBe('input');

    // Act
    await closeTopSurface(page, COMMAND_PALETTE);

    // Assert — nothing held focus before the palette, so the shell fallback takes it
    const afterPalette = await settledFocusInfo(page, (info) => info.testId === APP_SHELL_TEST_ID);
    expect(afterPalette.isBody).toBe(false);
    expect(afterPalette.testId).toBe(APP_SHELL_TEST_ID);

    // Act — help opens from a non-typing focus target
    await markFocusProbe(page);
    await page.keyboard.press('Shift+Slash');
    await page.waitForSelector(HELP_OVERLAY, { timeout: 10_000 });
    const helpHoldsFocus = await waitForSurfaceFocus(page, HELP_OVERLAY);

    // Assert
    expect(await page.locator(HELP_OVERLAY).textContent()).toContain('Keyboard Shortcuts');
    expect((await focusInfo(page)).isBody).toBe(false);
    expect(helpHoldsFocus).toBe(true);

    // Act
    await closeTopSurface(page, HELP_OVERLAY);

    // Assert
    const helpProbe = await settledFocusProbe(page);
    expect(helpProbe.restored, `help overlay focus probe ${JSON.stringify(helpProbe)}`).toBe(true);
    expect((await focusInfo(page)).testId).toBe(APP_SHELL_TEST_ID);

    // Act — a jump selects the waiting pane without stealing focus from a live control
    await pressJumpShortcut(page);
    const jumpSelection = await waitForValue(() => selectedPaneId(page), (id) => id === panes[0].id);

    // Assert
    expect(jumpSelection).toBe(panes[0].id);
    expect((await focusInfo(page)).testId).toBe(APP_SHELL_TEST_ID);

    // Act — from an unheld focus the same jump hands the keyboard to the pane terminal
    await waitForPaneTerminal(page, panes[1].id);
    await blurActiveElement(page);
    await pressJumpShortcut(page);

    // Assert
    const jumpedFocus = await settledFocusInfo(page, (info) => info.paneId === panes[1].id);
    expect(await selectedPaneId(page)).toBe(panes[1].id);
    expect(jumpedFocus.paneId).toBe(panes[1].id);
    expect(jumpedFocus.isBody).toBe(false);
    expect(jumpedFocus.tag).toBe('textarea');
    expect(jumpedFocus.label).toBe('Terminal input');

    // Act — back-to-back chords land inside the 400 ms double-shift window
    await pressJumpShortcut(page);
    await pressJumpShortcut(page);
    await page.waitForTimeout(SETTLE_MS);

    // Assert — both chords stay jumps and cycle back through the two waiting panes
    expect(await page.locator(COMMAND_PALETTE).count()).toBe(0);
    expect(await selectedPaneId(page)).toBe(panes[1].id);
    expect(await page.locator(OPEN_OVERLAYS).count()).toBe(0);

    // Act — the palette returns focus to the exact element it was opened from
    await markFocusProbe(page);
    await openPalette(page);
    await closeTopSurface(page, COMMAND_PALETTE);

    // Assert
    const paletteProbe = await settledFocusProbe(page);
    expect(paletteProbe.restored, `palette focus probe ${JSON.stringify(paletteProbe)}`).toBe(true);
    expect((await focusInfo(page)).paneId).toBe(panes[1].id);
  }, STEP_TIMEOUT_MS);

  it('story B: reaches the waiting stat by Tab and drives the peek queue by keyboard', async () => {
    // Arrange
    const panes = fleet(FLEET_SIZE);
    await resetUi(page);
    await seedFleet(page, panes);
    await page.waitForSelector(ATTENTION_STAT, { timeout: 10_000 });

    // Act
    await focusAppShell(page);
    const presses = await walkTabsTo(page, ATTENTION_STAT_TEST_ID);

    // Assert
    const statFocus = await focusInfo(page);
    expect(presses).toBeGreaterThan(0);
    expect(statFocus.isBody).toBe(false);
    expect(statFocus.focusVisible).toBe(true);
    expect(statFocus.visibleArea).toBeGreaterThan(0);

    // Act
    await openPeekFromStat(page);

    // Assert — the peek opens onto its first row
    expect(await settledFocusTestId(page, PEEK_ROW_TEST_ID)).toBe(PEEK_ROW_TEST_ID);

    // Act
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await page.waitForSelector(PEEK, { state: 'detached', timeout: 10_000 });

    // Assert
    expect(await waitForValue(() => selectedPaneId(page), (id) => id === panes[1].id)).toBe(panes[1].id);
    expect(await settledFocusTestId(page, ATTENTION_STAT_TEST_ID)).toBe(ATTENTION_STAT_TEST_ID);

    // Act
    await openPeekFromStat(page);
    await closeTopSurface(page, PEEK);

    // Assert
    const afterPeek = await settledFocusInfo(page, (info) => info.testId === ATTENTION_STAT_TEST_ID);
    expect(afterPeek.isBody).toBe(false);
    expect(afterPeek.testId).toBe(ATTENTION_STAT_TEST_ID);
    expect(await page.locator(PEEK_ROW).count()).toBe(0);
  }, STEP_TIMEOUT_MS);

  it('story B at 1280x720: keeps the peek queue keyboard-drivable on the smaller viewport', async () => {
    // Arrange
    const panes = fleet(FLEET_SIZE);
    await page.setViewportSize({ height: 720, width: 1280 });
    await resetUi(page);
    await seedFleet(page, panes);
    await page.waitForSelector(ATTENTION_STAT, { timeout: 10_000 });

    try {
      // Act
      await focusAppShell(page);
      await walkTabsTo(page, ATTENTION_STAT_TEST_ID);
      await openPeekFromStat(page);
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('Enter');
      await page.waitForSelector(PEEK, { state: 'detached', timeout: 10_000 });

      // Assert
      expect(await waitForValue(() => selectedPaneId(page), (id) => id === panes[1].id)).toBe(panes[1].id);
      expect(await settledFocusTestId(page, ATTENTION_STAT_TEST_ID)).toBe(ATTENTION_STAT_TEST_ID);
    } finally {
      await page.setViewportSize({ height: 900, width: 1440 });
      await page.waitForTimeout(SETTLE_MS);
    }
  }, STEP_TIMEOUT_MS);

  it('story C: keeps the Zen chip stable while the attention numeral comes and goes', async () => {
    // Arrange — park focus on the always-mounted shell so entering Zen cannot drop it
    const panes = fleet(FLEET_SIZE);
    await resetUi(page);
    await seedFleet(page, panes);
    await page.waitForSelector(ATTENTION_STAT, { timeout: 10_000 });
    await openPalette(page);
    await closeTopSurface(page, COMMAND_PALETTE);
    expect(await settledFocusTestId(page, APP_SHELL_TEST_ID)).toBe(APP_SHELL_TEST_ID);

    // Act
    await page.keyboard.press('Meta+Alt+z');
    await page.waitForSelector(ZEN_ATTENTION, { timeout: 10_000 });

    // Assert — the Zen chip shows the bare numeral and the resource bar is gone
    expect(await zenMode(page)).toBe(true);
    expect(
      (await waitForValue(
        () => page.locator(ZEN_ATTENTION).textContent(),
        (text) => text?.trim() === String(FLEET_SIZE),
      ))?.trim(),
    ).toBe(String(FLEET_SIZE));
    expect(await page.locator(RESOURCE_BAR).count()).toBe(0);
    expect((await settledFocusInfo(page, (info) => !info.isBody)).isBody).toBe(false);

    // Act — Escape is the documented Zen exit while focus is not in a text field
    await page.keyboard.press('Escape');
    await pollUntil(
      async () => ((await zenMode(page)) === false ? true : null),
      { interval: 100, label: 'escape-exits-zen', timeout: 10_000 },
    );

    // Assert
    expect(await page.locator(ZEN_ATTENTION).count()).toBe(0);

    // Act — re-enter Zen and jump from an unheld focus so the terminal receives it
    await blurActiveElement(page);
    await page.keyboard.press('Meta+Alt+z');
    await page.waitForSelector(ZEN_ATTENTION, { timeout: 10_000 });
    const newPaneBox = await boxOf(page, ZEN_NEW_PANE);
    const exitBox = await boxOf(page, ZEN_EXIT);
    await waitForPaneTerminal(page, panes[0].id);
    await pressJumpShortcut(page);

    // Assert
    const zenJumpFocus = await settledFocusInfo(page, (info) => info.paneId === panes[0].id);
    expect(await selectedPaneId(page)).toBe(panes[0].id);
    expect(zenJumpFocus.paneId).toBe(panes[0].id);
    expect(zenJumpFocus.isBody).toBe(false);
    expect(zenJumpFocus.tag).toBe('textarea');
    expect(zenJumpFocus.label).toBe('Terminal input');

    // Act
    await setWaitingCount(page, 0);

    // Assert — the numeral leaves without moving its sibling chip controls
    expect(await page.locator(ZEN_ATTENTION).count()).toBe(0);
    expect(await boxOf(page, ZEN_NEW_PANE)).toEqual(newPaneBox);
    expect(await boxOf(page, ZEN_EXIT)).toEqual(exitBox);

    // Act — Escape belongs to the terminal while it holds focus
    await page.keyboard.press('Escape');
    await page.waitForTimeout(SETTLE_MS);

    // Assert
    expect(await zenMode(page)).toBe(true);

    // Act
    await page.keyboard.press('Meta+Alt+z');
    await pollUntil(
      async () => ((await zenMode(page)) === false ? true : null),
      { interval: 100, label: 'zen-toggle-exits', timeout: 10_000 },
    );

    // Assert
    expect(await page.locator(RESOURCE_BAR).count()).toBe(1);
  }, STEP_TIMEOUT_MS);

  it('keeps pane nodes and the sibling stats stable across attention transitions', async () => {
    // Arrange
    await resetUi(page);
    await seedFleet(page, fleet(0));
    const tags = await tagPaneCells(page);
    const quietStats = await statRects(page);
    expect(tags).toHaveLength(FLEET_SIZE);
    expect(quietStats).toHaveLength(3);

    // Act
    await setWaitingCount(page, 2);

    // Assert
    expect(await readPaneCellTags(page)).toEqual(tags);
    expect(await statRects(page)).toEqual(quietStats);

    // Act
    await setWaitingCount(page, 0);

    // Assert
    expect(await readPaneCellTags(page)).toEqual(tags);
    expect(await statRects(page)).toEqual(quietStats);
  }, STEP_TIMEOUT_MS);

  it('keeps pane nodes stable across peek, palette and pane-menu cycles', async () => {
    // Arrange
    await resetUi(page);
    await seedFleet(page, fleet(FLEET_SIZE));
    const tags = await tagPaneCells(page);
    await page.waitForSelector(ATTENTION_STAT, { timeout: 10_000 });

    // Act
    await focusAppShell(page);
    await walkTabsTo(page, ATTENTION_STAT_TEST_ID);
    await openPeekFromStat(page);
    await closeTopSurface(page, PEEK);

    // Assert
    expect(await readPaneCellTags(page)).toEqual(tags);

    // Act
    await openPalette(page);
    await closeTopSurface(page, COMMAND_PALETTE);

    // Assert
    expect(await readPaneCellTags(page)).toEqual(tags);

    // Act
    await page.locator(`${PANE_CELL} button[aria-label="Pane actions"]`).first().click();
    await page.waitForSelector(PANE_ACTIONS_MENU, { timeout: 10_000 });
    await closeTopSurface(page, PANE_ACTIONS_MENU);

    // Assert
    expect(await readPaneCellTags(page)).toEqual(tags);
  }, STEP_TIMEOUT_MS);

  it('renders fleet separators with the value semantics happy-dom cannot produce', async () => {
    // Arrange
    await resetUi(page);
    await seedFleet(page, fleet(0));

    // Act
    const separators = await page.$$eval(FLEET_SEPARATOR, (handles) => (
      handles.map((handle) => ({
        role: handle.getAttribute('role'),
        valueNow: handle.getAttribute('aria-valuenow'),
      }))
    ));

    // Assert — the unit axe run exempts this rule for these third-party nodes
    expect(separators.length).toBeGreaterThan(0);
    for (const separator of separators) {
      expect(separator.role).toBe('separator');
      expect(separator.valueNow).not.toBeNull();
    }
  }, STEP_TIMEOUT_MS);
});
