import { execFileSync, execSync } from 'child_process';
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { basename, resolve } from 'path';
import type { ConsoleMessage, ElectronApplication, Locator, Page } from 'playwright';
import { _electron as electron } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MuxBasePane } from 'muxbase/core';
import {
  closeElectronApp,
  closePaneBestEffort,
  getAppWindow,
  getPanes,
  getSessionInfo,
  getSystemCheck,
  pollUntil,
} from './e2e-helpers';

const ROOT = resolve(__dirname, '..', '..');
const MAIN_ENTRY = resolve(ROOT, 'out', 'main', 'index.js');
const DUEL_PROMPT = 'List the files in this repo';
const DUEL_CREATION_TIMEOUT = 40_000;
const DIALOG_TIMEOUT = 8_000;

interface UiStoreState {
  viewMode: string;
  duelGroupId: string | null;
  focusPaneId: string | null;
}

/**
 * The demo harness paints a full-viewport `#__e2e_overlay` that blocks pointer
 * events. This test never paints one, but the convention is to strip it before
 * any click so a stray overlay from a previous run can't swallow the interaction.
 */
async function hideOverlay(page: Page): Promise<void> {
  await page.evaluate(() => document.getElementById('__e2e_overlay')?.remove());
}

async function getUiState(page: Page): Promise<UiStoreState> {
  return page.evaluate(() => {
    const store = (window as unknown as { __muxbaseStores?: { ui?: { getState: () => UiStoreState } } }).__muxbaseStores?.ui;
    const s = store?.getState();
    return { viewMode: s?.viewMode ?? '', duelGroupId: s?.duelGroupId ?? null, focusPaneId: s?.focusPaneId ?? null };
  }) as Promise<UiStoreState>;
}

async function openCreateDialog(page: Page): Promise<Locator> {
  await hideOverlay(page);
  // The sidebar nav row is the primary entry point; the older labels stay as fallbacks.
  const openers = [
    page.getByTestId('sidebar-new-agent').first(),
    page.getByTestId('titlebar-new-agent').first(),
    page.locator('button[aria-label="New pane"]').first(),
    page.locator('button[aria-label="Create new pane"]').first(),
  ];
  let opened = false;
  for (const opener of openers) {
    if (await opener.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await opener.click();
      opened = true;
      break;
    }
  }
  if (!opened) await page.keyboard.press('Meta+N').catch(() => {});
  await page.waitForSelector('[role="dialog"]', { timeout: DIALOG_TIMEOUT });
  return page.locator('[role="dialog"]').last();
}

async function setAppContentSize(
  app: ElectronApplication,
  page: Page,
  size: { height: number; width: number },
): Promise<void> {
  const actual = await app.evaluate(({ BrowserWindow }, requestedSize) => {
    const win = BrowserWindow.getAllWindows()
      .find((candidate) => !candidate.webContents.getURL().startsWith('devtools://'));
    if (!win) return null;
    win.setContentSize(requestedSize.width, requestedSize.height);
    return win.getContentSize();
  }, size);
  if (!actual || actual[0] !== size.width || actual[1] !== size.height) {
    throw new Error(
      `Unable to resize Electron content to ${size.width}x${size.height}; `
      + `received ${actual ? `${actual[0]}x${actual[1]}` : 'no application window'}`,
    );
  }
  await page.waitForFunction(
    (requestedSize) => (
      window.innerWidth === requestedSize.width && window.innerHeight === requestedSize.height
    ),
    size,
  );
  await page.evaluate(() => new Promise<void>((resolveFrame) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolveFrame()));
  }));
}

/**
 * Side B defaults to Side A's agent, so the two sides start identical and the
 * "Start duel" button is disabled by the identical-sides guard. Both sides
 * render Model + Effort dropdowns in A-then-B order, so the second Effort
 * dropdown belongs to Side B. Picking a distinct effort there makes the tuple
 * differ without depending on a second agent binary being installed.
 */
async function differentiateSideBEffort(dialog: Locator): Promise<void> {
  const effortTrigger = dialog.locator('button[aria-label="Effort"]').nth(1);
  await effortTrigger.waitFor({ state: 'visible', timeout: 5_000 });
  await effortTrigger.click();
  const option = dialog.page().locator('[role="option"]:has-text("High")').first();
  await option.waitFor({ state: 'visible', timeout: 5_000 });
  await option.click();
}

async function findDuelPanes(page: Page): Promise<{ paneA: MuxBasePane; paneB: MuxBasePane } | null> {
  const panes = await getPanes(page);
  const paneA = panes.find((p) => p.duel?.role === 'a' && p.slug?.endsWith('-a'));
  const paneB = panes.find((p) => p.duel?.role === 'b' && p.slug?.endsWith('-b'));
  return paneA && paneB ? { paneA, paneB } : null;
}

describe.runIf(process.env.MUXBASE_E2E === '1')('Duel E2E', () => {
  let app: ElectronApplication;
  let page: Page;
  let e2eRoot: string;
  const consoleErrors: string[] = [];
  const launchedPanes: Array<{ id: string; paneId: string }> = [];

  beforeAll(async () => {
    expect(existsSync(MAIN_ENTRY), `Build output missing: ${MAIN_ENTRY}`).toBe(true);

    try {
      const sessions = execSync('tmux list-sessions -F "#{session_name}" 2>/dev/null', { encoding: 'utf-8' });
      for (const name of sessions.split('\n').filter((s) => s.includes('muxbase-duel-e2e'))) {
        execSync(`tmux kill-session -t "${name}" 2>/dev/null`, { stdio: 'ignore' });
      }
    } catch { /* no tmux server or no sessions — fine */ }

    e2eRoot = realpathSync(mkdtempSync(resolve(tmpdir(), 'muxbase-duel-e2e-')));
    execSync('git init', { cwd: e2eRoot, stdio: 'ignore' });
    execSync('git config user.email "e2e@muxbase.test"', { cwd: e2eRoot, stdio: 'ignore' });
    execSync('git config user.name "muxbase-e2e"', { cwd: e2eRoot, stdio: 'ignore' });
    writeFileSync(resolve(e2eRoot, '.gitignore'), '.muxbase/\n');
    writeFileSync(resolve(e2eRoot, 'README.md'), '# E2E duel workspace\n');
    execSync('git add .', { cwd: e2eRoot, stdio: 'ignore' });
    execSync('git commit -m "chore: duel e2e workspace"', { cwd: e2eRoot, stdio: 'ignore' });

    const inheritedEnv = Object.fromEntries(
      Object.entries(process.env).filter(([k]) => k !== 'CLAUDECODE'),
    );
    app = await electron.launch({
      args: [MAIN_ENTRY],
      cwd: e2eRoot,
      env: { ...inheritedEnv, NODE_ENV: 'test', MUXBASE_DEV: 'true', MUXBASE_E2E: '1' },
    });

    page = await getAppWindow(app);
    await app.context().addInitScript(() => {
      (window as unknown as { __MUXBASE_E2E?: boolean }).__MUXBASE_E2E = true;
    });
    await page.reload();
    page.on('console', (msg: ConsoleMessage) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });

    await page.waitForSelector('[data-testid="app-shell"]', { timeout: 15_000 });
    await setAppContentSize(app, page, { width: 1600, height: 950 });
    await page.locator('aside').waitFor({ state: 'visible', timeout: 10_000 });

    const systemCheck = await getSystemCheck(page);
    if (!systemCheck?.agents?.includes('claude')) {
      throw new Error(`SKIP: Claude agent not found. Available: ${JSON.stringify(systemCheck?.agents ?? [])}`);
    }

    const sessionInfo = await getSessionInfo(page);
    expect(sessionInfo?.projectRoot).toBe(e2eRoot);
  }, 60_000);

  afterAll(async () => {
    if (page) {
      for (const pane of launchedPanes) {
        await closePaneBestEffort(page, pane);
      }
      await pollUntil(
        async () => {
          const remaining = await getPanes(page);
          return remaining.every((p) => !launchedPanes.some((c) => c.id === p.id));
        },
        { timeout: 8_000, interval: 1_000, label: 'cleanup-settle' },
      ).catch(() => {});
    }
    if (app) await closeElectronApp(app);
    if (e2eRoot) {
      try {
        execSync(`tmux kill-session -t "muxbase-${basename(e2eRoot)}" 2>/dev/null`, { stdio: 'ignore' });
      } catch { /* session already gone */ }
      rmSync(e2eRoot, { recursive: true, force: true });
    }
  }, 60_000);

  it('starts a duel from the dialog and links two sibling panes', async () => {
    const dialog = await openCreateDialog(page);

    // Phase 2: switch to Duel mode — prompt textarea appears; submit is gated on it.
    await dialog.locator('[role="tab"]:has-text("Duel")').click();
    const promptBox = dialog.locator('textarea').first();
    await promptBox.waitFor({ state: 'visible', timeout: 5_000 });
    const startButton = dialog.locator('button:has-text("Start duel")').first();
    await startButton.waitFor({ state: 'visible', timeout: 5_000 });
    expect(await startButton.isEnabled()).toBe(false);

    // The Electron window supports 800x600, so the expanded Duel form must
    // remain fully contained and scrollable at that minimum size.
    await setAppContentSize(app, page, { width: 800, height: 600 });
    await expect.poll(async () => {
      const bounds = await dialog.boundingBox();
      return {
        bounds,
        contained: bounds !== null && bounds.y >= 0 && bounds.y + bounds.height <= 600,
      };
    }, { timeout: 10_000 }).toMatchObject({ contained: true });
    expect(await dialog.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
    await setAppContentSize(app, page, { width: 1600, height: 950 });

    // Phase 3: isolate both candidates in real worktrees, fill the shared
    // prompt, and make the two sides differ.
    const worktreeToggle = dialog.getByRole('switch', { name: 'Use Git Worktree' });
    if (await worktreeToggle.getAttribute('aria-checked') !== 'true') {
      await worktreeToggle.click();
    }
    await promptBox.fill(DUEL_PROMPT);
    await differentiateSideBEffort(dialog);
    await pollUntil(
      async () => startButton.isEnabled(),
      { timeout: 8_000, interval: 300, label: 'waitForStartEnabled' },
    );

    // Phase 4: submit and wait for both sibling panes in the store.
    await startButton.click();
    await pollUntil(
      async () => {
        const dialogs = page.locator('[role="dialog"]:visible');
        const count = await dialogs.count();
        if (count > 1) {
          throw new Error(`Duel creation opened an error dialog: ${(await dialogs.allTextContents()).join(' | ')}`);
        }
        return count === 0 ? true : null;
      },
      { timeout: DUEL_CREATION_TIMEOUT, interval: 500, label: 'waitForDuelDialogClose' },
    );

    const { paneA, paneB } = await pollUntil(
      async () => findDuelPanes(page),
      { timeout: DUEL_CREATION_TIMEOUT, interval: 1_000, label: 'waitForDuelPanes' },
    );
    launchedPanes.push({ id: paneA.id, paneId: paneA.paneId });
    launchedPanes.push({ id: paneB.id, paneId: paneB.paneId });

    // Same group, cross-linked siblings, shared prompt, distinct roles.
    expect(paneA.duel?.groupId).toBe(paneB.duel?.groupId);
    expect(paneA.duel?.role).toBe('a');
    expect(paneB.duel?.role).toBe('b');
    expect(paneA.duel?.prompt).toBe(DUEL_PROMPT);
    expect(paneB.duel?.prompt).toBe(DUEL_PROMPT);
    expect(paneB.duel?.siblingPaneId).toBe(paneA.id);
    expect(paneA.duel?.siblingPaneId).toBe(paneB.id);
    expect(paneA.worktreePath && existsSync(paneA.worktreePath)).toBe(true);
    expect(paneB.worktreePath && existsSync(paneB.worktreePath)).toBe(true);
  }, 90_000);

  it('opens the duel view from the fleet VS chip and returns on Escape', async () => {
    await hideOverlay(page);

    // Phase 5: the fleet grid pairs the siblings with a VS chip; clicking it opens the duel.
    const vsChip = page.locator('[data-testid="fleet-duel-vs-chip"]').first();
    await vsChip.waitFor({ state: 'visible', timeout: 15_000 });
    await vsChip.click();

    await pollUntil(
      async () => (await getUiState(page)).viewMode === 'duel',
      { timeout: 8_000, interval: 300, label: 'waitForDuelView' },
    );

    // DuelView renders the shared prompt and both terminals side by side.
    await page.locator(`text=${DUEL_PROMPT}`).first().waitFor({ state: 'visible', timeout: 8_000 });
    await pollUntil(
      async () => (await page.locator('[data-testid="interactive-terminal"]').count()) >= 2,
      { timeout: 15_000, interval: 500, label: 'waitForTwoTerminals' },
    );

    // Phase 6: Escape returns to the fleet.
    await page.keyboard.press('Escape');
    await pollUntil(
      async () => (await getUiState(page)).viewMode === 'fleet',
      { timeout: 8_000, interval: 300, label: 'waitForFleetReturn' },
    );
  }, 60_000);

  it('declares a winner, closes the loser, and focuses the survivor', async () => {
    await hideOverlay(page);
    const before = await findDuelPanes(page);
    expect(before, 'duel panes from earlier phases should still exist').not.toBeNull();
    const { paneA, paneB } = before as { paneA: MuxBasePane; paneB: MuxBasePane };

    // Phase 7: re-open the duel via the VS chip, then declare Side A the winner.
    await page.locator('[data-testid="fleet-duel-vs-chip"]').first().click();
    await pollUntil(
      async () => (await getUiState(page)).viewMode === 'duel',
      { timeout: 8_000, interval: 300, label: 'waitForDuelViewAgain' },
    );

    await page.locator(`button[aria-label="Declare ${paneLabel(paneA)} the winner"]`).first().click();

    // The shared ConfirmDialog asks to keep the winner and close the loser.
    const confirm = page.locator('button:has-text("Keep winner")').first();
    await confirm.waitFor({ state: 'visible', timeout: 8_000 });
    await confirm.click();

    // Phase 8: loser removed; winner survives with duel metadata cleared; focus lands on the winner.
    await pollUntil(
      async () => {
        const panes = await getPanes(page);
        return panes.every((p) => p.id !== paneB.id);
      },
      { timeout: 20_000, interval: 1_000, label: 'waitForLoserRemoved' },
    );

    const survivor = await pollUntil(
      async () => {
        const winner = (await getPanes(page)).find((p) => p.id === paneA.id);
        return winner && winner.duel === undefined ? winner : null;
      },
      { timeout: 8_000, interval: 500, label: 'waitForWinnerDuelCleared' },
    );
    expect(survivor.duel).toBeUndefined();

    await pollUntil(
      async () => {
        const ui = await getUiState(page);
        return ui.viewMode === 'focus' && ui.focusPaneId === paneA.id;
      },
      { timeout: 8_000, interval: 300, label: 'waitForWinnerFocused' },
    );

    // The loser's tracking entry is done — drop it so teardown only closes the survivor.
    const idx = launchedPanes.findIndex((p) => p.id === paneB.id);
    if (idx >= 0) launchedPanes.splice(idx, 1);

    // Winner resolution promises destructive loser cleanup. Verify both the
    // worktree and its branch disappear, not only the renderer pane.
    expect(paneB.worktreePath).toBeTruthy();
    await pollUntil(
      async () => !existsSync(paneB.worktreePath!),
      { timeout: 20_000, interval: 500, label: 'waitForLoserWorktreeCleanup' },
    );
    const loserBranch = paneB.branchName ?? paneB.slug;
    await pollUntil(
      async () => {
        try {
          execFileSync('git', ['show-ref', '--verify', '--quiet', `refs/heads/${loserBranch}`], {
            cwd: e2eRoot,
            stdio: 'ignore',
          });
          return false;
        } catch {
          return true;
        }
      },
      { timeout: 20_000, interval: 500, label: 'waitForLoserBranchCleanup' },
    );

    expect(consoleErrors.join('\n')).not.toMatch(/duel/i);
  }, 60_000);
});

function paneLabel(pane: MuxBasePane): string {
  return pane.title || pane.slug || pane.id;
}
