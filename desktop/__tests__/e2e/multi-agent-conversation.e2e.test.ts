import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { _electron as electron } from 'playwright';
import type { ConsoleMessage, ElectronApplication, Page } from 'playwright';
import { execFileSync } from 'child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { getProjectConfigPath, type MuxBasePane } from 'muxbase/core';
import type { NormalizedSession } from '../../src/shared/agent-session-types';
import {
  closePaneBestEffort,
  getAppWindow,
  getGitDiff,
  getNormalizedSession,
  getPanes,
  getSessionInfo,
  getSystemCheck,
  pollUntil,
  sendFollowUpToPane,
  waitForFileContentChange,
  waitForUserMessageCount,
  type FileBaseline,
} from './e2e-helpers';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ROOT = resolve(__dirname, '..', '..');
const MAIN_ENTRY = resolve(ROOT, 'out', 'main', 'index.js');

const APP_STARTUP_TIMEOUT_MS = 60_000;
const APP_SHUTDOWN_TIMEOUT_MS = 60_000;
const PANE_CREATION_TIMEOUT_MS = 20_000;
const INITIAL_AGENT_TIMEOUT_MS = 300_000;
const FOLLOW_UP_FILE_TIMEOUT_MS = 180_000;
const FOLLOW_UP_SESSION_TIMEOUT_MS = 90_000;
const FOLLOW_UP_IDLE_TIMEOUT_MS = 60_000;
const TOTAL_RUNTIME_BUDGET_MS = 600_000;

const ACTIVE_AGENT_STATES = new Set(['working', 'analyzing', 'waiting']);
const RUN_TOKEN = `e2e-${Date.now().toString(36)}`;

// MUXBASE_E2E_SLOW=1 paces the test like a real user: pauses between actions,
// shows on-screen overlays describing each phase, drives pane creation
// through the UI dialog instead of IPC, and keeps the window open at the end
// so an operator can inspect the final state.
const SLOW = process.env.MUXBASE_E2E_SLOW === '1';
const STEP_PAUSE_MS = SLOW ? 1500 : 0;
const VIEW_PAUSE_MS = SLOW ? 3000 : 0;
const HOLD_AT_END_MS = SLOW ? 15_000 : 0;
const USE_UI_DRIVEN_CREATION = SLOW;

type AgentName = 'claude' | 'opencode';

async function pause(ms: number): Promise<void> {
  if (ms > 0) await new Promise((r) => setTimeout(r, ms));
}

async function showOverlay(page: Page, phase: number, title: string, detail?: string): Promise<void> {
  if (!SLOW) return;
  await page.evaluate(
    ({ phase: p, title: t, detail: d }) => {
      let el = document.getElementById('__e2e_overlay');
      if (!el) {
        el = document.createElement('div');
        el.id = '__e2e_overlay';
        document.body.appendChild(el);
      }
      el.innerHTML = `
        <div style="
          position:fixed;bottom:24px;right:24px;z-index:99999;
          min-width:360px;max-width:480px;padding:22px 26px;
          font-family:-apple-system,BlinkMacSystemFont,'Inter',sans-serif;
          background:rgba(15,15,20,0.92);border:1px solid rgba(167,139,250,0.4);
          border-radius:14px;box-shadow:0 12px 48px -8px rgba(0,0,0,0.6);
          color:#fff;
        ">
          <div style="display:flex;align-items:center;gap:12px;margin-bottom:${d ? '10px' : '0'}">
            <span style="
              display:inline-flex;align-items:center;justify-content:center;
              width:32px;height:32px;border-radius:10px;
              background:linear-gradient(135deg,#7c3aed,#6366f1);
              font-size:13px;font-weight:700;
            ">${p}</span>
            <span style="font-size:15px;font-weight:600;letter-spacing:-0.01em;">${t}</span>
          </div>
          ${d ? `<div style="color:rgba(255,255,255,0.65);font-size:12px;line-height:1.5;margin-left:44px;">${d}</div>` : ''}
        </div>
      `;
    },
    { phase, title, detail },
  );
}

async function hideOverlay(page: Page): Promise<void> {
  if (!SLOW) return;
  await page.evaluate(() => document.getElementById('__e2e_overlay')?.remove());
}

interface PaneDef {
  agent: AgentName;
  prompt: string;
  expectedFile: string;
  initialPatterns: RegExp[];
  followUpPrompt: string;
  followUpPatterns: RegExp[];
}

const PANE_DEFS: PaneDef[] = [
  {
    agent: 'claude',
    prompt:
      `${RUN_TOKEN} Create a single file named notes-claude.md in the current directory ` +
      `whose only content is exactly this single line: Hello from Claude`,
    expectedFile: 'notes-claude.md',
    initialPatterns: [/Hello from Claude/],
    followUpPrompt:
      'Append a new line at the end of notes-claude.md saying exactly: Follow-up answer received',
    followUpPatterns: [/Hello from Claude/, /Follow-up answer received/],
  },
  {
    agent: 'opencode',
    prompt:
      `${RUN_TOKEN} Create a single file named notes-opencode.md in the current directory ` +
      `whose only content is exactly this single line: Hello from OpenCode`,
    expectedFile: 'notes-opencode.md',
    initialPatterns: [/Hello from OpenCode/],
    followUpPrompt:
      'Append a new line at the end of notes-opencode.md saying exactly: Follow-up answer received',
    followUpPatterns: [/Hello from OpenCode/, /Follow-up answer received/],
  },
];

interface CreatedPane {
  id: string;
  slug: string;
  agent: AgentName;
  worktreePath: string;
  paneId: string;
  expectedFile: string;
  followUpPrompt: string;
  followUpPatterns: RegExp[];
  createdAtMs: number;
  initialBaseline?: FileBaseline;
  initialUserMessageCount?: number;
}

async function createPaneViaIPC(
  page: Page,
  prompt: string,
  projectRoot: string,
  agent: AgentName,
): Promise<MuxBasePane> {
  const response = await page.evaluate(
    (payload) =>
      (window as any).muxbase.invoke('pane:create', {
        prompt: payload.prompt,
        agent: payload.agent,
        projectRoot: payload.projectRoot,
        useWorktree: true,
      }),
    { prompt, projectRoot, agent },
  );

  if (!response?.success || !response?.pane) {
    throw new Error(`pane:create(${agent}) failed: ${response?.error ?? 'unknown error'}`);
  }
  return response.pane as MuxBasePane;
}

const AGENT_RADIO_LABELS: Record<AgentName, string> = {
  claude: 'Claude Code',
  opencode: 'OpenCode',
};

async function createPaneViaUI(
  page: Page,
  prompt: string,
  agent: AgentName,
  existingIds: Set<string>,
): Promise<MuxBasePane> {
  // Current real-user flow: dialog selects agent + (optional) name + launches.
  // The prompt is typed into the terminal AFTER the agent CLI is up — there is
  // no prompt textarea inside CreatePaneDialog.
  const openers = [
    page.locator('button[aria-label="Create new pane"]').first(),
    page.locator('button:has-text("New Pane")').first(),
    page.locator('aside button[title="New pane"]').first(),
    page.locator('button:has-text("+ New Pane")').first(),
  ];
  let opened = false;
  for (const opener of openers) {
    if (await opener.isVisible({ timeout: 1_000 }).catch(() => false)) {
      await opener.click();
      opened = true;
      break;
    }
  }
  if (!opened) {
    await page.keyboard.press('Meta+N').catch(() => {});
    opened = await page.locator('[role="dialog"]').isVisible({ timeout: 1_500 }).catch(() => false);
  }
  if (!opened) {
    await page.keyboard.press('Control+N').catch(() => {});
    opened = await page.locator('[role="dialog"]').isVisible({ timeout: 1_500 }).catch(() => false);
  }
  if (!opened) throw new Error('Could not open create pane dialog');

  await page.waitForSelector('[role="dialog"]', { timeout: 5_000 });
  const dialog = page.locator('[role="dialog"]').last();
  await pause(STEP_PAUSE_MS);

  const radio = dialog.locator(`[role="radio"]:has-text("${AGENT_RADIO_LABELS[agent]}")`).first();
  await radio.waitFor({ state: 'visible', timeout: 5_000 });
  await radio.click();
  await pause(STEP_PAUSE_MS);

  // Enable the Git Worktree toggle so the pane gets its own worktree.
  const worktreeTile = dialog.locator('div:has(> div > div > span:has-text("Git Worktree"))').first();
  const worktreeToggle = worktreeTile.locator('button[role="switch"]').first();
  if (await worktreeToggle.isVisible({ timeout: 2_000 }).catch(() => false)) {
    const isOn = (await worktreeToggle.getAttribute('aria-checked')) === 'true';
    if (!isOn) {
      await worktreeToggle.click();
      await pause(STEP_PAUSE_MS);
    }
  }

  const launchBtn = dialog.locator('button:has-text("Launch Pane")').first();
  await launchBtn.waitFor({ state: 'visible', timeout: 5_000 });
  await launchBtn.click();
  await page.waitForSelector('[role="dialog"]', { state: 'hidden', timeout: PANE_CREATION_TIMEOUT_MS });

  const newPane = await pollUntil(
    async () => {
      const panes = await getPanes(page);
      return panes.find((p) => !existingIds.has(p.id)) ?? null;
    },
    { timeout: PANE_CREATION_TIMEOUT_MS, interval: 500, label: `waitForUIPane(${agent})` },
  );

  // Wait for the agent CLI to come up in the terminal, then type the prompt
  // and submit with Enter — same as a real user would. The agent's UI varies
  // between Claude and OpenCode, so we wait until ANY non-empty content
  // appears, then give a generous settle delay before typing.
  await navigateToFocusView(page, newPane.id);
  await pause(VIEW_PAUSE_MS);

  const TRUST_PROMPT_REGEX = /trust.*folder|trust.*workspace|Yes,\s*I\s*trust|❯\s*1\.\s*Yes/i;
  await pollUntil(
    async () => {
      const content: { content?: string } | undefined = await page
        .evaluate(
          (id) => (window as any).muxbase.invoke('pane:get-content', { paneId: id }),
          newPane.id,
        )
        .catch(() => undefined);
      const text = (content?.content ?? '').trim();
      if (TRUST_PROMPT_REGEX.test(text)) {
        await page
          .evaluate(
            (id) => (window as any).muxbase.invoke('pane:send-keys', { paneId: id, command: '' }),
            newPane.id,
          )
          .catch(() => {});
        return null;
      }
      return text.length > 50 ? true : null;
    },
    { timeout: 30_000, interval: 1_000, label: `waitForAgentBoot(${agent})` },
  );
  await pause(5_000);
  await sendFollowUpToPane(page, newPane.id, prompt);
  return newPane;
}

interface StatusSnapshot {
  statusByPaneId: Record<string, string>;
  historyByPaneId: Record<string, Array<{ status: string; ts: number }>>;
}

async function initializePaneStatusTracker(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as any;
    if (w.__muxbasePaneStatusTrackerInitialized) {
      w.__muxbasePaneStatusById = {};
      w.__muxbasePaneStatusHistoryById = {};
      return;
    }
    w.__muxbasePaneStatusById = {};
    w.__muxbasePaneStatusHistoryById = {};
    w.__muxbasePaneStatusTrackerUnsub = w.muxbase.on(
      'event:pane-status-changed',
      (payload: { paneId?: string; status?: string }) => {
        const paneId = payload?.paneId;
        const status = payload?.status;
        if (!paneId || !status) return;
        w.__muxbasePaneStatusById[paneId] = status;
        if (!Array.isArray(w.__muxbasePaneStatusHistoryById[paneId])) {
          w.__muxbasePaneStatusHistoryById[paneId] = [];
        }
        w.__muxbasePaneStatusHistoryById[paneId].push({ status, ts: Date.now() });
      },
    );
    w.__muxbasePaneStatusTrackerInitialized = true;
  });
}

async function getPaneStatusSnapshot(page: Page): Promise<StatusSnapshot> {
  return page.evaluate(() => {
    const w = window as any;
    const statusByPaneId = { ...(w.__muxbasePaneStatusById ?? {}) };
    const history = w.__muxbasePaneStatusHistoryById ?? {};
    const historyByPaneId: Record<string, Array<{ status: string; ts: number }>> = {};
    for (const [paneId, samples] of Object.entries(history)) {
      if (Array.isArray(samples)) {
        historyByPaneId[paneId] = samples.slice(-60) as Array<{ status: string; ts: number }>;
      }
    }
    return { statusByPaneId, historyByPaneId };
  });
}

async function waitForAllPanesIdle(
  page: Page,
  panesToTrack: Array<{ id: string; createdAtMs: number }>,
  timeout: number,
): Promise<{ maxConcurrentActive: number; overlapConfirmed: boolean }> {
  const paneIds = panesToTrack.map((p) => p.id);
  const paneIdSet = new Set(paneIds);
  const latestCreationMs = Math.max(...panesToTrack.map((p) => p.createdAtMs));
  let maxConcurrentActive = 0;

  return pollUntil(
    async () => {
      const panes = await getPanes(page);
      const trackedPanes = panes.filter((p) => paneIdSet.has(p.id));
      if (trackedPanes.length !== paneIds.length) return null;
      const paneMap = new Map(trackedPanes.map((p) => [p.id, p]));
      const snapshot = await getPaneStatusSnapshot(page);

      const currentStatuses = paneIds.map(
        (paneId) => snapshot.statusByPaneId[paneId] ?? paneMap.get(paneId)?.agentStatus ?? '',
      );

      const activeNow = currentStatuses.filter((s) => ACTIVE_AGENT_STATES.has(s)).length;
      maxConcurrentActive = Math.max(maxConcurrentActive, activeNow);

      const allSettled = currentStatuses.every((s) => s === 'idle' || s === 'waiting');
      if (!allSettled) return null;

      const hasEverBeenActive = paneIds.some((paneId) => {
        const history = snapshot.historyByPaneId[paneId] ?? [];
        return history.some((s) => ACTIVE_AGENT_STATES.has(s.status));
      });
      const elapsedSinceCreation = Date.now() - latestCreationMs;
      if (!hasEverBeenActive && elapsedSinceCreation < 30_000) return null;

      const firstSettledTimes = paneIds.map((paneId) => {
        const history = snapshot.historyByPaneId[paneId] ?? [];
        const firstSettled = history.find((s) => s.status === 'idle' || s.status === 'waiting');
        return firstSettled?.ts ?? Number.NaN;
      });
      const hasAllSettledTimestamps = firstSettledTimes.every((ts) => Number.isFinite(ts));
      const earliestSettledMs = hasAllSettledTimestamps ? Math.min(...firstSettledTimes) : Number.NaN;
      const overlapConfirmed = hasAllSettledTimestamps && latestCreationMs <= earliestSettledMs;

      return { maxConcurrentActive, overlapConfirmed };
    },
    { timeout, interval: 750, label: 'waitForAllPanesIdle' },
  );
}

async function waitForSessionToolUsage(
  page: Page,
  paneId: string,
  timeout: number,
): Promise<NormalizedSession> {
  return pollUntil(
    async () => {
      const session = await getNormalizedSession(page, paneId);
      if (!session) return null;
      const hasToolCall = (session.messages ?? []).some((m) => (m.toolCalls?.length ?? 0) > 0);
      return hasToolCall ? session : null;
    },
    { timeout, interval: 2_000, label: `waitForSessionToolUsage(${paneId})` },
  );
}

async function waitForSessionWithMessages(
  page: Page,
  paneId: string,
  timeout: number,
): Promise<NormalizedSession> {
  return pollUntil(
    async () => {
      const session = await getNormalizedSession(page, paneId);
      if (!session) return null;
      if ((session.messages?.length ?? 0) > 0 && (session.metrics?.totalTokens ?? 0) > 0) {
        return session;
      }
      return null;
    },
    { timeout, interval: 3_000, label: `waitForSessionWithMessages(${paneId})` },
  );
}

interface SessionWindow {
  paneId: string;
  startMs?: number;
  endMs?: number;
}

function finiteNumbers(values: Array<number | undefined>): number[] {
  return values.filter((v): v is number => Number.isFinite(v));
}

async function getSessionWindows(page: Page, paneIds: string[]): Promise<SessionWindow[]> {
  const windows: SessionWindow[] = [];
  for (const paneId of paneIds) {
    const session = await getNormalizedSession(page, paneId);
    if (!session) {
      windows.push({ paneId });
      continue;
    }
    const ts = finiteNumbers((session.messages ?? []).map((m) => m.timestamp));
    const starts = finiteNumbers([session.startTime, ...ts]);
    const ends = finiteNumbers([session.lastUpdateTime, ...ts]);
    windows.push({
      paneId,
      startMs: starts.length > 0 ? Math.min(...starts) : undefined,
      endMs: ends.length > 0 ? Math.max(...ends) : undefined,
    });
  }
  return windows;
}

function computeSessionOverlap(windows: SessionWindow[]): { observed: boolean; overlapMs: number } {
  const valid = windows.filter(
    (w): w is SessionWindow & { startMs: number; endMs: number } =>
      Number.isFinite(w.startMs) && Number.isFinite(w.endMs) && (w.endMs as number) >= (w.startMs as number),
  );
  if (valid.length < 2) return { observed: false, overlapMs: 0 };
  const latestStart = Math.max(...valid.map((w) => w.startMs));
  const earliestEnd = Math.min(...valid.map((w) => w.endMs));
  const overlapMs = Math.max(0, earliestEnd - latestStart);
  return { observed: overlapMs > 0, overlapMs };
}

/**
 * Compute max concurrent active panes from the recorded event-history timeline.
 * Each pane's history is a sequence of {status, ts} samples. We construct
 * [active-start, active-end] intervals per pane and sweep over all interval
 * endpoints to find the peak concurrent count.
 */
function computeHistoryConcurrentActive(
  snapshot: StatusSnapshot,
  paneIds: string[],
  activeStates: Set<string>,
): { maxConcurrent: number; overlapSpans: number } {
  type Event = { ts: number; delta: 1 | -1 };
  const events: Event[] = [];

  for (const paneId of paneIds) {
    const history = snapshot.historyByPaneId[paneId] ?? [];
    let currentlyActive = false;
    let activeStart = 0;
    for (const sample of history) {
      const isActive = activeStates.has(sample.status);
      if (isActive && !currentlyActive) {
        currentlyActive = true;
        activeStart = sample.ts;
      } else if (!isActive && currentlyActive) {
        currentlyActive = false;
        events.push({ ts: activeStart, delta: 1 });
        events.push({ ts: sample.ts, delta: -1 });
      }
    }
    if (currentlyActive) {
      events.push({ ts: activeStart, delta: 1 });
      events.push({ ts: Date.now(), delta: -1 });
    }
  }

  events.sort((a, b) => (a.ts - b.ts) || (a.delta - b.delta));
  let active = 0;
  let maxConcurrent = 0;
  let overlapSpans = 0;
  let inOverlap = false;
  for (const e of events) {
    active += e.delta;
    if (active > maxConcurrent) maxConcurrent = active;
    if (active >= 2 && !inOverlap) {
      overlapSpans++;
      inOverlap = true;
    } else if (active < 2 && inOverlap) {
      inOverlap = false;
    }
  }
  return { maxConcurrent, overlapSpans };
}

async function navigateToFocusView(page: Page, paneId: string): Promise<void> {
  const navigated = await page.evaluate((id) => {
    const stores = (window as any).__muxbaseStores;
    if (stores?.ui?.setState) {
      stores.ui.setState({ viewMode: 'focus', focusPaneId: id });
      return true;
    }
    return false;
  }, paneId);

  if (!navigated) {
    const focusBtn = page.locator('button[aria-label="Focus pane"]').first();
    if (await focusBtn.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await focusBtn.click();
    }
  }
  await page.locator('button[role="tab"]').first().waitFor({ state: 'visible', timeout: 5_000 });
}

async function navigateToFleetView(page: Page): Promise<void> {
  await page.evaluate(() => {
    const stores = (window as any).__muxbaseStores;
    if (stores?.ui?.setState) {
      stores.ui.setState({ viewMode: 'fleet', focusPaneId: null });
    }
  });
  await new Promise((r) => setTimeout(r, 500));
}

async function switchTab(page: Page, tabName: string, waitForText?: string): Promise<void> {
  const tab = page.locator(`button[role="tab"]:has-text("${tabName}")`);
  if (await tab.isVisible({ timeout: 3_000 }).catch(() => false)) {
    await tab.click();
    if (waitForText) {
      await page
        .locator(`text="${waitForText}"`)
        .waitFor({ state: 'visible', timeout: 5_000 })
        .catch(() => {});
    }
  } else {
    console.warn(`switchTab: tab "${tabName}" not visible`);
  }
}

// ---------------------------------------------------------------------------
// Test Suite
// ---------------------------------------------------------------------------

if (process.env.MUXBASE_E2E !== '1') {
  console.warn('Multi-Agent Conversation E2E skipped — set MUXBASE_E2E=1 to run');
}

describe.runIf(process.env.MUXBASE_E2E === '1')('Multi-Agent Conversation E2E (Claude + OpenCode)', () => {
  let app: ElectronApplication;
  let page: Page;
  let projectRoot: string;
  const createdPanes: CreatedPane[] = [];
  const consoleErrors: string[] = [];
  const suiteStartMs = Date.now();

  // -------------------------------------------------------------------------
  // Phase 0: Preflight
  // -------------------------------------------------------------------------

  beforeAll(async () => {
    expect(existsSync(MAIN_ENTRY), `Build output missing: ${MAIN_ENTRY}`).toBe(true);

    // Hermetic tmpdir keeps the Claude session parser from picking up a
    // developer's live ~/.claude/projects session when the test shares a
    // project root with one. realpathSync canonicalizes /var → /private/var
    // so the OpenCode parser's directory-startsWith check matches what
    // `opencode db` stores.
    projectRoot = realpathSync(mkdtempSync(join(tmpdir(), 'muxbase-multi-agent-e2e-')));
    execFileSync('git', ['init', '--initial-branch=main', projectRoot], { stdio: 'ignore' });
    execFileSync('git', ['-C', projectRoot, 'config', 'user.email', 'e2e@muxbase.local'], { stdio: 'ignore' });
    execFileSync('git', ['-C', projectRoot, 'config', 'user.name', 'MuxBase E2E'], { stdio: 'ignore' });
    writeFileSync(join(projectRoot, 'README.md'), '# multi-agent-e2e fixture\n');
    execFileSync('git', ['-C', projectRoot, 'add', '.'], { stdio: 'ignore' });
    execFileSync('git', ['-C', projectRoot, 'commit', '-m', 'init'], { stdio: 'ignore' });

    app = await electron.launch({
      args: [MAIN_ENTRY],
      cwd: projectRoot,
      env: {
        ...process.env,
        NODE_ENV: 'test',
        MUXBASE_DEV: 'true',
      },
      // In slow mode, throttle every Playwright action so cursor moves and
      // dialogs are visible to a human observer.
      ...(SLOW ? { timeout: 0 } : {}),
    });

    page = await getAppWindow(app);

    await app.context().addInitScript(() => {
      (window as any).__MUXBASE_E2E = true;
    });
    await page.reload();

    page.on('console', (msg: ConsoleMessage) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });

    await page.waitForSelector('[data-testid="app-shell"]', { timeout: 15_000 }).catch(() => {});
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.locator('aside').waitFor({ state: 'visible', timeout: 10_000 }).catch(() => {});
    await initializePaneStatusTracker(page);

    const systemCheck = await getSystemCheck(page);
    const required: AgentName[] = ['claude', 'opencode'];
    const missing = required.filter((a) => !systemCheck?.agents?.includes(a));
    if (missing.length > 0) {
      throw new Error(
        `SKIP: required agent(s) missing: ${missing.join(', ')}. Available: ${(systemCheck?.agents ?? []).join(', ') || '(none)'}.`,
      );
    }

    const rootDiff = await getGitDiff(page, projectRoot);
    expect(rootDiff.repo?.isGitRepo, `Target project root must be a git repo: ${projectRoot}`).toBe(true);

    // Clean up leftovers from prior interrupted runs.
    const existing = await getPanes(page);
    for (const pane of existing) {
      if (!pane.id || !pane.paneId) continue;
      await closePaneBestEffort(page, { id: pane.id, paneId: pane.paneId });
    }
    if (existing.length > 0) {
      const existingIds = new Set(existing.map((p) => p.id));
      await pollUntil(
        async () => {
          const panes = await getPanes(page);
          return panes.every((p) => !existingIds.has(p.id));
        },
        { timeout: 8_000, interval: 1_000, label: 'preflight-cleanup' },
      ).catch(() => {});
    }

    console.log(
      `[Phase 0] Preflight OK. Agents: ${systemCheck.agents.join(', ')}. ` +
        `tmux=${systemCheck.tmux?.version ?? '?'} git=${systemCheck.git?.version ?? '?'}`,
    );
    await showOverlay(page, 0, 'App launched', `Project: ${projectRoot.split('/').pop()}`);
    await pause(VIEW_PAUSE_MS);
  }, APP_STARTUP_TIMEOUT_MS);

  afterAll(async () => {
    if (page) {
      for (const pane of createdPanes) {
        await closePaneBestEffort(page, { id: pane.id, paneId: pane.paneId });
      }
      await pollUntil(
        async () => {
          const remaining = await getPanes(page);
          return remaining.every((p) => !createdPanes.some((c) => c.id === p.id));
        },
        { timeout: 8_000, interval: 1_000, label: 'cleanup-settle' },
      ).catch(() => {});
    }
    if (app) await app.close();
    if (projectRoot) rmSync(projectRoot, { recursive: true, force: true });
  }, APP_SHUTDOWN_TIMEOUT_MS);

  // -------------------------------------------------------------------------
  // Phase 1: Create two panes (Claude + OpenCode) in parallel
  // -------------------------------------------------------------------------

  it('creates one Claude pane and one OpenCode pane sequentially', async () => {
    for (const def of PANE_DEFS) {
      await showOverlay(
        page,
        1,
        `Creating ${def.agent} pane`,
        USE_UI_DRIVEN_CREATION ? 'Opening dialog like a user would…' : 'Via pane:create IPC',
      );
      await pause(STEP_PAUSE_MS);

      let newPane: MuxBasePane;
      if (USE_UI_DRIVEN_CREATION) {
        const existingIds = new Set((await getPanes(page)).map((p) => p.id));
        newPane = await createPaneViaUI(page, def.prompt, def.agent, existingIds);
      } else {
        const created = await createPaneViaIPC(page, def.prompt, projectRoot, def.agent);
        newPane = await pollUntil(
          async () => {
            const panes = await getPanes(page);
            return panes.find((p) => p.id === created.id) ?? null;
          },
          { timeout: PANE_CREATION_TIMEOUT_MS, interval: 500, label: `waitForPane(${def.agent})` },
        );
      }

      expect(newPane).toBeTruthy();
      expect(newPane.id).toBeTruthy();
      expect(newPane.slug).toBeTruthy();
      expect(newPane.agent, `pane.agent must match requested agent (${def.agent})`).toBe(def.agent);
      expect(newPane.paneId).toMatch(/^%\d+$/);
      expect(newPane.worktreePath).toBeTruthy();
      expect(newPane.worktreePath).toMatch(/^\//);
      expect(newPane.worktreePath).toContain('.muxbase/worktrees/');
      expect(newPane.slug).toMatch(/^[a-z0-9][a-z0-9-]*$/);
      // UI flow types the prompt into the terminal after launch, so it isn't
      // stored on the pane record; IPC flow stores it as part of pane:create.
      if (!USE_UI_DRIVEN_CREATION) {
        expect(newPane.prompt).toBe(def.prompt);
      }
      if (newPane.type) expect(newPane.type).toBe('worktree');

      await pollUntil(
        async () => existsSync(newPane.worktreePath!) || null,
        { timeout: 5_000, interval: 250, label: `waitForWorktreeDir(${newPane.slug})` },
      );

      createdPanes.push({
        id: newPane.id,
        slug: newPane.slug,
        agent: def.agent,
        worktreePath: newPane.worktreePath!,
        paneId: newPane.paneId!,
        expectedFile: def.expectedFile,
        followUpPrompt: def.followUpPrompt,
        followUpPatterns: def.followUpPatterns,
        createdAtMs: Date.now(),
      });

      console.log(
        `[Phase 1] Created ${def.agent} pane: slug=${newPane.slug} ` +
          `paneId=${newPane.paneId} worktree=${newPane.worktreePath}`,
      );
    }

    expect(createdPanes).toHaveLength(PANE_DEFS.length);
    const uniqueSlugs = new Set(createdPanes.map((p) => p.slug));
    const uniqueWorktrees = new Set(createdPanes.map((p) => p.worktreePath));
    expect(uniqueSlugs.size).toBe(PANE_DEFS.length);
    expect(uniqueWorktrees.size).toBe(PANE_DEFS.length);

    expect(createdPanes[0].agent).toBe('claude');
    expect(createdPanes[1].agent).toBe('opencode');
  }, 120_000);

  // -------------------------------------------------------------------------
  // Phase 2: Wait for both initial agent runs + verify parallelism
  // -------------------------------------------------------------------------

  it('waits for both initial agent runs to finish and confirms parallel execution', async () => {
    expect(createdPanes).toHaveLength(PANE_DEFS.length);
    await showOverlay(page, 2, 'Agents working in parallel', 'Both Claude and OpenCode are writing files now');

    const waitResult = await waitForAllPanesIdle(
      page,
      createdPanes.map((p) => ({ id: p.id, createdAtMs: p.createdAtMs })),
      INITIAL_AGENT_TIMEOUT_MS,
    );

    const fileCompletionByPaneId = new Map<string, number>();

    // Ground truth: each expected file must exist in its worktree.
    // Some Claude/OpenCode versions show a "Trust this folder?" dialog on
    // fresh tmpdir worktrees that blocks the agent — accept it with Enter.
    const TRUST_PROMPT_REGEX = /trust.*folder|trust.*workspace|Yes,\s*I\s*trust|❯\s*1\.\s*Yes/i;
    for (const pane of createdPanes) {
      const filePath = resolve(pane.worktreePath, pane.expectedFile);
      let trustPromptHandled = false;

      if (!existsSync(filePath)) {
        await pollUntil(
          async () => {
            if (existsSync(filePath)) return true;

            if (!trustPromptHandled) {
              const paneContent: { content?: string } | undefined = await page
                .evaluate(
                  (id) => (window as any).muxbase.invoke('pane:get-content', { paneId: id }),
                  pane.id,
                )
                .catch(() => undefined);

              if (paneContent?.content && TRUST_PROMPT_REGEX.test(paneContent.content)) {
                console.log(`[Phase 2] ${pane.agent}: trust prompt detected, sending Enter`);
                await page
                  .evaluate(
                    (id) =>
                      (window as any).muxbase.invoke('pane:send-keys', {
                        paneId: id,
                        command: '',
                      }),
                    pane.id,
                  )
                  .catch(() => {});
                trustPromptHandled = true;
              }
            }
            return null;
          },
          { timeout: 120_000, interval: 3_000, label: `waitForFile(${pane.expectedFile})` },
        );
      }
      const st = statSync(filePath);
      fileCompletionByPaneId.set(pane.id, Number.isFinite(st.mtimeMs) ? st.mtimeMs : Date.now());
    }

    const requiredParallelism = Math.min(PANE_DEFS.length, 2);
    const statusParallel = waitResult.maxConcurrentActive >= requiredParallelism || waitResult.overlapConfirmed;

    const paneIds = createdPanes.map((p) => p.id);
    const sessionOverlap = await pollUntil(
      async () => {
        const windows = await getSessionWindows(page, paneIds);
        const allReady = windows.every((w) => Number.isFinite(w.startMs) && Number.isFinite(w.endMs));
        if (!allReady) return null;
        return { windows, ...computeSessionOverlap(windows) };
      },
      { timeout: 20_000, interval: 1_000, label: 'waitForSessionWindows' },
    ).catch(async () => {
      const windows = await getSessionWindows(page, paneIds);
      return { windows, ...computeSessionOverlap(windows) };
    });

    const launchOverlapObserved = createdPanes.some((earlier) => {
      const earlierMs = fileCompletionByPaneId.get(earlier.id);
      if (!Number.isFinite(earlierMs)) return false;
      return createdPanes.some(
        (later) =>
          later.id !== earlier.id &&
          later.createdAtMs > earlier.createdAtMs &&
          (earlierMs as number) >= later.createdAtMs,
      );
    });

    const finalSnapshot = await getPaneStatusSnapshot(page);
    const historyOverlap = computeHistoryConcurrentActive(finalSnapshot, paneIds, ACTIVE_AGENT_STATES);

    const parallelObserved =
      statusParallel ||
      sessionOverlap.observed ||
      launchOverlapObserved ||
      historyOverlap.maxConcurrent >= requiredParallelism;

    // UI-driven creation types each pane's prompt sequentially, so parallelism
    // is structurally impossible — instead we just verify both agents wrote
    // their expected file (already asserted by the per-file pollUntil above).
    if (!USE_UI_DRIVEN_CREATION) {
      expect(
        parallelObserved,
        `Expected ≥${requiredParallelism} panes active concurrently — ` +
          `status:maxConcurrentActive=${waitResult.maxConcurrentActive},overlapConfirmed=${waitResult.overlapConfirmed}; ` +
          `session:observed=${sessionOverlap.observed},overlapMs=${sessionOverlap.overlapMs}; ` +
          `launchOverlap=${launchOverlapObserved}; ` +
          `historyMaxConcurrent=${historyOverlap.maxConcurrent}`,
      ).toBe(true);
    }

    console.log(
      `[Phase 2] Parallelism OK. maxConcurrentActive=${waitResult.maxConcurrentActive} ` +
        `overlapConfirmed=${waitResult.overlapConfirmed} ` +
        `sessionOverlap=${sessionOverlap.observed}(${sessionOverlap.overlapMs}ms) ` +
        `launchOverlap=${launchOverlapObserved} ` +
        `historyMaxConcurrent=${historyOverlap.maxConcurrent}`,
    );
    await showOverlay(page, 2, 'Both agents finished', 'Files created in their worktrees');
    await pause(VIEW_PAUSE_MS);
  }, INITIAL_AGENT_TIMEOUT_MS + 60_000);

  // -------------------------------------------------------------------------
  // Phase 3: Verify initial files, git state, tool usage, isolation
  // ----------------------------------------------------------------------
  //          Snapshot baseline (size + mtime + userMsgCount) for Phase 5
  // -------------------------------------------------------------------------

  it('verifies initial files, git worktree state, tool usage, and cross-pane isolation', async () => {
    await showOverlay(page, 3, 'Verifying files & git state', 'Reading worktrees, checking diff, parsing sessions');
    await pause(STEP_PAUSE_MS);
    const sessionInfo = await getSessionInfo(page);
    const configPath = getProjectConfigPath(sessionInfo.projectRoot);
    expect(existsSync(configPath), `Missing muxbase config file: ${configPath}`).toBe(true);
    const config = JSON.parse(readFileSync(configPath, 'utf-8')) as { panes?: MuxBasePane[] };
    const configPanes = config.panes ?? [];

    for (const pane of createdPanes) {
      const def = PANE_DEFS.find((d) => d.agent === pane.agent)!;

      // Config persistence
      const cfg = configPanes.find((p) => p.id === pane.id);
      expect(cfg, `pane ${pane.slug} must be persisted in muxbase.config.json`).toBeTruthy();
      if (!USE_UI_DRIVEN_CREATION) {
        expect(cfg?.prompt).toBe(def.prompt);
      }
      expect(cfg?.agent).toBe(def.agent);
      expect(cfg?.paneId).toBe(pane.paneId);
      expect(cfg?.worktreePath).toBe(pane.worktreePath);

      // File existence + content
      const filePath = resolve(pane.worktreePath, pane.expectedFile);
      expect(existsSync(filePath), `expected file missing: ${filePath}`).toBe(true);
      const content = readFileSync(filePath, 'utf-8');
      expect(content.trim().length).toBeGreaterThan(0);
      for (const pattern of def.initialPatterns) {
        expect(content, `pane ${pane.agent} initial content must match ${pattern}`).toMatch(pattern);
      }

      // Git worktree state
      const diff = await getGitDiff(page, pane.worktreePath);
      expect(diff?.error).toBeFalsy();
      expect(diff.repo?.isGitRepo).toBe(true);
      expect(diff.repo?.isWorktree).toBe(true);
      const branch = diff.repo?.branch ?? '';
      expect(branch).toBeTruthy();
      expect(branch).not.toMatch(/^(main|master)$/);
      if (diff.repo?.repoRoot) {
        // git canonicalizes /var → /private/var; compare via realpath.
        const repoRootReal = realpathSync(resolve(diff.repo.repoRoot));
        const worktreeReal = realpathSync(resolve(pane.worktreePath));
        expect(repoRootReal).toBe(worktreeReal);
      }
      const allGitFiles = [...(diff.changedFiles ?? []), ...(diff.untrackedFiles ?? [])];
      const fileInDiff = allGitFiles.some(
        (f) => f === pane.expectedFile || f.endsWith(`/${pane.expectedFile}`),
      );
      expect(fileInDiff, `expected file must appear in git diff for ${pane.agent}`).toBe(true);

      // Session + tool usage (permissive regex for Claude/OpenCode tool name differences)
      const session = await waitForSessionToolUsage(page, pane.id, 60_000);
      expect(session.agent, `session.agent must match pane.agent for ${pane.agent}`).toBe(pane.agent);
      const toolNames: string[] = [];
      let agentUsedWriteTool = false;
      for (const msg of session.messages ?? []) {
        for (const tc of msg.toolCalls ?? []) {
          toolNames.push(tc.name);
          if (/write|create|bash|edit/i.test(tc.name)) agentUsedWriteTool = true;
        }
      }
      expect(
        agentUsedWriteTool,
        `${pane.agent} must have used a write/edit/bash tool. Tools seen: [${toolNames.join(',')}]`,
      ).toBe(true);

      // Snapshot baseline for Phase 5
      const st = statSync(filePath);
      pane.initialBaseline = { size: st.size, mtimeMs: st.mtimeMs };
      pane.initialUserMessageCount = (session.messages ?? []).filter((m) => m.type === 'user').length;

      console.log(
        `[Phase 3] ${pane.agent}: branch=${branch} fileSize=${st.size} ` +
          `userMsgs=${pane.initialUserMessageCount} tools=[${toolNames.join(',')}]`,
      );
    }

    // Cross-pane isolation
    for (let a = 0; a < createdPanes.length; a++) {
      for (let b = 0; b < createdPanes.length; b++) {
        if (a === b) continue;
        const paneA = createdPanes[a];
        const paneB = createdPanes[b];
        if (paneA.expectedFile === paneB.expectedFile) continue;
        const crossPath = resolve(paneB.worktreePath, paneA.expectedFile);
        expect(
          existsSync(crossPath),
          `Isolation violation: ${paneA.expectedFile} from "${paneA.slug}" found in "${paneB.slug}" worktree`,
        ).toBe(false);
      }
    }
  }, 120_000);

  // -------------------------------------------------------------------------
  // Phase 4: Send follow-up question to each pane
  // -------------------------------------------------------------------------

  it('sends a follow-up question to each running agent via pane:send-keys', async () => {
    for (const pane of createdPanes) {
      const before = await getPaneStatusSnapshot(page);
      const statusBefore = before.statusByPaneId[pane.id] ?? 'unknown';

      // In slow mode, navigate to the pane first so the operator can see the
      // terminal receive the keystrokes.
      if (SLOW) {
        await navigateToFocusView(page, pane.id);
        await showOverlay(page, 4, `Asking ${pane.agent} a follow-up`, pane.followUpPrompt);
        await pause(STEP_PAUSE_MS);
      }

      await sendFollowUpToPane(page, pane.id, pane.followUpPrompt);
      console.log(`[Phase 4] Sent follow-up to ${pane.agent} (status before send: ${statusBefore})`);

      // Best-effort: status should flip out of idle within ~5s. If not, log and continue —
      // Phase 5's file-content polling is the real verification.
      const transitioned = await pollUntil(
        async () => {
          const snap = await getPaneStatusSnapshot(page);
          const s = snap.statusByPaneId[pane.id];
          return s && s !== 'idle' ? s : null;
        },
        { timeout: 5_000, interval: 250, label: `waitForTransition(${pane.agent})` },
      ).catch(() => null);

      if (!transitioned) {
        console.warn(`[Phase 4] ${pane.agent} status did not flip away from idle within 5s (will rely on file/session checks)`);
      }

      // Stagger sends so the two tmux pane writes don't race.
      await new Promise((r) => setTimeout(r, 500));
    }
  }, 30_000);

  // -------------------------------------------------------------------------
  // Phase 5: Wait for follow-up completion + verify new content
  // -------------------------------------------------------------------------

  it('verifies each agent answered its follow-up: file changed AND session has a new user turn', async () => {
    await showOverlay(page, 5, 'Waiting for agents to answer', 'Polling file mtime and session user-message count');
    for (const pane of createdPanes) {
      expect(pane.initialBaseline, 'Phase 3 must have set initialBaseline').toBeTruthy();
      expect(pane.initialUserMessageCount, 'Phase 3 must have set initialUserMessageCount').toBeDefined();

      const filePath = resolve(pane.worktreePath, pane.expectedFile);

      const snapshot = await waitForFileContentChange(
        filePath,
        pane.initialBaseline!,
        pane.followUpPatterns,
        FOLLOW_UP_FILE_TIMEOUT_MS,
      );

      // Sanity: assert the patterns hit on the in-test content too.
      for (const pattern of pane.followUpPatterns) {
        expect(snapshot.content).toMatch(pattern);
      }

      const newUserCount = await waitForUserMessageCount(
        page,
        pane.id,
        (pane.initialUserMessageCount ?? 0) + 1,
        FOLLOW_UP_SESSION_TIMEOUT_MS,
      );
      expect(newUserCount).toBeGreaterThan(pane.initialUserMessageCount ?? 0);

      console.log(
        `[Phase 5] ${pane.agent}: file grew (size=${snapshot.size}) ` +
          `userMsgs ${pane.initialUserMessageCount} → ${newUserCount}`,
      );
    }

    // Both panes should settle back to idle/waiting after the follow-up turn.
    await waitForAllPanesIdle(
      page,
      createdPanes.map((p) => ({ id: p.id, createdAtMs: p.createdAtMs })),
      FOLLOW_UP_IDLE_TIMEOUT_MS,
    );
    // Worst case: file-wait + session-wait per pane (sequential) + final idle wait.
  }, (FOLLOW_UP_FILE_TIMEOUT_MS + FOLLOW_UP_SESSION_TIMEOUT_MS) * PANE_DEFS.length + FOLLOW_UP_IDLE_TIMEOUT_MS + 30_000);

  // -------------------------------------------------------------------------
  // Phase 6: Per-agent tab verification (focus view)
  // -------------------------------------------------------------------------

  it('renders Activity + Conversation + Tokens tabs correctly for each agent', async () => {
    await showOverlay(page, 6, 'Inspecting per-agent UI', 'Activity → Conversation → Tokens tabs');
    for (const pane of createdPanes) {
      const session = await waitForSessionWithMessages(page, pane.id, 45_000);
      expect(session.agent, `session.agent must equal pane.agent for ${pane.agent}`).toBe(pane.agent);
      expect(session.messages.length).toBeGreaterThan(pane.initialUserMessageCount ?? 0);
      expect(session.metrics.totalTokens).toBeGreaterThan(0);
      expect(session.metrics.inputTokens).toBeGreaterThan(0);
      expect(session.metrics.outputTokens).toBeGreaterThan(0);
      expect(session.metrics.toolCallCount).toBeGreaterThan(0);

      await navigateToFocusView(page, pane.id);
      await pause(STEP_PAUSE_MS);

      // Activity tab
      await switchTab(page, 'Activity', 'Prompts');
      await pause(STEP_PAUSE_MS);
      expect(
        await page.locator('text="No Activity Yet"').isVisible({ timeout: 1_000 }).catch(() => false),
      ).toBe(false);
      expect(
        await page.locator(':has-text("Prompts")').first().isVisible({ timeout: 3_000 }).catch(() => false),
      ).toBe(true);
      expect(
        await page.locator(':has-text("Tools")').first().isVisible({ timeout: 2_000 }).catch(() => false),
      ).toBe(true);

      // Conversation sub-tab — verify a tool name renders (case-insensitive for OpenCode)
      const conversationBtn = page.locator('button:has-text("Conversation")');
      if (await conversationBtn.isVisible({ timeout: 2_000 }).catch(() => false)) {
        await conversationBtn.click();
        await new Promise((r) => setTimeout(r, 800));
        const hasToolRendered = await page
          .locator(
            ':has-text("Write"), :has-text("write"), :has-text("Bash"), :has-text("bash"), :has-text("Edit"), :has-text("edit")',
          )
          .first()
          .isVisible({ timeout: 3_000 })
          .catch(() => false);
        expect(hasToolRendered, `Conversation view must render at least one tool name for ${pane.agent}`).toBe(true);
      }

      // Tokens tab
      await switchTab(page, 'Tokens', 'Context Usage');
      await pause(STEP_PAUSE_MS);
      expect(
        await page.locator('text="No Token Data"').isVisible({ timeout: 1_000 }).catch(() => false),
      ).toBe(false);
      expect(
        await page.locator(':has-text("Context Usage")').first().isVisible({ timeout: 3_000 }).catch(() => false),
      ).toBe(true);
      expect(
        await page.locator(':has-text("Total Used")').first().isVisible({ timeout: 2_000 }).catch(() => false),
      ).toBe(true);

      console.log(`[Phase 6] ${pane.agent}: Activity + Tokens tabs verified, session.agent OK`);
    }
  }, 120_000);

  // -------------------------------------------------------------------------
  // Phase 7: Cross-isolation re-check + fleet Diff tab + sidebar + budget
  // -------------------------------------------------------------------------

  it('re-verifies cross-isolation, shows Diff tab in fleet view, sidebar entries, runtime budget', async () => {
    await showOverlay(page, 7, 'Back to fleet view', 'Diff tab + sidebar verification');
    // Re-verify isolation after the follow-up turn — guards against any rogue write to the wrong worktree.
    for (let a = 0; a < createdPanes.length; a++) {
      for (let b = 0; b < createdPanes.length; b++) {
        if (a === b) continue;
        const paneA = createdPanes[a];
        const paneB = createdPanes[b];
        if (paneA.expectedFile === paneB.expectedFile) continue;
        const crossPath = resolve(paneB.worktreePath, paneA.expectedFile);
        expect(
          existsSync(crossPath),
          `Isolation violation after follow-up: ${paneA.expectedFile} from "${paneA.slug}" found in "${paneB.slug}"`,
        ).toBe(false);
      }
    }

    await navigateToFleetView(page);

    for (let i = 0; i < createdPanes.length; i++) {
      const pane = createdPanes[i];
      const cell = page.locator(`[data-testid="pane-cell"][data-pane-id="${pane.id}"]`).first();
      await cell.scrollIntoViewIfNeeded({ timeout: 5_000 }).catch(() => {});
      if (!(await cell.isVisible({ timeout: 3_000 }).catch(() => false))) {
        console.warn(`[Phase 7] PaneCell not visible for ${pane.slug}, skipping Diff tab check`);
        continue;
      }

      const diffTab = cell.locator('button[role="tab"]:has-text("Diff")').first();
      if (await diffTab.isVisible({ timeout: 2_000 }).catch(() => false)) {
        await diffTab.click();
      } else {
        const fallback = page.locator('button[role="tab"]:has-text("Diff")').nth(i);
        if (await fallback.isVisible({ timeout: 2_000 }).catch(() => false)) {
          await fallback.click();
        }
      }
      await new Promise((r) => setTimeout(r, 800));

      const hasNoChanges = await page.locator('text="No changes"').isVisible({ timeout: 1_000 }).catch(() => false);
      const hasNoWorktree = await page.locator('text="No Worktree"').isVisible({ timeout: 1_000 }).catch(() => false);
      expect(!hasNoChanges && !hasNoWorktree, `Pane ${pane.slug} Diff tab must show real content`).toBe(true);

      const hasExpectedFile = await cell
        .locator(`:has-text("${pane.expectedFile}")`)
        .first()
        .isVisible({ timeout: 3_000 })
        .catch(() => false);
      expect(hasExpectedFile, `Diff view for ${pane.slug} must show ${pane.expectedFile}`).toBe(true);
    }

    // Sidebar shows both panes. The visible label is `pane.title || pane.slug || pane.id`
    // (see Sidebar.tsx) — agents may set pane.title from session.aiTitle after the first
    // turn, so we look up the live label rather than assume the slug is shown.
    const panes = await getPanes(page);
    const statusSnapshot = await getPaneStatusSnapshot(page);
    for (const pane of createdPanes) {
      const found = panes.find((p) => p.id === pane.id);
      expect(found, `pane ${pane.slug} must be in pane:list`).toBeTruthy();
      const status = statusSnapshot.statusByPaneId[pane.id] ?? found?.agentStatus;
      expect(['idle', 'waiting']).toContain(status);

      const sidebarLabel = found?.title || found?.slug || found?.id || pane.slug;
      const byTitle = page.locator(`aside [title="${sidebarLabel}"]`).first();
      const byText = page.locator(`aside li button:has-text("${sidebarLabel}")`).first();
      const visible =
        (await byTitle.isVisible({ timeout: 1_000 }).catch(() => false)) ||
        (await byText.isVisible({ timeout: 1_000 }).catch(() => false));
      expect(
        visible,
        `Sidebar must show pane (slug=${pane.slug}, displayed label="${sidebarLabel}")`,
      ).toBe(true);
    }

    // Console error sanity
    const criticalErrors = consoleErrors.filter(
      (e) => !e.includes('Autofill.enable') && !e.includes('Autofill.setAddresses') && !e.includes('favicon.ico'),
    );
    if (criticalErrors.length > 0) {
      console.warn(`[Phase 7] ${criticalErrors.length} non-fatal console errors observed (first 3):`);
      criticalErrors.slice(0, 3).forEach((e, i) => console.warn(`  ${i + 1}. ${e}`));
    }

    const elapsedMs = Date.now() - suiteStartMs;
    expect(
      elapsedMs,
      `Total runtime ${Math.round(elapsedMs / 1000)}s exceeded budget ${TOTAL_RUNTIME_BUDGET_MS / 1000}s`,
    ).toBeLessThanOrEqual(TOTAL_RUNTIME_BUDGET_MS);

    console.log(`[Phase 7] All checks passed. Total runtime: ${Math.round(elapsedMs / 1000)}s`);
    if (SLOW) {
      await showOverlay(
        page,
        7,
        '✓ All phases passed',
        `Holding window open for ${HOLD_AT_END_MS / 1000}s so you can inspect…`,
      );
      await pause(HOLD_AT_END_MS);
      await hideOverlay(page);
    }
  }, 60_000 + HOLD_AT_END_MS);
});
