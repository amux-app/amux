import type { AumxPane } from 'aumx/core';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { _electron as electron } from 'playwright';
import type { ElectronApplication, Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { IPC_EVENT } from '../../src/shared/ipc-channels';
import type { FileChangedEvent } from '../../src/shared/ipc-types';
import {
  closeElectronApp,
  ensureAppWindowVisible,
  getAppWindow,
  waitForAppReady,
  waitForRendererPaneHydration,
} from './e2e-helpers';

const ROOT = resolve(__dirname, '..', '..');
const MAIN_ENTRY = resolve(ROOT, 'out', 'main', 'index.js');
const LARGE_FILE_COUNT = 160;
const execFileAsync = promisify(execFile);

interface PaneStoreState {
  setPanes: (panes: AumxPane[]) => void;
  selectPane: (id: string | null) => void;
}

interface E2EStores {
  pane: {
    getState: () => PaneStoreState;
  };
}

interface E2EWindow {
  __AUMX_E2E?: boolean;
  __fileChangedEvents?: FileChangedEvent[];
  __aumxStores?: E2EStores;
  aumx?: {
    on: (channel: string, callback: (event: FileChangedEvent) => void) => () => void;
  };
}

async function seedProject(root: string): Promise<void> {
  await mkdir(join(root, 'src', 'nested'), { recursive: true });
  await writeFile(join(root, 'package.json'), '{"name":"file-browser-e2e"}\n');
  await writeFile(join(root, 'README.md'), '# Title\n\nSome **markdown** body.\n\n- one\n- two\n');
  await writeFile(join(root, 'src', 'index.ts'), 'export const value = 42;\n');
  await writeFile(join(root, 'src', 'nested', 'deep.ts'), 'export const deep = true;\n');

  for (let index = 0; index < LARGE_FILE_COUNT; index += 1) {
    const padded = String(index).padStart(3, '0');
    await writeFile(join(root, `zz-${padded}.txt`), `file ${padded}\n`);
  }
}

async function installPane(page: Page, projectRoot: string): Promise<void> {
  await page.evaluate((root) => {
    const e2eWindow = window as unknown as E2EWindow;
    const stores = e2eWindow.__aumxStores;
    if (!stores) {
      throw new Error('E2E stores were not exposed');
    }
    const pane: AumxPane = {
      id: 'file-browser-e2e-pane',
      slug: 'file-browser-e2e',
      prompt: '',
      paneId: '%file-browser-e2e',
      projectRoot: root,
      type: 'shell',
    };
    stores.pane.getState().setPanes([pane]);
    stores.pane.getState().selectPane(pane.id);
  }, projectRoot);
}

function row(page: Page, path: string) {
  return page.locator(`[data-testid="file-tree-row"][data-file-path="${path}"]`);
}

async function waitForVisible(locator: ReturnType<Page['locator']>, timeout = 10_000): Promise<void> {
  await locator.waitFor({ state: 'visible', timeout });
}

async function killProjectTmuxSession(projectRoot: string): Promise<void> {
  const sessionName = `aumx-${basename(projectRoot)}`;
  await execFileAsync('tmux', ['kill-session', '-t', sessionName]).catch(() => undefined);
}

describe.runIf(process.env.AUMX_E2E === '1')('File Browser E2E', () => {
  let app: ElectronApplication;
  let page: Page;
  let projectRoot: string;

  beforeAll(async () => {
    expect(existsSync(MAIN_ENTRY), `Build output missing: ${MAIN_ENTRY}`).toBe(true);

    projectRoot = await mkdtemp(join(tmpdir(), 'aumx-file-browser-e2e-'));
    await seedProject(projectRoot);

    app = await electron.launch({
      args: [MAIN_ENTRY],
      cwd: projectRoot,
      env: {
        ...process.env,
        NODE_ENV: 'test',
        AUMX_DEV: 'true',
        AUMX_E2E: '1',
      },
    });

    page = await getAppWindow(app);
    await app.context().addInitScript(() => {
      (window as unknown as E2EWindow).__AUMX_E2E = true;
    });
    await page.reload();
    await ensureAppWindowVisible(app);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.waitForSelector('[data-testid="app-shell"]', { timeout: 15_000 });
    await waitForAppReady(page);
    await waitForRendererPaneHydration(page);
    await installPane(page, projectRoot);
  }, 30_000);

  afterAll(async () => {
    try {
      if (app) await closeElectronApp(app);
    } finally {
      if (projectRoot) {
        await killProjectTmuxSession(projectRoot);
        await rm(projectRoot, { recursive: true, force: true });
      }
    }
  }, 60_000);

  it('drives the virtualized tree in a real Electron renderer', async () => {
    await page.locator('[data-testid="sidebar-file-browser-toggle"]').click();
    await page.locator('[data-testid="file-browser-panel"]').waitFor({ state: 'visible', timeout: 10_000 });
    await page.locator('button[title="Close file browser"]').click();
    await page.locator('[data-testid="file-browser-panel"]').waitFor({ state: 'hidden', timeout: 10_000 });
    await page.locator('[data-testid="sidebar-file-browser-toggle"]').click();
    await page.locator('[data-testid="file-browser-panel"]').waitFor({ state: 'visible', timeout: 10_000 });

    await row(page, 'src').click();
    await waitForVisible(row(page, 'src/index.ts'));

    const iconGeometry = await row(page, 'src/index.ts').locator('svg').first().evaluate((icon) => {
      const symbolId = icon.querySelector('use')?.getAttribute('href')?.slice(1) ?? '';
      const box = icon.getBoundingClientRect();
      return { hasSymbol: document.getElementById(symbolId) !== null, symbolId, width: box.width };
    });
    expect(iconGeometry).toEqual({ hasSymbol: true, symbolId: 'fi-typescript', width: 14 });

    await row(page, 'src/index.ts').click();
    await waitForVisible(page.locator('[data-testid="file-viewer"] [title="src/index.ts"]'));

    await row(page, 'src').click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'New File' }).click();
    await page.locator('[data-testid="file-tree-inline-input"]').fill('created.ts');
    await page.keyboard.press('Enter');
    await waitForVisible(row(page, 'src/created.ts'));

    await row(page, 'src/created.ts').click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Rename' }).click();
    await page.locator('[data-testid="file-tree-inline-input"]').fill('renamed.ts');
    await page.keyboard.press('Enter');
    await waitForVisible(row(page, 'src/renamed.ts'));

    await page.locator('[data-testid="file-tree"]').hover();
    await page.mouse.wheel(0, 5000);
    await waitForVisible(row(page, 'zz-159.txt'));
    const tree = page.getByRole('tree', { name: /Files in / });
    await expect.poll(() => tree.evaluate((element) => {
      const activeDescendantId = element.getAttribute('aria-activedescendant');
      return activeDescendantId !== null && document.getElementById(activeDescendantId) !== null;
    })).toBe(true);

    await row(page, 'zz-159.txt').click();
    await waitForVisible(page.locator('[data-testid="file-viewer"] [title="zz-159.txt"]'));

    const indexTab = page.getByRole('tab', { name: 'index.ts' });
    await indexTab.click({ button: 'right' });
    await waitForVisible(page.getByRole('menuitem', { name: 'Close to the Right' }));
    await waitForVisible(page.getByRole('menuitem', { name: 'Close Others' }));
    await waitForVisible(page.getByRole('menuitem', { name: 'Close All' }));
    await page.getByRole('menuitem', { name: 'Close to the Right' }).click();

    expect(await page.getByRole('tab', { name: 'index.ts' }).count()).toBe(1);
    expect(await page.getByRole('tab', { name: 'zz-159.txt' }).count()).toBe(0);
  }, 30_000);

  it('navigates the virtualized file tree entirely from the keyboard', async () => {
    const panel = page.locator('[data-testid="file-browser-panel"]');
    if (!await panel.isVisible()) {
      await page.locator('[data-testid="sidebar-file-browser-toggle"]').click();
      await panel.waitFor({ state: 'visible', timeout: 10_000 });
    }
    const tree = page.getByRole('tree', { name: /Files in / });
    await tree.focus();
    await page.keyboard.press('Home');
    await page.keyboard.press('s');
    await expect.poll(() => row(page, 'src').getAttribute('aria-selected')).toBe('true');

    if (await row(page, 'src').getAttribute('aria-expanded') === 'false') {
      await page.keyboard.press('ArrowRight');
    }
    await page.keyboard.press('ArrowRight');
    const childPath = await tree.locator('[role="treeitem"][aria-selected="true"]').getAttribute('data-file-path');
    expect(childPath?.startsWith('src/')).toBe(true);

    await page.keyboard.press('ArrowLeft');
    await expect.poll(() => row(page, 'src').getAttribute('aria-selected')).toBe('true');
    await page.keyboard.press('End');
    await waitForVisible(row(page, 'zz-159.txt'));
    expect(await row(page, 'zz-159.txt').getAttribute('aria-selected')).toBe('true');

    await page.keyboard.press('Enter');
    await waitForVisible(page.locator('[data-testid="file-viewer"] [title="zz-159.txt"]'));
  }, 30_000);

  it('shift-clicks a range of files and moves the whole selection at once', async () => {
    const panel = page.locator('[data-testid="file-browser-panel"]');
    if (!await panel.isVisible()) {
      await page.locator('[data-testid="sidebar-file-browser-toggle"]').click();
      await panel.waitFor({ state: 'visible', timeout: 10_000 });
    }
    await mkdir(join(projectRoot, 'bulk'), { recursive: true });
    for (const name of ['m-1.txt', 'm-2.txt', 'm-3.txt']) {
      await writeFile(join(projectRoot, name), `${name}\n`);
    }
    await page.locator('button[title="Refresh"]').click();
    // The tree is virtualized and a previous case may have left it scrolled to the bottom.
    await page.locator('[data-testid="file-tree"]').hover();
    await page.mouse.wheel(0, -20_000);
    await waitForVisible(row(page, 'm-3.txt'));

    await row(page, 'm-1.txt').click();

    // A human never presses and releases on the exact same pixel. Playwright's `click()` does,
    // which is why a synthetic shift-click passes where a real one fails.
    const target = await row(page, 'm-3.txt').boundingBox();
    if (!target) throw new Error('m-3.txt has no box');
    await page.keyboard.down('Shift');
    await page.mouse.move(target.x + 40, target.y + target.height / 2);
    await page.mouse.down();
    await page.mouse.move(target.x + 43, target.y + target.height / 2 + 2);
    await page.mouse.up();
    await page.keyboard.up('Shift');

    // A real Chromium shift-click has to produce a contiguous range, not just move the focus ring.
    await expect.poll(() => page.locator('[data-file-path^="m-"][data-selected="true"]').count())
      .toBe(3);
    const selectedBackground = await row(page, 'm-2.txt')
      .evaluate((element) => getComputedStyle(element).backgroundColor);
    const unselectedBackground = await row(page, 'bulk')
      .evaluate((element) => getComputedStyle(element).backgroundColor);
    expect(selectedBackground).not.toBe(unselectedBackground);

    await page.keyboard.press('Meta+x');
    await row(page, 'bulk').click();
    await page.keyboard.press('Meta+v');

    await expect.poll(
      async () => ({
        destinations: (await readdir(join(projectRoot, 'bulk'))).sort(),
        sourcesRemoved: ['m-1.txt', 'm-2.txt', 'm-3.txt']
          .every((name) => !existsSync(join(projectRoot, name))),
      }),
      { timeout: 10_000 },
    ).toEqual({
      destinations: ['m-1.txt', 'm-2.txt', 'm-3.txt'],
      sourcesRemoved: true,
    });

    // And Cmd-Z puts every one of them back where it came from.
    await page.keyboard.press('Meta+z');
    await expect.poll(
      () => readdir(join(projectRoot, 'bulk')),
      { timeout: 10_000 },
    ).toEqual([]);
    expect(existsSync(join(projectRoot, 'm-2.txt'))).toBe(true);
  }, 30_000);

  it('extends a selection by shift-clicking after a file has been opened', async () => {
    const panel = page.locator('[data-testid="file-browser-panel"]');
    if (!await panel.isVisible()) {
      await page.locator('[data-testid="sidebar-file-browser-toggle"]').click();
      await panel.waitFor({ state: 'visible', timeout: 10_000 });
    }
    for (const name of ['s-1.txt', 's-2.txt', 's-3.txt']) {
      await writeFile(join(projectRoot, name), `${name}\n`);
    }
    await page.locator('button[title="Refresh"]').click();
    await page.locator('[data-testid="file-tree"]').hover();
    await page.mouse.wheel(0, -20_000);
    await waitForVisible(row(page, 's-3.txt'));

    // Open a file first, exactly as a user would before reaching for a range.
    await row(page, 's-1.txt').click();
    await waitForVisible(page.locator('[data-testid="file-viewer"] [title="s-1.txt"]'));

    // A hand travels across the row and jitters while the button is down.
    const target = await row(page, 's-3.txt').boundingBox();
    if (!target) throw new Error('s-3.txt has no box');
    const y = target.y + target.height / 2;
    await page.keyboard.down('Shift');
    await page.mouse.move(target.x + 20, y);
    await page.mouse.move(target.x + 60, y);
    await page.mouse.down();
    await page.mouse.move(target.x + 62, y + 1);
    await page.mouse.move(target.x + 64, y + 2);
    await page.mouse.up();
    await page.keyboard.up('Shift');

    await expect.poll(
      () => page.locator('[data-file-path^="s-"][data-selected="true"]').count(),
      { timeout: 5_000 },
    ).toBe(3);
  }, 30_000);

  it('cuts and pastes a file across folders entirely from the keyboard', async () => {
    const panel = page.locator('[data-testid="file-browser-panel"]');
    if (!await panel.isVisible()) {
      await page.locator('[data-testid="sidebar-file-browser-toggle"]').click();
      await panel.waitFor({ state: 'visible', timeout: 10_000 });
    }
    await page.locator('[data-testid="file-tree"]').hover();
    await page.mouse.wheel(0, -20_000);
    await waitForVisible(row(page, 'src'));
    if (await row(page, 'src').getAttribute('aria-expanded') === 'false') {
      await row(page, 'src').click();
    }
    await waitForVisible(row(page, 'src/nested'));
    if (await row(page, 'src/nested').getAttribute('aria-expanded') === 'false') {
      await row(page, 'src/nested').click();
    }
    await waitForVisible(row(page, 'src/nested/deep.ts'));

    const tree = page.getByRole('tree', { name: /Files in / });
    await tree.focus();
    await row(page, 'src/nested/deep.ts').click();
    await expect.poll(() => row(page, 'src/nested/deep.ts').getAttribute('aria-selected')).toBe('true');
    await page.keyboard.press('Meta+x');
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('ArrowUp');
    await expect.poll(() => row(page, 'src').getAttribute('aria-selected')).toBe('true');
    await page.keyboard.press('Meta+v');

    await waitForVisible(row(page, 'src/deep.ts'));
    await expect.poll(() => row(page, 'src/nested/deep.ts').count(), { timeout: 10_000 }).toBe(0);
    expect(existsSync(join(projectRoot, 'src', 'deep.ts'))).toBe(true);
    expect(existsSync(join(projectRoot, 'src', 'nested', 'deep.ts'))).toBe(false);
  }, 30_000);

  it('mounts the CodeMirror editor when editing a markdown file', async () => {
    const consoleErrors: string[] = [];
    const onConsole = (message: { type: () => string; text: () => string }) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    };
    page.on('console', onConsole);

    await page.locator('[data-testid="file-tree"]').hover();
    await page.mouse.wheel(0, -20_000);
    await waitForVisible(row(page, 'README.md'));
    await row(page, 'README.md').click();
    await waitForVisible(page.locator('[data-testid="file-viewer"] [title="README.md"]'));

    await page.locator('button[aria-label="Edit markdown"]').click();
    await waitForVisible(page.locator('[data-testid="file-viewer"] .cm-editor .cm-content'));

    expect(await page.getByText('Main view unavailable').count()).toBe(0);
    expect(consoleErrors.join('\n')).not.toContain('tags');
    page.off('console', onConsole);
  }, 30_000);

  it('autosaves editor text without reporting its own filesystem change as a conflict', async () => {
    const nextContent = '# Edited in Amux\n\nAutosave remains conflict-free.\n';
    const editor = page.locator('[data-testid="file-viewer"] .cm-editor .cm-content');

    await editor.fill(nextContent);

    await expect.poll(
      () => readFile(join(projectRoot, 'README.md'), 'utf8'),
      { timeout: 10_000 },
    ).toBe(nextContent);
    await page.waitForTimeout(300);

    expect(await page.getByText('File changed', { exact: true }).count()).toBe(0);
    expect(
      await page.getByText('File was modified on disk. Reload from disk to discard local edits.').count(),
    ).toBe(0);
    expect(await editor.textContent()).toContain('Autosave remains conflict-free.');
  }, 30_000);

  it('flushes an edit made immediately before the active file tab closes', async () => {
    const nextContent = '# Saved on close\n\nNo debounce-window data loss.\n';
    const editor = page.locator('[data-testid="file-viewer"] .cm-editor .cm-content');

    await editor.fill(nextContent);
    await page.locator('[data-testid="file-tab-close"][title="Close README.md"]').click();

    await expect.poll(
      () => readFile(join(projectRoot, 'README.md'), 'utf8'),
      { timeout: 10_000 },
    ).toBe(nextContent);
    await expect.poll(
      () => page.getByRole('tab', { name: 'README.md' }).count(),
      { timeout: 10_000 },
    ).toBe(0);

    await row(page, 'README.md').click();
    await waitForVisible(page.locator('[data-testid="file-viewer"] [title="README.md"]'));
    await page.locator('button[aria-label="Edit markdown"]').click();
    await waitForVisible(editor);
  }, 30_000);

  it('protects a dirty draft from a real external edit and lets the user reload it', async () => {
    const editor = page.locator('[data-testid="file-viewer"] .cm-editor .cm-content');
    const externalContent = '# External edit\n\nReloaded safely.\n';

    await editor.fill('# Unsaved local draft\n');
    await writeFile(join(projectRoot, 'README.md'), externalContent);
    await waitForVisible(page.getByText('File changed', { exact: true }));

    const reload = page.getByRole('button', { name: 'Discard local edits and reload from disk' });
    await waitForVisible(reload);
    await reload.click();

    await expect.poll(() => editor.textContent(), { timeout: 10_000 }).toContain('Reloaded safely.');
    expect(await page.getByText('File changed', { exact: true }).count()).toBe(0);
    expect(await readFile(join(projectRoot, 'README.md'), 'utf8')).toBe(externalContent);
  }, 30_000);

  it('recovers a dirty draft when a deleted file is recreated with matching content', async () => {
    const editor = page.locator('[data-testid="file-viewer"] .cm-editor .cm-content');
    const localDraft = '# Recreated file\n\nThe local draft survived.\n';
    const filePath = join(projectRoot, 'README.md');

    await editor.fill(localDraft);
    await page.evaluate((channel) => {
      const e2eWindow = window as unknown as E2EWindow;
      e2eWindow.__fileChangedEvents = [];
      e2eWindow.aumx?.on(channel, (event) => {
        e2eWindow.__fileChangedEvents?.push(event);
      });
    }, IPC_EVENT.FILE_CHANGED);
    await rm(filePath);
    await expect.poll(
      () => page.evaluate(() => (
        (window as unknown as E2EWindow).__fileChangedEvents
          ?.some((event) => event.changeType === 'unlink' && event.relativePath === 'README.md')
      )),
      { intervals: [10], timeout: 250 },
    ).toBe(true);
    await writeFile(filePath, localDraft);

    await expect.poll(
      () => page.evaluate(() => (
        (window as unknown as E2EWindow).__fileChangedEvents
          ?.some((event) => event.changeType === 'add' && event.relativePath === 'README.md')
      )),
      { timeout: 10_000 },
    ).toBe(true);
    await page.waitForTimeout(400);
    await expect.poll(
      () => page.getByText('File deleted', { exact: true }).count(),
      { timeout: 10_000 },
    ).toBe(0);
    expect(
      await page.getByText('File was deleted on disk. Local edits are preserved.').count(),
    ).toBe(0);
    expect(await editor.textContent()).toContain('The local draft survived.');
    expect(await readFile(filePath, 'utf8')).toBe(localDraft);
  }, 30_000);

  it('recreates a genuinely deleted file from the preserved local draft', async () => {
    const editor = page.locator('[data-testid="file-viewer"] .cm-editor .cm-content');
    const localDraft = '# Restore deleted file\n\nKeep this local work.\n';
    const filePath = join(projectRoot, 'README.md');

    await editor.fill(localDraft);
    await rm(filePath);
    await waitForVisible(page.getByText('File deleted', { exact: true }));

    await page.getByRole('button', { name: 'Recreate file from local edits' }).click();

    await expect.poll(() => readFile(filePath, 'utf8'), { timeout: 10_000 }).toBe(localDraft);
    expect(await page.getByText('File deleted', { exact: true }).count()).toBe(0);
    expect(await editor.textContent()).toContain('Keep this local work.');
  }, 30_000);

  it('flushes the active draft before the reload menu action and its keyboard shortcut', async () => {
    const editor = page.locator('[data-testid="file-viewer"] .cm-editor .cm-content');
    const nextContent = '# Saved before reload\n\nCmd-R cannot discard this edit.\n';
    const filePath = join(projectRoot, 'README.md');

    await editor.fill(nextContent);
    const accelerator = await app.evaluate(({ BrowserWindow, Menu }) => {
      const viewMenu = Menu.getApplicationMenu()?.items.find((item) => item.label === 'View');
      const reloadItem = viewMenu?.submenu?.items.find((item) => item.label === 'Reload');
      if (!reloadItem?.click) {
        throw new Error('Reload menu action is unavailable');
      }
      const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
      reloadItem.click(reloadItem, window, { triggeredByAccelerator: true });
      return reloadItem.accelerator;
    });

    await expect.poll(
      () => readFile(filePath, 'utf8'),
      { timeout: 10_000 },
    ).toBe(nextContent);
    expect(accelerator).toBe('CmdOrCtrl+R');
    await page.waitForSelector('[data-testid="app-shell"]', { timeout: 15_000 });
  }, 30_000);

  it('formats TypeScript explicitly and activates the native language server on demand', async () => {
    await installPane(page, projectRoot);
    const panel = page.locator('[data-testid="file-browser-panel"]');
    if (!await panel.isVisible()) {
      await page.locator('[data-testid="sidebar-file-browser-toggle"]').click();
      await waitForVisible(panel);
    }
    await page.locator('[data-testid="file-tree"]').hover();
    await page.mouse.wheel(0, -20_000);
    await waitForVisible(row(page, 'src'));
    if (await row(page, 'src').getAttribute('aria-expanded') === 'false') await row(page, 'src').click();
    await waitForVisible(row(page, 'src/index.ts'));
    await row(page, 'src/index.ts').click();

    const editor = page.locator('[data-testid="file-viewer"] .cm-editor .cm-content');
    await waitForVisible(editor);
    await editor.fill('export const value={answer:42}\n');

    await waitForVisible(page.getByText('TS: ready', { exact: true }), 15_000);
    await editor.fill('export const value: number = "wrong";\n');
    await expect.poll(
      () => page.locator('[data-testid="file-viewer"] .cm-lintRange-error').count(),
      { timeout: 10_000 },
    ).toBeGreaterThan(0);
    await editor.fill('export const value={answer:42}\n');
    await page.getByRole('button', { name: 'Format document' }).click();
    await expect.poll(() => editor.textContent(), { timeout: 10_000 }).toContain('value = { answer: 42 }');
    await expect.poll(
      () => readFile(join(projectRoot, 'src', 'index.ts'), 'utf8'),
      { timeout: 10_000 },
    ).toBe('export const value = { answer: 42 };\n');
  }, 30_000);

  it('drags a multi-file selection onto a folder with a real mouse gesture', async () => {
    const panel = page.locator('[data-testid="file-browser-panel"]');
    if (!await panel.isVisible()) {
      await page.locator('[data-testid="sidebar-file-browser-toggle"]').click();
      await waitForVisible(panel);
    }
    await mkdir(join(projectRoot, 'haul'), { recursive: true });
    for (const name of ['d-1.txt', 'd-2.txt', 'd-3.txt']) {
      await writeFile(join(projectRoot, name), `${name}\n`);
    }
    await page.locator('button[title="Refresh"]').click();
    await page.locator('[data-testid="file-tree"]').hover();
    await page.mouse.wheel(0, -20_000);
    await waitForVisible(row(page, 'd-3.txt'));

    await row(page, 'd-1.txt').click();
    await row(page, 'd-3.txt').click({ modifiers: ['Shift'] });
    await expect.poll(() => page.locator('[data-file-path^="d-"][data-selected="true"]').count()).toBe(3);

    const source = await row(page, 'd-2.txt').boundingBox();
    const folder = await row(page, 'haul').boundingBox();
    if (!source || !folder) throw new Error('missing drag boxes');
    await page.mouse.move(source.x + 60, source.y + source.height / 2);
    await page.mouse.down();
    for (let step = 1; step <= 8; step += 1) {
      await page.mouse.move(
        source.x + 60 + ((folder.x - source.x) * step) / 8,
        source.y + source.height / 2 + ((folder.y - source.y) * step) / 8,
      );
    }
    await page.mouse.up();

    await expect.poll(
      async () => ({
        destinations: (await readdir(join(projectRoot, 'haul'))).sort(),
        sourcesRemoved: ['d-1.txt', 'd-2.txt', 'd-3.txt']
          .every((name) => !existsSync(join(projectRoot, name))),
      }),
      { timeout: 10_000 },
    ).toEqual({
      destinations: ['d-1.txt', 'd-2.txt', 'd-3.txt'],
      sourcesRemoved: true,
    });
  }, 30_000);
});
