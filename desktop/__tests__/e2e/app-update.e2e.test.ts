import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { _electron as electron } from 'playwright';
import type { ElectronApplication, Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { IPC } from '../../src/shared/ipc-channels';
import type { AppUpdateSnapshot } from '../../src/shared/app-update-types';
import { getAppWindow, waitForAppReady } from './e2e-helpers';
import { fakeUpdateEnvironment } from './fixtures/fake-update-client';

const ROOT = resolve(__dirname, '..', '..');
const MAIN_ENTRY = resolve(ROOT, 'out', 'main', 'index.js');
const STARTUP_TIMEOUT_MS = 30_000;

interface E2EUpdateWindow {
  __muxbaseStores?: {
    ui: {
      getState: () => {
        openSettings: (category: 'about') => void;
        setActiveView: (view: 'dashboard') => void;
        setViewMode: (mode: 'fleet' | 'kanban') => void;
        setZenMode: (enabled: boolean) => void;
      };
    };
  };
  muxbase: {
    invoke: <T>(channel: string) => Promise<T>;
  };
}

async function invokeUpdate<T>(page: Page, channel: string): Promise<T> {
  return page.evaluate(
    (ipcChannel) => (window as unknown as E2EUpdateWindow).muxbase.invoke<T>(ipcChannel),
    channel,
  );
}

async function setView(
  page: Page,
  view: 'fleet' | 'kanban' | 'settings' | 'zen',
): Promise<void> {
  await page.evaluate((target) => {
    const store = (window as unknown as E2EUpdateWindow).__muxbaseStores?.ui;
    if (!store) throw new Error('E2E UI store is unavailable');
    const ui = store.getState();
    ui.setZenMode(target === 'zen');
    if (target === 'settings') {
      ui.openSettings('about');
      return;
    }
    ui.setActiveView('dashboard');
    ui.setViewMode(target === 'kanban' ? 'kanban' : 'fleet');
  }, view);
}

describe.runIf(process.env.MUXBASE_E2E === '1')('Application update E2E', () => {
  describe('eligible packaged update', () => {
    let app: ElectronApplication;
    let page: Page;

    beforeAll(async () => {
      expect(existsSync(MAIN_ENTRY), `Build output missing: ${MAIN_ENTRY}`).toBe(true);
      app = await electron.launch({
        args: [MAIN_ENTRY],
        env: { ...process.env, ...fakeUpdateEnvironment('ready') },
      });
      page = await getAppWindow(app);
      await waitForAppReady(page, STARTUP_TIMEOUT_MS);
    }, STARTUP_TIMEOUT_MS);

    afterAll(async () => {
      await app?.close();
    }, STARTUP_TIMEOUT_MS);

    it('downloads through main-process IPC and reaches the guarded install state', async () => {
      expect(await page.getByTestId('app-update-control').count()).toBe(0);

      await invokeUpdate<AppUpdateSnapshot>(page, IPC.UPDATE_CHECK);
      await expect.poll(
        () => page.getByRole('button', { name: 'Update MuxBase to 0.0.2' }).count(),
        { timeout: 10_000 },
      ).toBe(1);
      expect(await page.getByText('MuxBase 0.0.2 is ready to install.').count()).toBe(1);

      for (const view of ['fleet', 'kanban', 'settings', 'zen'] as const) {
        await setView(page, view);
        await expect.poll(
          () => page.getByRole('button', { name: 'Update MuxBase to 0.0.2' }).count(),
        ).toBe(1);
      }

      await setView(page, 'fleet');
      const updateButton = page.getByRole('button', { name: 'Update MuxBase to 0.0.2' });
      await updateButton.click({ timeout: 3_000 });
      await expect.poll(
        () => page.getByRole('dialog', { name: 'MuxBase update ready' }).isVisible(),
      ).toBe(true);
      expect(await page.getByText('0.0.1 → 0.0.2').isVisible()).toBe(true);
      await page.getByRole('button', { name: 'Later' }).click({ timeout: 3_000 });
      await expect.poll(
        () => page.getByRole('dialog', { name: 'MuxBase update ready' }).count(),
        { timeout: 2_000 },
      ).toBe(0);
      await expect.poll(
        () => updateButton.evaluate((element) => element === document.activeElement),
        { timeout: 2_000 },
      ).toBe(true);

      await updateButton.click({ timeout: 3_000 });
      await page.getByRole('button', { name: 'Restart and update' }).click({ timeout: 3_000 });
      await expect.poll(
        () => page.getByRole('button', {
          name: 'Preparing to restart and update MuxBase',
        }).isDisabled(),
        { timeout: 10_000 },
      ).toBe(true);
    }, 20_000);
  });

  describe('unsupported installation location', () => {
    let app: ElectronApplication;
    let page: Page;

    beforeAll(async () => {
      app = await electron.launch({
        args: [MAIN_ENTRY],
        env: { ...process.env, ...fakeUpdateEnvironment('not-in-applications') },
      });
      page = await getAppWindow(app);
      await waitForAppReady(page, STARTUP_TIMEOUT_MS);
    }, STARTUP_TIMEOUT_MS);

    afterAll(async () => {
      await app?.close();
    }, STARTUP_TIMEOUT_MS);

    it('never checks or offers install and keeps remediation discoverable after dismissal', async () => {
      await expect.poll(() => page.getByLabel('Automatic update setup').isVisible()).toBe(true);
      expect(await page.getByTestId('app-update-control').count()).toBe(0);

      const snapshot = await invokeUpdate<AppUpdateSnapshot>(page, IPC.UPDATE_CHECK);
      expect(snapshot).toMatchObject({
        disabledReason: 'not-in-applications',
        phase: 'disabled',
        revision: 0,
      });

      await page.getByRole('button', { name: 'Not now' }).click();
      expect(await page.getByLabel('Automatic update setup').count()).toBe(0);
      await setView(page, 'settings');
      await expect.poll(
        () => page.getByText('Automatic updates unavailable — move MuxBase to Applications').isVisible(),
      ).toBe(true);
      expect(await page.getByRole('button', { name: 'Check for Updates' }).isDisabled()).toBe(true);
      expect(await page.getByRole('button', { name: /Restart and update/ }).count()).toBe(0);
    });
  });
});
