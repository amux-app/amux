import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { _electron as electron } from 'playwright';
import type { ElectronApplication, Page, ConsoleMessage } from 'playwright';
import { resolve } from 'path';
import { existsSync } from 'fs';
import { IPC } from '../../src/shared/ipc-channels';
import { DEFAULT_TERMINAL_FONT_FAMILY } from '../../src/shared/terminal-profile';
import { closeElectronApp, getSessionInfo, waitForAppReady, waitForRendererPaneHydration } from './e2e-helpers';
import {
  applyBaselineTheme,
  BASELINE_CAPTURE_TIMEOUT_MS,
  BASELINE_PANE_COUNTS,
  BASELINE_THEMES,
  BASELINE_VIEWPORTS,
  buildBaselinePanes,
  captureBaselineCell,
  prepareBaselineDir,
  readBaselineAxeSource,
  seedBaselineFleet,
  writeBaselineReport,
} from './ui-baseline';
import type { BaselineAxeRunner, BaselineCell, BaselineStoreWindow } from './ui-baseline';
import { assertVisualBaseline } from './visual-regression';

const ROOT = resolve(__dirname, '..', '..');
const MAIN_ENTRY = resolve(ROOT, 'out', 'main', 'index.js');
const APP_STARTUP_TIMEOUT_MS = 30_000;
const APP_SHUTDOWN_TIMEOUT_MS = 30_000;
const TOOLBAR_ACTION_TIMEOUT_MS = 10_000;

async function getAppWindow(app: ElectronApplication): Promise<Page> {
  for (const win of app.windows()) {
    const url = win.url();
    if (!url.startsWith('devtools://')) return win;
  }
  const page = await app.firstWindow();
  if (page.url().startsWith('devtools://')) {
    return new Promise((resolve) => {
      app.on('window', (win) => {
        if (!win.url().startsWith('devtools://')) resolve(win);
      });
    });
  }
  return page;
}

interface E2EWindow {
  __aumxTerminalDebug?: {
    getFontFamily: (paneId: string) => string | null;
  };
  aumx: {
    invoke: <T>(channel: string, ...args: unknown[]) => Promise<T>;
  };
}

async function getPaneIds(page: Page): Promise<string[]> {
  return page.evaluate(async (channel) => {
    const e2eWindow = window as unknown as E2EWindow;
    const panes = await e2eWindow.aumx.invoke<Array<{ id: string }>>(channel);
    return panes.map((pane) => pane.id);
  }, IPC.PANE_LIST);
}

async function waitForCreatedPaneId(page: Page, existingPaneIds: Set<string>, timeoutMs: number): Promise<string> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const paneId = (await getPaneIds(page)).find((id) => !existingPaneIds.has(id));
    if (paneId) {
      return paneId;
    }
    await page.waitForTimeout(250);
  }

  throw new Error('Timed out waiting for a new pane');
}

async function closePane(page: Page, paneId: string): Promise<void> {
  await page.evaluate(
    async ({ channel, request }) => {
      const e2eWindow = window as unknown as E2EWindow;
      await e2eWindow.aumx.invoke(channel, request);
    },
    { channel: IPC.PANE_CLOSE, request: { paneId } },
  );
}

describe.runIf(process.env.AUMX_E2E === '1')('Desktop App E2E', () => {
  let app: ElectronApplication;
  let page: Page;
  const createdPaneIds: string[] = [];
  const consoleErrors: string[] = [];
  const consoleWarnings: string[] = [];

  beforeAll(async () => {
    expect(existsSync(MAIN_ENTRY), `Build output missing: ${MAIN_ENTRY}`).toBe(true);

    app = await electron.launch({
      args: [MAIN_ENTRY],
      env: {
        ...process.env,
        NODE_ENV: 'test',
        AUMX_DEV: 'true',
      },
    });

    page = await getAppWindow(app);

    page.on('console', (msg: ConsoleMessage) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
      if (msg.type() === 'warning') consoleWarnings.push(msg.text());
    });

    await page.waitForSelector('[data-testid="app-shell"]', { timeout: 10_000 }).catch(() => {
      // Fallback: wait for any content
    });
    await waitForAppReady(page, APP_STARTUP_TIMEOUT_MS);
    await waitForRendererPaneHydration(page, APP_STARTUP_TIMEOUT_MS);
  }, APP_STARTUP_TIMEOUT_MS);

  afterAll(async () => {
    if (page) {
      for (const paneId of createdPaneIds) {
        await closePane(page, paneId);
      }
    }
    if (app) await closeElectronApp(app);
  }, APP_SHUTDOWN_TIMEOUT_MS);

  // --- Window & Process ---

  it('opens a window', async () => {
    const windows = app.windows();
    expect(windows.length).toBeGreaterThanOrEqual(1);
  });

  it('window has correct title', async () => {
    const title = await page.title();
    expect(title).toBeTruthy();
  });

  it('window has reasonable dimensions', async () => {
    const dimensions = await page.evaluate(() => ({
      width: window.innerWidth,
      height: window.innerHeight,
    }));
    expect(dimensions.width).toBeGreaterThanOrEqual(800);
    expect(dimensions.height).toBeGreaterThanOrEqual(500);
  });

  // --- Renderer loaded ---

  it('renders HTML content', async () => {
    const html = await page.content();
    expect(html).toContain('<div id="root">');
  });

  it('React root is mounted with children', async () => {
    const childCount = await page.evaluate(() => {
      const root = document.getElementById('root');
      return root ? root.children.length : 0;
    });
    expect(childCount).toBeGreaterThan(0);
  });

  // --- Layout structure ---

  it('renders the sidebar', async () => {
    const sidebar = await page.$('aside, [class*="sidebar"], nav');
    expect(sidebar).not.toBeNull();
  });

  it('renders the main content area', async () => {
    const main = await page.$('main');
    expect(main).not.toBeNull();
  });

  it('hides the board switcher by default', async () => {
    const boardButtons = await page.locator('button').filter({ hasText: /^Board/ }).count();
    expect(boardButtons).toBe(0);
  });

  it('creates a terminal pane from the toolbar', async () => {
    const existingPaneIds = new Set(await getPaneIds(page));

    await page.locator('[data-testid="resource-new-menu"]').click({ timeout: TOOLBAR_ACTION_TIMEOUT_MS });
    await page.locator('[data-testid="resource-new-shell"]').click({ timeout: TOOLBAR_ACTION_TIMEOUT_MS });

    const paneId = await waitForCreatedPaneId(page, existingPaneIds, 15_000);
    createdPaneIds.push(paneId);

    await page.waitForSelector(
      `[data-testid="interactive-terminal"][data-pane-id="${paneId}"] .xterm`,
      { timeout: 10_000 },
    );

    const terminalBackground = await page.locator(
      `[data-testid="interactive-terminal"][data-pane-id="${paneId}"]`,
    ).evaluate((element) => getComputedStyle(element).backgroundColor);
    expect(terminalBackground).toBe('rgb(0, 0, 0)');

    const terminalFontFamily = await page.evaluate((id) => {
      const e2eWindow = window as unknown as E2EWindow;
      return e2eWindow.__aumxTerminalDebug?.getFontFamily(id) ?? null;
    }, paneId);
    expect(terminalFontFamily).toBe(DEFAULT_TERMINAL_FONT_FAMILY);

    const loadedTerminalFonts = await page.evaluate(async () => {
      const googleSansCode = await document.fonts.load('12px "Google Sans Code"');
      const intelOneMono = await document.fonts.load('12px "Intel One Mono"');
      return {
        googleSansCode: googleSansCode.length,
        intelOneMono: intelOneMono.length,
      };
    });
    expect(loadedTerminalFonts.googleSansCode).toBeGreaterThan(0);
    expect(loadedTerminalFonts.intelOneMono).toBeGreaterThan(0);

    await closePane(page, paneId);
    createdPaneIds.splice(createdPaneIds.indexOf(paneId), 1);
  }, 30_000);

  it('renames and safely deletes a chat from the sidebar', async () => {
    const existingPaneIds = new Set(await getPaneIds(page));
    const consoleErrorStart = consoleErrors.length;

    await page.locator('[data-testid="resource-new-menu"]').click({ timeout: TOOLBAR_ACTION_TIMEOUT_MS });
    await page.locator('[data-testid="resource-new-shell"]').click({ timeout: TOOLBAR_ACTION_TIMEOUT_MS });

    const paneId = await waitForCreatedPaneId(page, existingPaneIds, 15_000);
    createdPaneIds.push(paneId);

    const row = page.locator(`[data-testid="sidebar-agent-list"] li[data-flip-id="${paneId}"]`);
    await row.waitFor({ state: 'visible', timeout: 10_000 });
    const actions = row.locator('button[aria-haspopup="menu"]');
    await actions.focus();
    await page.waitForFunction(
      (selector) => getComputedStyle(document.querySelector(selector) as HTMLElement).opacity === '1',
      `[data-testid="sidebar-agent-list"] li[data-flip-id="${paneId}"] button[aria-haspopup="menu"]`,
    );

    await row.locator('[data-sidebar-agent-select="true"]').dblclick();
    const renameInput = row.getByRole('textbox', { name: /^Rename / });
    expect(await renameInput.evaluate((element) => document.activeElement === element)).toBe(true);
    await renameInput.fill('E2E renamed chat');
    await renameInput.press('Enter');
    const renamedActions = row.getByRole('button', { name: 'Actions for E2E renamed chat' });
    await renamedActions.waitFor({ state: 'visible', timeout: 10_000 });
    expect(await renamedActions.evaluate((element) => document.activeElement === element)).toBe(true);

    await renamedActions.click();
    await page.getByRole('menuitem', { name: 'Delete' }).click();
    const dialog = page.getByRole('dialog', { name: 'Delete “E2E renamed chat”?' });
    await dialog.waitFor({ state: 'visible', timeout: 5_000 });
    await page.waitForFunction(
      () => {
        const panel = document.querySelector<HTMLElement>('[role="dialog"][aria-modal="true"]');
        return panel !== null && getComputedStyle(panel).opacity === '1';
      },
    );
    expect(await page.evaluate(() => document.activeElement?.textContent?.trim())).toBe('Cancel');
    expect(await dialog.textContent()).toContain('Project files are not deleted');

    const screenshotPath = resolve(ROOT, 'out', 'sidebar-chat-actions.png');
    await page.screenshot({ path: screenshotPath });
    expect(existsSync(screenshotPath)).toBe(true);

    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await dialog.waitFor({ state: 'detached', timeout: 5_000 });
    expect(await row.count()).toBe(1);
    expect(await renamedActions.evaluate((element) => document.activeElement === element)).toBe(true);

    await renamedActions.click();
    await page.getByRole('menuitem', { name: 'Delete' }).click();
    const expectedFocusPaneId = await row.evaluate((currentRow) => {
      const list = currentRow.closest('[data-sidebar-agent-list="true"]');
      const current = currentRow.querySelector('[data-sidebar-agent-select="true"]');
      if (!list || !current) return null;
      const rows = Array.from(list.querySelectorAll('[data-sidebar-agent-select="true"]'));
      const index = rows.indexOf(current);
      const target = rows[index + 1] ?? rows[index - 1];
      return target?.closest('li[data-flip-id]')?.getAttribute('data-flip-id') ?? null;
    });
    const finalDialog = page.getByRole('dialog', { name: 'Delete “E2E renamed chat”?' });
    await finalDialog.getByRole('button', { name: 'Delete chat' }).click();
    await row.waitFor({ state: 'detached', timeout: 15_000 });
    createdPaneIds.splice(createdPaneIds.indexOf(paneId), 1);

    const restoredFocus = await page.evaluate(() => ({
      appShell: document.activeElement?.matches('[data-testid="app-shell"]') ?? false,
      paneId: document.activeElement?.closest('li[data-flip-id]')?.getAttribute('data-flip-id') ?? null,
    }));
    if (expectedFocusPaneId) {
      expect(restoredFocus.paneId).toBe(expectedFocusPaneId);
    } else {
      expect(restoredFocus.appShell).toBe(true);
    }

    expect(consoleErrors.slice(consoleErrorStart)).toEqual([]);
  }, 30_000);

  // --- CSS & Theming ---

  it('loads CSS styles (not unstyled)', async () => {
    const hasStyles = await page.evaluate(() => {
      return document.styleSheets.length > 0;
    });
    expect(hasStyles).toBe(true);
  });

  it('applies dark theme by default', async () => {
    const theme = await page.evaluate(() => {
      return document.documentElement.getAttribute('data-theme');
    });
    expect(theme).toBe('dark');
  });

  it('uses pitch black as the dark app shell background', async () => {
    const bgColor = await page.evaluate(() => {
      return getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
    });
    expect(bgColor).toBe('#000000');
  });

  // --- No critical errors ---

  it('has no uncaught JavaScript errors in console', () => {
    const criticalErrors = consoleErrors.filter(
      (e) =>
        !e.includes('Autofill.enable') &&
        !e.includes('Autofill.setAddresses') &&
        !e.includes('favicon.ico') &&
        !e.includes('net::ERR_NETWORK_CHANGED'),
    );
    if (criticalErrors.length > 0) {
      console.error('Console errors found:', criticalErrors);
    }
    expect(criticalErrors).toHaveLength(0);
  });

  // --- Electron main process ---

  it('can evaluate in main process', async () => {
    const appPath = await app.evaluate(async ({ app: electronApp }) => {
      return electronApp.getAppPath();
    });
    expect(appPath).toBeTruthy();
    expect(typeof appPath).toBe('string');
  });

  it('app is not packaged (dev mode)', async () => {
    const isPackaged = await app.evaluate(async ({ app: electronApp }) => {
      return electronApp.isPackaged;
    });
    expect(isPackaged).toBe(false);
  });

  // --- Visual regression ---

  it('matches the stable Fleet and settings visual baselines', async () => {
    const originalViewport = page.viewportSize();
    const original = await page.evaluate(() => {
      const stores = (window as unknown as BaselineStoreWindow).__aumxStores;
      return {
        panes: stores?.pane?.getState().panes ?? [],
        ui: stores?.ui?.getState() ?? {},
      };
    });
    const visualNormalization = await page.addStyleTag({
      content: '[aria-live="polite"].fixed.bottom-4.right-4 { visibility: hidden !important; }',
    });

    try {
      await page.setViewportSize({ height: 720, width: 1280 });
      await seedBaselineFleet(page, []);
      await page.evaluate(() => {
        (window as unknown as BaselineStoreWindow).__aumxStores?.ui?.setState({
          activeView: 'dashboard',
          focusPaneId: null,
          sidebarCollapsed: false,
          theme: 'dark',
          viewMode: 'fleet',
          zenMode: false,
        });
      });
      await page.waitForTimeout(200);

      const main = page.locator('main');
      await assertVisualBaseline(page, main, 'fleet-empty-dark');

      await applyBaselineTheme(page, 'light');
      await assertVisualBaseline(page, main, 'fleet-empty-light');

      await page.evaluate(() => {
        (window as unknown as BaselineStoreWindow).__aumxStores?.ui?.setState({
          activeView: 'settings',
          settingsCategory: 'appearance',
          theme: 'dark',
        });
      });
      await page.getByRole('heading', { name: 'Appearance' }).waitFor({ state: 'visible' });
      await page.waitForTimeout(200);
      await assertVisualBaseline(page, main, 'settings-appearance-dark');
    } finally {
      await page.evaluate((restore) => {
        const stores = (window as unknown as BaselineStoreWindow).__aumxStores;
        stores?.pane?.setState({ panes: restore.panes, selectedPaneId: null });
        stores?.ui?.setState(restore.ui);
      }, original);
      await visualNormalization.evaluate((style) => style.remove());
      if (originalViewport) await page.setViewportSize(originalViewport);
    }
  }, 15_000);

  // --- UI/UX baseline capture (opt-in, records artifacts, asserts nothing) ---

  it.runIf(process.env.AUMX_UI_BASELINE === '1')('records the UI baseline matrix', async () => {
    prepareBaselineDir();

    await page.evaluate(readBaselineAxeSource());
    const axeReady = await page.evaluate(
      () => typeof (window as unknown as { axe?: BaselineAxeRunner }).axe?.run === 'function',
    );

    const session = await getSessionInfo(page);
    const project = {
      projectName: session.projectName ?? 'aumx',
      projectRoot: session.projectRoot ?? ROOT,
    };
    const originalViewport = page.viewportSize();
    const original = await page.evaluate(() => {
      const stores = (window as unknown as BaselineStoreWindow).__aumxStores;
      return {
        panes: stores?.pane?.getState().panes ?? [],
        theme: stores?.ui?.getState().theme ?? 'dark',
      };
    });
    await page.evaluate(() => {
      (window as unknown as BaselineStoreWindow).__aumxStores?.ui?.setState({
        activeView: 'dashboard',
        focusPaneId: null,
        viewMode: 'fleet',
      });
    });

    const cells: BaselineCell[] = [];
    for (const viewport of BASELINE_VIEWPORTS) {
      await page.setViewportSize({ height: viewport.height, width: viewport.width });
      for (const theme of BASELINE_THEMES) {
        const appliedTheme = await applyBaselineTheme(page, theme);
        for (const paneCount of BASELINE_PANE_COUNTS) {
          cells.push(
            await captureBaselineCell(page, {
              appliedTheme,
              paneCount,
              panes: buildBaselinePanes(paneCount, project),
              theme,
              viewport,
            }),
          );
        }
      }
    }

    await page.evaluate((restore) => {
      const stores = (window as unknown as BaselineStoreWindow).__aumxStores;
      stores?.pane?.setState({ panes: restore.panes, selectedPaneId: null });
      stores?.ui?.setState({ theme: restore.theme });
    }, original);
    if (originalViewport) await page.setViewportSize(originalViewport);

    writeBaselineReport(axeReady, cells);
  }, BASELINE_CAPTURE_TIMEOUT_MS);
});
