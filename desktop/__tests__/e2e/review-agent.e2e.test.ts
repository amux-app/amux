import { execSync } from 'child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { resolve } from 'path';
import type { ConsoleMessage, ElectronApplication, Page } from 'playwright';
import { _electron as electron } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AumxPane } from 'aumx/core';
import type { PaneSendFixResponse } from '../../src/shared/ipc-types';
import {
  closePaneBestEffort,
  getAppWindow,
  getPanes,
  getSessionInfo,
  getSystemCheck,
  pollUntil,
} from './e2e-helpers';

const ROOT = resolve(__dirname, '..', '..');
const MAIN_ENTRY = resolve(ROOT, 'out', 'main', 'index.js');
const PANE_CREATION_TIMEOUT = 20_000;
const REVIEW_CREATION_TIMEOUT = 30_000;
const SOURCE_PROMPT = 'Add a one-line code comment to README — do not change behavior.';

async function createSourcePane(page: Page, projectRoot: string): Promise<AumxPane> {
  const response = await page.evaluate(
    (payload) =>
      (window as any).aumx.invoke('pane:create', {
        prompt: payload.prompt,
        agent: 'claude',
        projectRoot: payload.projectRoot,
        useWorktree: true,
      }),
    { prompt: SOURCE_PROMPT, projectRoot },
  );
  if (!response?.success || !response?.pane) {
    throw new Error(`pane:create failed: ${response?.error ?? 'unknown error'}`);
  }
  return response.pane as AumxPane;
}

/**
 * Pin a pane's agentStatus to 'idle' and keep it there: the live agent monitor
 * keeps overwriting status while the real agent runs, which would flip `canReview`
 * /`canSendFixes` false mid-interaction. A Zustand subscription re-clamps it.
 */
async function lockPaneIdle(page: Page, paneId: string): Promise<void> {
  await page.evaluate((id) => {
    const paneStore = (window as any).__aumxStores?.pane;
    if (!paneStore) return;
    const w = window as any;
    w.__reviewIdleLockActive = true;
    let fixing = false;
    const clamp = (state: any) => {
      if (fixing || !w.__reviewIdleLockActive) return;
      const broken = state.panes.some((p: any) => p.id === id && p.agentStatus !== 'idle');
      if (!broken) return;
      fixing = true;
      paneStore.setState({
        panes: state.panes.map((p: any) => (p.id === id ? { ...p, agentStatus: 'idle' } : p)),
      });
      fixing = false;
    };
    w.__reviewIdleLockUnsub = paneStore.subscribe(clamp);
    clamp(paneStore.getState());
  }, paneId);
}

async function releaseIdleLock(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as any;
    w.__reviewIdleLockActive = false;
    if (typeof w.__reviewIdleLockUnsub === 'function') w.__reviewIdleLockUnsub();
    delete w.__reviewIdleLockUnsub;
    delete w.__reviewIdleLockActive;
  });
}

async function navigateToFleetView(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as any).__aumxStores?.ui?.setState?.({ viewMode: 'fleet', focusPaneId: null });
  });
  await page.locator('aside').waitFor({ state: 'visible', timeout: 5_000 });
}

describe.runIf(process.env.AUMX_E2E === '1')('Review Agent E2E', () => {
  let app: ElectronApplication;
  let page: Page;
  let e2eRoot: string;
  const consoleErrors: string[] = [];
  const launchedPanes: Array<{ id: string; paneId: string }> = [];

  beforeAll(async () => {
    expect(existsSync(MAIN_ENTRY), `Build output missing: ${MAIN_ENTRY}`).toBe(true);

    try {
      const sessions = execSync('tmux list-sessions -F "#{session_name}" 2>/dev/null', { encoding: 'utf-8' });
      for (const name of sessions.split('\n').filter((s) => s.includes('aumx-review-e2e'))) {
        execSync(`tmux kill-session -t "${name}" 2>/dev/null`, { stdio: 'ignore' });
      }
    } catch { /* no tmux server or no sessions — fine */ }

    e2eRoot = realpathSync(mkdtempSync(resolve(tmpdir(), 'aumx-review-e2e-')));
    execSync('git init', { cwd: e2eRoot, stdio: 'ignore' });
    execSync('git config user.email "e2e@aumx.test"', { cwd: e2eRoot, stdio: 'ignore' });
    execSync('git config user.name "aumx-e2e"', { cwd: e2eRoot, stdio: 'ignore' });
    writeFileSync(resolve(e2eRoot, '.gitignore'), '.amux/\n.aumx/\n');
    writeFileSync(resolve(e2eRoot, 'README.md'), '# E2E review workspace\n');
    execSync('git add .', { cwd: e2eRoot, stdio: 'ignore' });
    execSync('git commit -m "chore: review e2e workspace"', { cwd: e2eRoot, stdio: 'ignore' });

    const inheritedEnv = Object.fromEntries(
      Object.entries(process.env).filter(([k]) => k !== 'CLAUDECODE'),
    );
    app = await electron.launch({
      args: [MAIN_ENTRY],
      cwd: e2eRoot,
      env: { ...inheritedEnv, NODE_ENV: 'test', AUMX_DEV: 'true' },
    });

    page = await getAppWindow(app);
    await app.context().addInitScript(() => {
      (window as any).__AUMX_E2E = true;
    });
    await page.reload();
    page.on('console', (msg: ConsoleMessage) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });

    await page.waitForSelector('[data-testid="app-shell"]', { timeout: 15_000 });
    await page.setViewportSize({ width: 1400, height: 900 });
    await page.locator('aside').waitFor({ state: 'visible', timeout: 10_000 });

    const systemCheck = await getSystemCheck(page);
    if (!systemCheck?.agents?.includes('claude')) {
      throw new Error(`SKIP: Claude agent not found. Available: ${JSON.stringify(systemCheck?.agents ?? [])}`);
    }

    const sessionInfo = await getSessionInfo(page);
    expect(sessionInfo?.projectRoot).toBe(e2eRoot);

    await page.evaluate(() =>
      (window as any).aumx.invoke('electron-settings:update', { key: 'enableReviewAgent', value: true }),
    );
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
    if (app) await app.close();
    if (e2eRoot) rmSync(e2eRoot, { recursive: true, force: true });
  }, 60_000);

  it('launches an isolated read-only review pane with a seeded rubric', async () => {
    const source = await createSourcePane(page, e2eRoot);
    launchedPanes.push({ id: source.id, paneId: source.paneId });

    await pollUntil(
      async () => (await getPanes(page)).find((p) => p.id === source.id) ?? null,
      { timeout: PANE_CREATION_TIMEOUT, interval: 500, label: 'waitForSourcePane' },
    );

    await navigateToFleetView(page);
    await lockPaneIdle(page, source.id);

    const reviewTrigger = page.locator('button[aria-label="Start review"]').first();
    await reviewTrigger.waitFor({ state: 'visible', timeout: 10_000 });
    await reviewTrigger.click();

    const startButton = page.locator('button:has-text("Start Review")').first();
    await startButton.waitFor({ state: 'visible', timeout: 10_000 });
    await pollUntil(
      async () => startButton.isEnabled(),
      { timeout: 10_000, interval: 500, label: 'waitForStartEnabled' },
    );
    await startButton.click();

    const reviewPane = await pollUntil(
      async () =>
        (await getPanes(page)).find(
          (p) => p.role === 'review' && p.review?.sourcePaneId === source.id,
        ) ?? null,
      { timeout: REVIEW_CREATION_TIMEOUT, interval: 1_000, label: 'waitForReviewPane' },
    );
    launchedPanes.push({ id: reviewPane.id, paneId: reviewPane.paneId });
    await releaseIdleLock(page);

    // Independent worktree — the source pane's files are never touched.
    expect(reviewPane.worktreePath).toBeTruthy();
    expect(reviewPane.worktreePath).not.toBe(source.worktreePath);
    expect(reviewPane.review?.reviewId).toBeTruthy();

    // The rubric is seeded into the review worktree before the agent launches, so the
    // reviewer reads its contract from a file rather than a terminal dump.
    const rubricPath = resolve(reviewPane.worktreePath as string, '.amux', 'review', 'REVIEW.md');
    await pollUntil(
      async () => existsSync(rubricPath),
      { timeout: 10_000, interval: 500, label: 'waitForSeededRubric' },
    );
    const rubric = readFileSync(rubricPath, 'utf-8');
    expect(rubric).toContain('Do NOT edit');
    expect(rubric).toContain('Only report a finding when it satisfies ALL');
    expect(rubric).toContain('git diff');
  }, 90_000);

  it('gates Send-fixes durably and wires the handoff to the backend', async () => {
    const reviewPane = (await getPanes(page)).find((p) => p.role === 'review');
    expect(reviewPane, 'review pane from the previous test should still exist').toBeTruthy();
    const review = reviewPane as AumxPane;

    // Durable gating: the Send-fixes action is available whenever the review pane is
    // idle — it does NOT depend on transient justFinished state.
    await navigateToFleetView(page);
    await lockPaneIdle(page, review.id);
    const sendFixes = page.locator('button[aria-label="Open send fixes dialog"]').first();
    await sendFixes.waitFor({ state: 'visible', timeout: 10_000 });

    // The handoff path is wired end-to-end; without a finished reviewer it returns the
    // well-defined "no findings yet" guard rather than throwing.
    const response = await page.evaluate(
      (id) => (window as any).aumx.invoke('pane:send-fix', { reviewPaneId: id }) as Promise<PaneSendFixResponse>,
      review.id,
    );
    expect(response.success).toBe(false);
    expect(response.error).toBe('No review findings to send yet');
    await releaseIdleLock(page);
  }, 60_000);
});
