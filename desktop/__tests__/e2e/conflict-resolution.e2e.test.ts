import { execSync } from 'child_process';
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { resolve } from 'path';
import type { ElectronApplication, Page, ConsoleMessage } from 'playwright';
import { _electron as electron } from 'playwright';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { AumxPane } from 'aumx/core';
import type { SerializableActionResult } from '../../src/shared/ipc-types';
import {
  type PhaseResult,
  closePaneBestEffort,
  getAppWindow,
  getPanes,
  getSessionInfo,
  getSystemCheck,
  pollUntil,
} from './e2e-helpers';

const ROOT = resolve(__dirname, '..', '..');
const MAIN_ENTRY = resolve(ROOT, 'out', 'main', 'index.js');
const ACTIVE_AGENT_STATES = new Set(['working', 'analyzing', 'waiting']);
const SLOW = process.env.AUMX_E2E_SLOW === '1';
const STEP_PAUSE = SLOW ? 2500 : 0;
const VIEW_PAUSE = SLOW ? 4000 : 0;

async function pause(ms: number): Promise<void> {
  if (ms > 0) await new Promise((r) => setTimeout(r, ms));
}

async function showOverlay(page: Page, phase: number, title: string, detail?: string): Promise<void> {
  await page.evaluate(
    ({ phase: p, title: t, detail: d }) => {
      let el = document.getElementById('__e2e_overlay');
      if (!el) {
        el = document.createElement('div');
        el.id = '__e2e_overlay';
        document.body.appendChild(el);
      }
      el.style.pointerEvents = 'none';
      el.innerHTML = `
        <div style="
          position:fixed;bottom:24px;right:24px;z-index:99999;
          min-width:360px;max-width:480px;
          padding:22px 26px;
          background:rgba(0,0,0,0.75);backdrop-filter:blur(12px);
          border:1px solid rgba(167,139,250,0.3);border-radius:16px;
          font-family:-apple-system,BlinkMacSystemFont,'Inter',sans-serif;
          animation:__e2e_slide 0.35s cubic-bezier(0.16,1,0.3,1);
          pointer-events:none;
        ">
          <style>
            @keyframes __e2e_slide { from { opacity:0;transform:translateY(16px); } to { opacity:1;transform:translateY(0); } }
            @keyframes __e2e_pulse { 0%,100% { opacity:1;box-shadow:0 0 8px rgba(167,139,250,0.6); } 50% { opacity:0.4;box-shadow:none; } }
          </style>
          <div style="display:flex;align-items:center;gap:14px;margin-bottom:${d ? '10px' : '0'}">
            <span style="
              display:inline-flex;align-items:center;justify-content:center;
              width:36px;height:36px;border-radius:12px;
              background:linear-gradient(135deg,#7c3aed,#6366f1);
              box-shadow:0 4px 16px rgba(124,58,237,0.5);
              color:#fff;font-size:14px;font-weight:700;flex-shrink:0;
            ">${p}</span>
            <span style="
              color:#fff;font-size:16px;font-weight:600;
              letter-spacing:-0.01em;
              text-shadow:0 1px 8px rgba(0,0,0,0.8),0 0 20px rgba(0,0,0,0.5);
            ">${t}</span>
            <span style="
              margin-left:auto;width:8px;height:8px;border-radius:50%;
              background:#a78bfa;
              animation:__e2e_pulse 1.8s ease-in-out infinite;
              flex-shrink:0;
            "></span>
          </div>
          ${d ? `<div style="
            color:rgba(255,255,255,0.55);font-size:12px;line-height:1.5;margin-left:50px;
            text-shadow:0 1px 6px rgba(0,0,0,0.7);
          ">${d}</div>` : ''}
        </div>
      `;
    },
    { phase, title, detail },
  );
}

async function hideOverlay(page: Page): Promise<void> {
  await page.evaluate(() => {
    document.getElementById('__e2e_overlay')?.remove();
  });
}

async function highlightElement(page: Page, selector: string): Promise<void> {
  if (!SLOW) return;
  await page.evaluate((sel) => {
    const el = document.querySelector(sel) as HTMLElement | null;
    if (!el) return;
    const prev = el.style.cssText;
    el.style.boxShadow = '0 0 0 3px rgba(124,58,237,0.7), 0 0 20px rgba(124,58,237,0.4)';
    el.style.transition = 'box-shadow 0.3s ease';
    el.dataset.__e2ePrev = prev;
  }, selector);
  await pause(800);
}

async function unhighlightElement(page: Page, selector: string): Promise<void> {
  if (!SLOW) return;
  await page.evaluate((sel) => {
    const el = document.querySelector(sel) as HTMLElement | null;
    if (!el) return;
    el.style.cssText = el.dataset.__e2ePrev ?? '';
    delete el.dataset.__e2ePrev;
  }, selector);
}

async function initializePaneStatusTracker(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as any;
    if (w.__aumxPaneStatusTrackerInitialized) {
      w.__aumxPaneStatusById = {};
      w.__aumxPaneStatusHistoryById = {};
      return;
    }
    w.__aumxPaneStatusById = {};
    w.__aumxPaneStatusHistoryById = {};
    w.__aumxPaneStatusTrackerUnsub = w.aumx.on(
      'event:pane-status-changed',
      (payload: { paneId?: string; status?: string }) => {
        const paneId = payload?.paneId;
        const status = payload?.status;
        if (!paneId || !status) return;
        w.__aumxPaneStatusById[paneId] = status;
        if (!Array.isArray(w.__aumxPaneStatusHistoryById[paneId])) {
          w.__aumxPaneStatusHistoryById[paneId] = [];
        }
        w.__aumxPaneStatusHistoryById[paneId].push({ status, ts: Date.now() });
      },
    );
    w.__aumxPaneStatusTrackerInitialized = true;
  });
}

function gitExec(cmd: string, cwd: string): void {
  execSync(cmd, { cwd, stdio: 'ignore' });
}

async function autoConfirmMergeUntilConflict(
  page: Page,
  paneId: string,
): Promise<SerializableActionResult> {
  return page.evaluate(async (id) => {
    const AUTO_CONFIRM = new Set(['Merge Worktree', 'Multi-Repository Merge', 'Multi-Merge Complete']);
    const AUTO_CHOICE = new Set(['Close Pane', 'Worktree Has Uncommitted Changes', 'Main Branch Has Uncommitted Changes']);
    let current: any = await (window as any).aumx.invoke('pane:merge', { paneId: id });
    for (let i = 0; i < 10; i++) {
      if (current.type === 'confirm' && current.callbackId && AUTO_CONFIRM.has(current.title)) {
        current = await (window as any).aumx.invoke('action:callback', { callbackId: current.callbackId });
        continue;
      }
      if (current.type === 'choice' && current.callbackId && AUTO_CHOICE.has(current.title)) {
        const choiceId = current.options?.find((o: any) => o.default)?.id ?? current.options?.[0]?.id;
        if (!choiceId) break;
        current = await (window as any).aumx.invoke('action:callback', { callbackId: current.callbackId, value: choiceId });
        continue;
      }
      break;
    }
    return current;
  }, paneId);
}

async function openConflictView(
  page: Page,
  paneId: string,
  result: SerializableActionResult,
): Promise<void> {
  await page.evaluate(
    ({ pid, res }) => {
      const stores = (window as any).__aumxStores;
      stores.conflictResolution.getState().openConflictResolution(pid, res);
      stores.ui.getState().openConflictView();
    },
    { pid: paneId, res: result },
  );
  await page.locator('[data-testid="conflict-resolution-view"]').waitFor({ state: 'visible', timeout: 10_000 });
}

if (process.env.AUMX_E2E !== '1') {
  console.warn('Conflict Resolution E2E skipped - set AUMX_E2E=1 to run');
}

describe.runIf(process.env.AUMX_E2E === '1')('Conflict Resolution E2E', () => {
  let app: ElectronApplication;
  let page: Page;
  let e2eRoot: string;
  const consoleErrors: string[] = [];
  const phases: PhaseResult[] = [];
  let createdPane: AumxPane | null = null;
  let conflictResult: SerializableActionResult | null = null;

  const SLOW_TIMEOUT_FACTOR = SLOW ? 4 : 1;

  // ---------------------------------------------------------------------------
  // Phase 0: App Launch & Preflight
  // ---------------------------------------------------------------------------

  beforeAll(async () => {
    const phaseStart = Date.now();
    try {
      expect(existsSync(MAIN_ENTRY), `Build output missing: ${MAIN_ENTRY}`).toBe(true);

      try {
        const sessions = execSync('tmux list-sessions -F "#{session_name}" 2>/dev/null', { encoding: 'utf-8' });
        for (const name of sessions.split('\n').filter((s) => s.includes('aumx-conflict-e2e'))) {
          execSync(`tmux kill-session -t "${name}" 2>/dev/null`, { stdio: 'ignore' });
          console.log(`Cleaned up stale E2E session: ${name}`);
        }
      } catch { /* no tmux server or no sessions */ }

      e2eRoot = realpathSync(mkdtempSync(resolve(tmpdir(), 'aumx-conflict-e2e-')));
      gitExec('git init', e2eRoot);
      gitExec('git config user.email "e2e@aumx.test"', e2eRoot);
      gitExec('git config user.name "aumx-e2e"', e2eRoot);
      writeFileSync(resolve(e2eRoot, '.gitignore'), '.amux/\n.aumx/\n');
      gitExec('git add .gitignore', e2eRoot);
      gitExec('git commit -m "chore: e2e workspace init"', e2eRoot);

      const inheritedEnv = Object.fromEntries(
        Object.entries(process.env).filter(([k]) => k !== 'CLAUDECODE'),
      );
      app = await electron.launch({
        args: [MAIN_ENTRY],
        cwd: e2eRoot,
        env: {
          ...inheritedEnv,
          NODE_ENV: 'test',
          AUMX_DEV: 'true',
        },
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
      await initializePaneStatusTracker(page);

      if (SLOW) console.log('SLOW MODE: pausing between steps for visual inspection');
      await showOverlay(page, 0, 'Launching App', SLOW ? 'SLOW MODE - Conflict Resolution E2E' : 'Conflict Resolution E2E');
      await pause(STEP_PAUSE);

      const systemCheck = await getSystemCheck(page);
      if (!systemCheck?.agents?.includes('claude')) {
        throw new Error(
          `SKIP: Claude agent not found. Available agents: ${JSON.stringify(systemCheck?.agents ?? [])}`,
        );
      }

      const sessionInfo = await getSessionInfo(page);
      if (sessionInfo.projectRoot !== e2eRoot) {
        throw new Error(
          `Unsafe E2E root. Expected ${e2eRoot}, got ${sessionInfo.projectRoot}. ` +
            `Stop other aumx tmux sessions before running this test.`,
        );
      }

      console.log('Preflight passed. Available agents:', systemCheck.agents);
      phases.push({ name: 'Phase 0: App Launch & Preflight', status: 'passed', durationMs: Date.now() - phaseStart });
    } catch (e) {
      phases.push({
        name: 'Phase 0: App Launch & Preflight',
        status: 'failed',
        durationMs: Date.now() - phaseStart,
        error: e instanceof Error ? e.message : String(e),
      });
      throw e;
    }
  }, 60_000 * SLOW_TIMEOUT_FACTOR);

  // ---------------------------------------------------------------------------
  // Cleanup
  // ---------------------------------------------------------------------------

  afterAll(async () => {
    const meaningfulErrors = consoleErrors.filter(
      (e) => !e.includes('Autofill.enable') && !e.includes('Autofill.setAddresses') && !e.includes('favicon.ico'),
    );
    if (meaningfulErrors.length > 0) {
      console.warn(`Console errors (${meaningfulErrors.length}):`, meaningfulErrors.slice(0, 5));
    }

    if (page && createdPane) {
      await hideOverlay(page).catch(() => {});
      await closePaneBestEffort(page, createdPane);
      await pollUntil(
        async () => {
          const remaining = await getPanes(page);
          return remaining.every((p) => p.id !== createdPane!.id);
        },
        { timeout: 10_000, interval: 1_000, label: 'cleanup-settle' },
      ).catch(() => {});
    }
    if (app) await app.close();
    if (e2eRoot) rmSync(e2eRoot, { recursive: true, force: true });
  }, 60_000);

  // ---------------------------------------------------------------------------
  // Phase 1: Create Pane with Worktree
  // ---------------------------------------------------------------------------

  it('creates a pane with worktree', async () => {
    const phaseStart = Date.now();
    try {
      await showOverlay(page, 1, 'Creating Pane', 'Launching pane with worktree for conflict testing');
      await pause(STEP_PAUSE);

      await page.evaluate(() =>
        (window as any).aumx.invoke('pane:create', {
          prompt: 'echo done',
          agent: 'claude',
          useWorktree: true,
        }),
      );

      const paneWithWorktree = await pollUntil(
        async () => {
          const panes = await getPanes(page);
          return panes.find((p) => p.worktreePath) ?? null;
        },
        { timeout: 60_000, interval: 3_000, label: 'waitForWorktreePane' },
      );
      expect(paneWithWorktree).toBeTruthy();
      expect(paneWithWorktree!.worktreePath).toBeTruthy();
      createdPane = paneWithWorktree!;

      await showOverlay(page, 1, 'Waiting for Agent', `Pane "${createdPane.slug}" created, waiting for idle...`);

      await pollUntil(
        async () => {
          const status: string = await page.evaluate(
            (id) => (window as any).__aumxPaneStatusById?.[id],
            createdPane!.id,
          );
          return !ACTIVE_AGENT_STATES.has(status) ? true : null;
        },
        { timeout: 90_000, interval: 3_000, label: 'waitForAgentIdle' },
      );

      await showOverlay(page, 1, 'Pane Ready', `Agent idle on "${createdPane.slug}"`);
      await pause(STEP_PAUSE);
      console.log(`Pane created: ${createdPane.slug} (worktree: ${createdPane.worktreePath})`);
      phases.push({ name: 'Phase 1: Create Pane', status: 'passed', durationMs: Date.now() - phaseStart });
    } catch (e) {
      phases.push({
        name: 'Phase 1: Create Pane',
        status: 'failed',
        durationMs: Date.now() - phaseStart,
        error: e instanceof Error ? e.message : String(e),
      });
      throw e;
    }
  }, 120_000 * SLOW_TIMEOUT_FACTOR);

  // ---------------------------------------------------------------------------
  // Phase 2: Create Git Conflict
  // ---------------------------------------------------------------------------

  it('creates a real git conflict between main and worktree', async () => {
    const phaseStart = Date.now();
    try {
      await showOverlay(page, 2, 'Creating Conflict', 'Writing "main version" to conflict-test.txt on main branch');
      await pause(STEP_PAUSE);
      expect(createdPane?.worktreePath).toBeTruthy();

      writeFileSync(resolve(e2eRoot, 'conflict-test.txt'), 'main version\n');
      gitExec('git add conflict-test.txt', e2eRoot);
      gitExec('git commit -m "main: add conflict-test.txt"', e2eRoot);

      await showOverlay(page, 2, 'Creating Conflict', 'Writing "worktree version" to same file on worktree branch');
      await pause(STEP_PAUSE);

      writeFileSync(resolve(createdPane!.worktreePath!, 'conflict-test.txt'), 'worktree version\n');
      gitExec('git add conflict-test.txt', createdPane!.worktreePath!);
      gitExec('git commit -m "worktree: add conflict-test.txt"', createdPane!.worktreePath!);

      await showOverlay(page, 2, 'Conflict Ready', 'Both branches have different content in the same file');
      await pause(STEP_PAUSE);
      console.log('Git conflict created between main and worktree');
      phases.push({ name: 'Phase 2: Create Git Conflict', status: 'passed', durationMs: Date.now() - phaseStart });
    } catch (e) {
      phases.push({
        name: 'Phase 2: Create Git Conflict',
        status: 'failed',
        durationMs: Date.now() - phaseStart,
        error: e instanceof Error ? e.message : String(e),
      });
      throw e;
    }
  }, 15_000 * SLOW_TIMEOUT_FACTOR);

  // ---------------------------------------------------------------------------
  // Phase 3: Trigger Merge, Verify Conflict Result
  // ---------------------------------------------------------------------------

  it('triggers merge and receives conflict choice', async () => {
    const phaseStart = Date.now();
    try {
      await showOverlay(page, 3, 'Triggering Merge', 'Calling pane:merge IPC, auto-confirming standard steps...');
      await pause(STEP_PAUSE);
      expect(createdPane).toBeTruthy();

      const result = await autoConfirmMergeUntilConflict(page, createdPane!.id);

      expect(result.type).toBe('choice');
      expect(result.title).toBe('Merge Conflicts Detected');
      expect(result.callbackId).toBeTruthy();
      expect(result.options).toBeTruthy();
      expect(result.options!.length).toBeGreaterThanOrEqual(2);

      const optionIds = result.options!.map((o) => o.id);
      expect(optionIds).toContain('cancel');

      conflictResult = result;
      await showOverlay(page, 3, 'Conflict Detected', `Options: ${optionIds.join(', ')}`);
      await pause(STEP_PAUSE);
      console.log(`Merge conflict detected. Options: ${optionIds.join(', ')}`);
      phases.push({ name: 'Phase 3: Trigger Merge', status: 'passed', durationMs: Date.now() - phaseStart });
    } catch (e) {
      phases.push({
        name: 'Phase 3: Trigger Merge',
        status: 'failed',
        durationMs: Date.now() - phaseStart,
        error: e instanceof Error ? e.message : String(e),
      });
      throw e;
    }
  }, 30_000 * SLOW_TIMEOUT_FACTOR);

  // ---------------------------------------------------------------------------
  // Phase 4: Open Conflict View, Verify UI
  // ---------------------------------------------------------------------------

  it('opens conflict resolution view and verifies UI elements', async () => {
    const phaseStart = Date.now();
    try {
      await showOverlay(page, 4, 'Opening View', 'Pushing conflict data into stores...');
      await pause(STEP_PAUSE);
      expect(conflictResult).toBeTruthy();
      expect(createdPane).toBeTruthy();

      await openConflictView(page, createdPane!.id, conflictResult!);

      await showOverlay(page, 4, 'Conflict View Open', 'Verifying all UI elements are rendered');
      await pause(VIEW_PAUSE);

      await page.locator('text="Conflict Resolution"').first().waitFor({ state: 'visible', timeout: 5_000 });

      await highlightElement(page, '[data-testid="conflict-back-btn"]');
      await showOverlay(page, 4, 'Checking Elements', 'Back button');
      await page.locator('[data-testid="conflict-back-btn"]').waitFor({ state: 'visible', timeout: 5_000 });
      await unhighlightElement(page, '[data-testid="conflict-back-btn"]');

      for (const option of conflictResult!.options!) {
        const sel = `[data-testid="strategy-${option.id}"]`;
        await highlightElement(page, sel);
        await showOverlay(page, 4, 'Checking Elements', `Strategy button: ${option.label}`);
        await page.locator(sel).waitFor({ state: 'visible', timeout: 5_000 });
        await unhighlightElement(page, sel);
      }

      await highlightElement(page, '[data-testid="conflict-cancel-btn"]');
      await showOverlay(page, 4, 'Checking Elements', 'Cancel button (bottom bar)');
      await page.locator('[data-testid="conflict-cancel-btn"]').waitFor({ state: 'visible', timeout: 5_000 });
      await unhighlightElement(page, '[data-testid="conflict-cancel-btn"]');

      await page.locator(`text="${createdPane!.slug}"`).first().waitFor({ state: 'visible', timeout: 5_000 });
      await showOverlay(page, 4, 'UI Verified', 'All elements present and correct');
      await pause(STEP_PAUSE);

      console.log('Conflict resolution view verified with all UI elements');
      phases.push({ name: 'Phase 4: Verify UI', status: 'passed', durationMs: Date.now() - phaseStart });
    } catch (e) {
      phases.push({
        name: 'Phase 4: Verify UI',
        status: 'failed',
        durationMs: Date.now() - phaseStart,
        error: e instanceof Error ? e.message : String(e),
      });
      throw e;
    }
  }, 30_000 * SLOW_TIMEOUT_FACTOR);

  // ---------------------------------------------------------------------------
  // Phase 5: Test Cancel (bottom bar button)
  // ---------------------------------------------------------------------------

  it('closes conflict view when cancel is clicked', async () => {
    const phaseStart = Date.now();
    try {
      await showOverlay(page, 5, 'Testing Cancel', 'About to click the Cancel button in the bottom bar...');
      await pause(STEP_PAUSE);

      await highlightElement(page, '[data-testid="conflict-cancel-btn"]');
      await showOverlay(page, 5, 'Clicking Cancel', 'Clicking bottom bar cancel button now');
      await pause(SLOW ? 1500 : 0);

      const cancelBtn = page.locator('[data-testid="conflict-cancel-btn"]');
      await cancelBtn.click();

      await showOverlay(page, 5, 'View Closing', 'Verifying conflict view is dismissed...');

      const view = page.locator('[data-testid="conflict-resolution-view"]');
      await view.waitFor({ state: 'hidden', timeout: 5_000 });

      const viewMode = await page.evaluate(
        () => (window as any).__aumxStores.ui.getState().viewMode,
      );
      expect(viewMode).not.toBe('conflict-resolution');

      const conflictPaneId = await page.evaluate(
        () => (window as any).__aumxStores.conflictResolution.getState().paneId,
      );
      expect(conflictPaneId).toBeNull();

      await showOverlay(page, 5, 'Cancel Works', 'View closed, stores cleared, viewMode restored');
      await pause(STEP_PAUSE);
      console.log('Cancel button works correctly - view closed, stores cleared');
      phases.push({ name: 'Phase 5: Test Cancel', status: 'passed', durationMs: Date.now() - phaseStart });
    } catch (e) {
      phases.push({
        name: 'Phase 5: Test Cancel',
        status: 'failed',
        durationMs: Date.now() - phaseStart,
        error: e instanceof Error ? e.message : String(e),
      });
      throw e;
    }
  }, 15_000 * SLOW_TIMEOUT_FACTOR);

  // ---------------------------------------------------------------------------
  // Phase 6: Re-create Conflict for Fresh CallbackId
  // ---------------------------------------------------------------------------

  it('re-creates conflict for a fresh callback', async () => {
    const phaseStart = Date.now();
    try {
      await showOverlay(page, 6, 'Re-creating Conflict', 'Aborting previous merge, writing new conflicting commits');
      await pause(STEP_PAUSE);
      expect(createdPane?.worktreePath).toBeTruthy();

      try {
        gitExec('git merge --abort', createdPane!.worktreePath!);
      } catch { /* no merge in progress */ }

      writeFileSync(resolve(e2eRoot, 'conflict-test.txt'), 'main version v2\n');
      gitExec('git add conflict-test.txt', e2eRoot);
      gitExec('git commit -m "main: update conflict-test.txt v2"', e2eRoot);

      writeFileSync(resolve(createdPane!.worktreePath!, 'conflict-test.txt'), 'worktree version v2\n');
      gitExec('git add conflict-test.txt', createdPane!.worktreePath!);
      gitExec('git commit -m "worktree: update conflict-test.txt v2"', createdPane!.worktreePath!);

      await showOverlay(page, 6, 'Triggering Merge', 'Calling pane:merge to get a fresh conflict...');
      await pause(STEP_PAUSE);

      const result = await autoConfirmMergeUntilConflict(page, createdPane!.id);
      expect(result.type).toBe('choice');
      expect(result.title).toBe('Merge Conflicts Detected');
      expect(result.callbackId).toBeTruthy();

      conflictResult = result;
      await showOverlay(page, 6, 'Fresh Conflict', 'New callbackId ready for cancel strategy test');
      await pause(STEP_PAUSE);
      console.log('Fresh conflict created with new callbackId');
      phases.push({ name: 'Phase 6: Re-create Conflict', status: 'passed', durationMs: Date.now() - phaseStart });
    } catch (e) {
      phases.push({
        name: 'Phase 6: Re-create Conflict',
        status: 'failed',
        durationMs: Date.now() - phaseStart,
        error: e instanceof Error ? e.message : String(e),
      });
      throw e;
    }
  }, 30_000 * SLOW_TIMEOUT_FACTOR);

  // ---------------------------------------------------------------------------
  // Phase 7: Test Cancel Strategy (via strategy sidebar button)
  // ---------------------------------------------------------------------------

  it('executes cancel strategy via the conflict view', async () => {
    const phaseStart = Date.now();
    try {
      await showOverlay(page, 7, 'Opening View', 'Re-opening conflict view for cancel strategy test');
      await pause(STEP_PAUSE);
      expect(conflictResult).toBeTruthy();
      expect(createdPane).toBeTruthy();

      await openConflictView(page, createdPane!.id, conflictResult!);

      await showOverlay(page, 7, 'Conflict View Open', 'About to click "Cancel merge" strategy in the sidebar');
      await pause(VIEW_PAUSE);

      await highlightElement(page, '[data-testid="strategy-cancel"]');
      await showOverlay(page, 7, 'Clicking Strategy', 'Clicking "Cancel merge" strategy button now');
      await pause(SLOW ? 1500 : 0);

      const cancelStrategyBtn = page.locator('[data-testid="strategy-cancel"]');
      await cancelStrategyBtn.click();

      await showOverlay(page, 7, 'Strategy Executed', 'Waiting for IPC callback to complete and view to close...');

      const view = page.locator('[data-testid="conflict-resolution-view"]');
      await view.waitFor({ state: 'hidden', timeout: 15_000 });

      const viewMode = await page.evaluate(
        () => (window as any).__aumxStores.ui.getState().viewMode,
      );
      expect(viewMode).not.toBe('conflict-resolution');

      await showOverlay(page, 7, 'Strategy Works', 'Cancel strategy executed, view closed, merge cancelled');
      await pause(STEP_PAUSE);
      console.log('Cancel strategy executed - view closed, merge cancelled');
      phases.push({ name: 'Phase 7: Test Cancel Strategy', status: 'passed', durationMs: Date.now() - phaseStart });
    } catch (e) {
      phases.push({
        name: 'Phase 7: Test Cancel Strategy',
        status: 'failed',
        durationMs: Date.now() - phaseStart,
        error: e instanceof Error ? e.message : String(e),
      });
      throw e;
    }
  }, 30_000 * SLOW_TIMEOUT_FACTOR);

  // ---------------------------------------------------------------------------
  // Phase 8: Verify No Console Errors
  // ---------------------------------------------------------------------------

  it('verifies no unexpected console errors occurred', async () => {
    const phaseStart = Date.now();
    try {
      await showOverlay(page, 8, 'Final Check', 'Verifying no console errors');
      await pause(STEP_PAUSE);

      const meaningfulErrors = consoleErrors.filter(
        (e) =>
          !e.includes('Autofill.enable') &&
          !e.includes('Autofill.setAddresses') &&
          !e.includes('favicon.ico'),
      );
      expect(meaningfulErrors, `Unexpected console errors: ${meaningfulErrors.join('\n')}`).toHaveLength(0);

      await showOverlay(page, 8, 'All Passed', `${phases.length + 1} phases completed successfully`);
      await pause(VIEW_PAUSE);
      console.log('No unexpected console errors');
      console.log(`Phase results: ${phases.map((p) => `${p.name}: ${p.status}`).join(', ')}`);
      phases.push({ name: 'Phase 8: No Console Errors', status: 'passed', durationMs: Date.now() - phaseStart });
    } catch (e) {
      phases.push({
        name: 'Phase 8: No Console Errors',
        status: 'failed',
        durationMs: Date.now() - phaseStart,
        error: e instanceof Error ? e.message : String(e),
      });
      throw e;
    }
  }, 10_000 * SLOW_TIMEOUT_FACTOR);
});
