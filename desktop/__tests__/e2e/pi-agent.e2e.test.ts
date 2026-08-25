import { existsSync } from 'fs';
import { resolve } from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { _electron as electron, type ConsoleMessage, type ElectronApplication, type Page } from 'playwright';
import { IPC } from '../../src/shared/ipc-channels';
import { closeElectronApp, waitForAppReady, waitForRendererPaneHydration } from './e2e-helpers';

const ROOT = resolve(__dirname, '..', '..');
const MAIN_ENTRY = resolve(ROOT, 'out', 'main', 'index.js');
const STARTUP_TIMEOUT_MS = 30_000;

interface E2EWindow {
  muxbase: {
    invoke: <T>(channel: string, ...args: unknown[]) => Promise<T>;
  };
}

async function getAppWindow(app: ElectronApplication): Promise<Page> {
  const existing = app.windows().find((window) => !window.url().startsWith('devtools://'));
  if (existing) return existing;
  return app.firstWindow();
}

async function listPanes(page: Page): Promise<Array<{ agent?: string; id: string }>> {
  return page.evaluate(async (channel) => {
    const appWindow = window as unknown as E2EWindow;
    return appWindow.muxbase.invoke(channel);
  }, IPC.PANE_LIST);
}

describe.runIf(process.env.MUXBASE_E2E_PI === '1')('Pi agent E2E', () => {
  let app: ElectronApplication;
  let page: Page;
  let createdPaneId: string | undefined;
  const consoleErrors: string[] = [];

  beforeAll(async () => {
    expect(existsSync(MAIN_ENTRY), `Build output missing: ${MAIN_ENTRY}`).toBe(true);
    app = await electron.launch({
      args: [MAIN_ENTRY],
      env: { ...process.env, MUXBASE_DEV: 'true', MUXBASE_E2E: '1', NODE_ENV: 'test' },
    });
    page = await getAppWindow(app);
    page.on('console', (message: ConsoleMessage) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    await waitForAppReady(page, STARTUP_TIMEOUT_MS);
    await waitForRendererPaneHydration(page, STARTUP_TIMEOUT_MS);
  }, STARTUP_TIMEOUT_MS);

  afterAll(async () => {
    if (createdPaneId && page) {
      await page.evaluate(async ({ channel, paneId }) => {
        const appWindow = window as unknown as E2EWindow;
        await appWindow.muxbase.invoke(channel, { paneId });
      }, { channel: IPC.PANE_CLOSE, paneId: createdPaneId });
    }
    if (app) await closeElectronApp(app);
  }, STARTUP_TIMEOUT_MS);

  it('selects Pi, exposes honest controls, and launches a live terminal', async () => {
    const existingIds = new Set((await listPanes(page)).map((pane) => pane.id));

    await page.locator('[data-testid="resource-new-pane"]').click();
    const piCard = page.getByRole('radio', { name: /^Pi/ });
    await expect.poll(() => piCard.isVisible()).toBe(true);
    await expect.poll(() => piCard.isEnabled()).toBe(true);
    await piCard.click();

    const configuration = page.getByRole('button', { name: /^Configuration/ });
    await configuration.click();
    await expect.poll(() => page.getByText('Use Pi default').isVisible()).toBe(true);
    await expect.poll(() => page.getByText('Pi Standard Tools').isVisible()).toBe(true);
    await expect.poll(() => page.getByText('Recommended isolation').isVisible()).toBe(true);
    await page.screenshot({ path: '/tmp/muxbase-pi-prism-smoke.png' });

    await page.getByRole('button', { name: 'Launch Pi' }).click();
    await expect.poll(async () => {
      const panes = await listPanes(page);
      const created = panes.find((pane) => !existingIds.has(pane.id));
      createdPaneId = created?.id;
      return created?.agent;
    }, { timeout: 20_000 }).toBe('pi');

    await expect.poll(
      () => page.locator(`[data-testid="interactive-terminal"][data-pane-id="${createdPaneId}"] .xterm`).isVisible(),
      { timeout: 15_000 },
    ).toBe(true);
    expect(consoleErrors).toEqual([]);
  }, 45_000);
});
