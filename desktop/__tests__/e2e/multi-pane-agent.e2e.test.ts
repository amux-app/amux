import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { _electron as electron } from 'playwright';
import type { ElectronApplication, Page, ConsoleMessage } from 'playwright';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { getProjectConfigPath, type AumxPane } from 'aumx/core';
import type { NormalizedSession } from '../../src/shared/agent-session-types';
import {
  type PhaseResult,
  closePaneBestEffort,
  getAppWindow,
  getGitDiff,
  getPanes,
  getSessionInfo,
  getSystemCheck,
  killMultiPaneTestSessionBestEffort,
  pollUntil,
} from './e2e-helpers';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ROOT = resolve(__dirname, '..', '..');
const MAIN_ENTRY = resolve(ROOT, 'out', 'main', 'index.js');
const SCREENSHOTS_DIR = resolve(ROOT, 'out');
const REPORT_PATH = resolve(SCREENSHOTS_DIR, 'e2e-multi-pane-report.html');

const ENABLE_SCREENSHOTS = process.env.AUMX_E2E_SCREENSHOTS === '1';
const AGENT_WORK_TIMEOUT = 180_000;
const PANE_CREATION_TIMEOUT = 20_000;
const TOTAL_RUNTIME_BUDGET_MS = (() => {
  const parsed = Number(process.env.AUMX_E2E_MAX_MS ?? '300000');
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 300_000;
})();
const ACTIVE_AGENT_STATES = new Set(['working', 'analyzing', 'waiting']);
const RUN_TOKEN = `e2e-${Date.now().toString(36)}`;

interface CreatedPane {
  id: string;
  slug: string;
  agent?: string;
  worktreePath?: string;
  paneId: string;
  expectedFile: string;
  createdAtMs: number;
  completedAtMs: number;
  succeeded: boolean;
}

// ---------------------------------------------------------------------------
// Report Data Collector
// ---------------------------------------------------------------------------

interface PaneReport {
  index: number;
  id: string;
  slug: string;
  agent: string;
  paneId: string;
  worktreePath: string;
  expectedFile: string;
  prompt: string;

  // Phase 1 — pane config
  branchName: string;
  type: string;
  promptStored: boolean;
  worktreePathValid: boolean;
  worktreeUnderAumx: boolean;
  tmuxPaneIdFormat: boolean;
  configHasPane: boolean;
  configPromptMatch: boolean;
  configAgentMatch: boolean;
  configPaneIdMatch: boolean;
  configWorktreeMatch: boolean;

  // Phase 2 — agent completion
  agentCompleted: boolean;
  agentStatus: string;
  agentDurationMs: number;

  // Phase 3 — file + git deep verification
  fileExists: boolean;
  fileContentValid: boolean;
  fileContentSnippet: string;
  fileSizeBytes: number;
  gitChanges: boolean;
  gitBranch: string;
  gitBranchIsFeature: boolean;
  gitRepoRoot: string;
  gitIsWorktree: boolean;
  gitIsGitRepo: boolean;
  filesChanged: number;
  untrackedFiles: number;
  changedFilesList: string[];
  untrackedFilesList: string[];
  expectedFileInDiff: boolean;
  fileVerified: boolean;

  // Phase 3 — session tool verification
  agentUsedWriteTool: boolean;
  agentToolErrors: number;
  toolCallNames: string[];

  session: {
    messageCount: number;
    totalTokens: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    toolCallCount: number;
    isOngoing: boolean;
  } | null;
  activityVerified: boolean;
  conversationVerified: boolean;
  tokensVerified: boolean;
  diffVerified: boolean;
}

interface ReportData {
  startTime: number;
  endTime: number;
  systemCheck: { tmux: string; git: string; agents: string[] } | null;
  phases: PhaseResult[];
  panes: PaneReport[];
  consoleErrors: string[];
  screenshots: { name: string; path: string }[];
}

const report: ReportData = {
  startTime: Date.now(),
  endTime: 0,
  systemCheck: null,
  phases: [],
  panes: [],
  consoleErrors: [],
  screenshots: [],
};

// ---------------------------------------------------------------------------
// Prompts — intentionally simple for fast agent execution
// ---------------------------------------------------------------------------

const PANE_PROMPTS = [
  {
    prompt: `${RUN_TOKEN} API task: create api.js using built-in Node.js http module that returns "Hello World" on GET / and listens on port 3000. Do not install dependencies.`,
    expectedFile: 'api.js',
    contentPatterns: [/http/i, /createServer\s*\(/i, /listen\s*\(/i, /hello\s*world/i],
  },
  {
    prompt: `${RUN_TOKEN} HTML task: create index.html with a basic HTML page that says Hello World`,
    expectedFile: 'index.html',
    contentPatterns: [/<html|<!doctype/i, /hello\s*world/i],
  },
];
const EXPECTED_PANES = PANE_PROMPTS.length;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function getSession(page: Page, paneId: string): Promise<{ session?: NormalizedSession; error?: string }> {
  return page.evaluate(
    (id) => (window as any).aumx.invoke('agent-session:get', { paneId: id }),
    paneId,
  );
}

async function createPaneViaIPC(page: Page, prompt: string, projectRoot: string): Promise<AumxPane> {
  const response = await page.evaluate(
    (payload) =>
      (window as any).aumx.invoke('pane:create', {
        prompt: payload.prompt,
        agent: 'claude',
        projectRoot: payload.projectRoot,
        useWorktree: true,
      }),
    { prompt, projectRoot },
  );

  if (!response?.success || !response?.pane) {
    throw new Error(`pane:create failed: ${response?.error ?? 'unknown error'}`);
  }
  return response.pane as AumxPane;
}

async function navigateToFocusView(page: Page, paneId: string): Promise<void> {
  // Navigate to the pane's focus view by setting Zustand UI store state directly.
  // The stores are exposed on window.__aumxStores by the renderer's store index.
  const navigated = await page.evaluate((id) => {
    const stores = (window as any).__aumxStores;
    if (stores?.ui?.setState) {
      stores.ui.setState({ viewMode: 'focus', focusPaneId: id });
      return true;
    }
    return false;
  }, paneId);

  if (!navigated) {
    // Fallback: click the "Focus pane" button on the PaneCell in fleet view
    const focusBtn = page.locator('button[aria-label="Focus pane"]').first();
    if (await focusBtn.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await focusBtn.click();
    }
  }

  // Wait for tab bar to appear (proves focus view is rendered)
  await page.locator('button[role="tab"]').first().waitFor({ state: 'visible', timeout: 5_000 });
}

async function switchTab(page: Page, tabName: string, waitForText?: string): Promise<void> {
  const tab = page.locator(`button[role="tab"]:has-text("${tabName}")`);
  if (await tab.isVisible({ timeout: 3_000 }).catch(() => false)) {
    await tab.click();
    // Wait for tab content to render by waiting for a known element
    if (waitForText) {
      await page.locator(`text="${waitForText}"`).waitFor({ state: 'visible', timeout: 5_000 }).catch(() => {});
    }
  } else {
    console.warn(`switchTab: tab "${tabName}" not visible`);
  }
}

async function screenshotStep(page: Page, name: string): Promise<void> {
  if (!ENABLE_SCREENSHOTS) return;
  const filename = `e2e-multi-${name}.png`;
  const filepath = resolve(SCREENSHOTS_DIR, filename);
  await page.screenshot({ path: filepath });
  report.screenshots.push({ name, path: filepath });
}

async function showOverlay(
  page: Page,
  phase: number,
  title: string,
  detail?: string,
): Promise<void> {
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
          min-width:360px;max-width:480px;
          padding:22px 26px;
          background:none;
          font-family:-apple-system,BlinkMacSystemFont,'Inter',sans-serif;
          animation:__e2e_slide 0.35s cubic-bezier(0.16,1,0.3,1);
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

async function navigateToFleetView(page: Page): Promise<void> {
  const navigated = await page.evaluate(() => {
    const stores = (window as any).__aumxStores;
    if (stores?.ui?.setState) {
      stores.ui.setState({ viewMode: 'fleet', focusPaneId: null });
      return true;
    }
    return false;
  });

  if (!navigated) {
    // Fallback: click the "Fleet" button in the ResourceBar
    const fleetBtn = page.locator('button:has-text("Fleet")').first();
    if (await fleetBtn.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await fleetBtn.click();
    }
  }
  await new Promise((r) => setTimeout(r, 500));
}

interface StatusSnapshot {
  statusByPaneId: Record<string, string>;
  historyByPaneId: Record<string, Array<{ status: string; ts: number }>>;
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

async function getPaneStatusSnapshot(page: Page): Promise<StatusSnapshot> {
  return page.evaluate(() => {
    const w = window as any;
    const statusByPaneId = { ...(w.__aumxPaneStatusById ?? {}) };
    const history = w.__aumxPaneStatusHistoryById ?? {};
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

      const activeNow = currentStatuses.filter((status) => ACTIVE_AGENT_STATES.has(status)).length;
      maxConcurrentActive = Math.max(maxConcurrentActive, activeNow);

      const allSettled = currentStatuses.every((status) => status === 'idle' || status === 'waiting');
      if (!allSettled) return null;

      // Guard: freshly created panes may show idle before the agent starts.
      // Require that at least one active state was ever observed, or that enough
      // time has elapsed since creation for the agent to have started and finished.
      const hasEverBeenActive = paneIds.some((paneId) => {
        const history = snapshot.historyByPaneId[paneId] ?? [];
        return history.some((s) => ACTIVE_AGENT_STATES.has(s.status));
      });
      const elapsedSinceCreation = Date.now() - latestCreationMs;
      if (!hasEverBeenActive && elapsedSinceCreation < 30_000) {
        return null; // Agents haven't started yet — keep waiting
      }

      const firstSettledTimes = paneIds.map((paneId) => {
        const history = snapshot.historyByPaneId[paneId] ?? [];
        const firstSettled = history.find((sample) => sample.status === 'idle' || sample.status === 'waiting');
        return firstSettled?.ts ?? Number.NaN;
      });
      const hasAllSettledTimestamps = firstSettledTimes.every((ts) => Number.isFinite(ts));
      const earliestSettledMs = hasAllSettledTimestamps ? Math.min(...firstSettledTimes) : Number.NaN;

      // Parallel heuristic: all panes were launched before any pane reached a final state.
      const overlapConfirmed = hasAllSettledTimestamps && latestCreationMs <= earliestSettledMs;

      return { maxConcurrentActive, overlapConfirmed };
    },
    { timeout, interval: 750, label: 'waitForAllPanesIdle' },
  );
}

async function waitForSessionData(
  page: Page,
  paneId: string,
  timeout: number,
): Promise<NormalizedSession> {
  return pollUntil(
    async () => {
      const result = await getSession(page, paneId);
      if (result?.error) return null;
      const session = result?.session;
      if (!session) return null;
      if (session.messages?.length > 0 && session.metrics?.totalTokens > 0) {
        return session;
      }
      return null;
    },
    { timeout, interval: 3_000, label: `waitForSessionData(${paneId})` },
  );
}

async function waitForSessionToolUsage(
  page: Page,
  paneId: string,
  timeout: number,
): Promise<NormalizedSession> {
  return pollUntil(
    async () => {
      const result = await getSession(page, paneId);
      if (result?.error) return null;
      const session = result?.session;
      if (!session) return null;
      const hasToolCall = (session.messages ?? []).some((m) => (m.toolCalls?.length ?? 0) > 0);
      return hasToolCall ? session : null;
    },
    { timeout, interval: 2_000, label: `waitForSessionToolUsage(${paneId})` },
  );
}

interface SessionWindow {
  paneId: string;
  startMs?: number;
  endMs?: number;
}

function finiteNumbers(values: Array<number | undefined>): number[] {
  return values.filter((value): value is number => Number.isFinite(value));
}

async function getSessionWindows(page: Page, paneIds: string[]): Promise<SessionWindow[]> {
  const windows: SessionWindow[] = [];
  for (const paneId of paneIds) {
    const result = await getSession(page, paneId);
    const session = result?.session;
    if (!session) {
      windows.push({ paneId });
      continue;
    }
    const messageTimestamps = finiteNumbers((session.messages ?? []).map((m) => m.timestamp));
    const starts = finiteNumbers([session.startTime, ...messageTimestamps]);
    const ends = finiteNumbers([session.lastUpdateTime, ...messageTimestamps]);
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
      Number.isFinite(w.startMs) && Number.isFinite(w.endMs) && w.endMs >= w.startMs,
  );
  if (valid.length < 2) return { observed: false, overlapMs: 0 };
  const latestStart = Math.max(...valid.map((w) => w.startMs));
  const earliestEnd = Math.min(...valid.map((w) => w.endMs));
  const overlapMs = Math.max(0, earliestEnd - latestStart);
  return { observed: overlapMs > 0, overlapMs };
}

// ---------------------------------------------------------------------------
// Report Generation
// ---------------------------------------------------------------------------

function embedScreenshot(filepath: string): string {
  try {
    if (!existsSync(filepath)) return '';
    const buf = readFileSync(filepath);
    return `data:image/png;base64,${buf.toString('base64')}`;
  } catch {
    return '';
  }
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function fmtDuration(ms: number): string {
  if (ms < 1_000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`;
  const mins = Math.floor(ms / 60_000);
  const secs = Math.round((ms % 60_000) / 1_000);
  return `${mins}m ${secs}s`;
}

function generateReport(): string {
  const totalDuration = report.endTime - report.startTime;
  const passedPhases = report.phases.filter((p) => p.status === 'passed').length;
  const totalPhases = report.phases.filter((p) => p.status !== 'skipped').length;
  const succeededPanes = report.panes.filter((p) => p.agentCompleted).length;
  const totalPanes = report.panes.length;
  const totalTokensUsed = report.panes.reduce((sum, p) => sum + (p.session?.totalTokens ?? 0), 0);
  const totalInputTokens = report.panes.reduce((sum, p) => sum + (p.session?.inputTokens ?? 0), 0);
  const totalOutputTokens = report.panes.reduce((sum, p) => sum + (p.session?.outputTokens ?? 0), 0);
  const totalCacheRead = report.panes.reduce((sum, p) => sum + (p.session?.cacheReadTokens ?? 0), 0);
  const totalCacheCreate = report.panes.reduce((sum, p) => sum + (p.session?.cacheCreationTokens ?? 0), 0);
  const totalToolCalls = report.panes.reduce((sum, p) => sum + (p.session?.toolCallCount ?? 0), 0);
  const totalMessages = report.panes.reduce((sum, p) => sum + (p.session?.messageCount ?? 0), 0);
  const totalFilesChanged = report.panes.reduce((sum, p) => sum + p.filesChanged + p.untrackedFiles, 0);
  const worktreesValid = report.panes.filter((p) => p.gitIsWorktree && p.gitBranchIsFeature).length;
  const avgAgentTime = succeededPanes > 0
    ? report.panes.filter((p) => p.agentDurationMs > 0).reduce((s, p) => s + p.agentDurationMs, 0) / succeededPanes
    : 0;
  const cacheHitRate = totalInputTokens > 0 ? (totalCacheRead / (totalCacheRead + totalInputTokens)) * 100 : 0;
  const totalChecksPerPane = 17;
  const overallStatus = passedPhases === totalPhases ? 'PASSED' : 'FAILED';

  // Token bar helper: renders a proportional bar
  function tokenBar(value: number, color: string, maxVal: number): string {
    const pct = maxVal > 0 ? Math.round((value / maxVal) * 100) : 0;
    return `<div style="display:flex;align-items:center;gap:8px"><div style="flex:1;height:6px;background:var(--border);border-radius:3px;overflow:hidden"><div style="width:${pct}%;height:100%;background:${color};border-radius:3px"></div></div><span class="mono" style="font-size:11px;min-width:48px;text-align:right">${fmtTokens(value)}</span></div>`;
  }

  const paneCards = report.panes
    .map((p) => {
      const statusColor = p.agentCompleted ? '#4ade80' : '#f87171';
      const statusLabel = p.agentCompleted ? 'Completed' : 'Failed';
      const passedChecks = [
        p.agentCompleted, p.configHasPane, p.configPromptMatch, p.configWorktreeMatch,
        p.fileExists, p.fileContentValid, p.gitIsWorktree, p.gitBranchIsFeature,
        p.expectedFileInDiff, p.agentUsedWriteTool, p.agentToolErrors === 0,
        p.tmuxPaneIdFormat, p.worktreeUnderAumx, p.activityVerified,
        p.conversationVerified, p.tokensVerified, p.diffVerified,
      ].filter(Boolean).length;

      const checks = [
        { label: 'Agent Completed', ok: p.agentCompleted, cat: 'agent' },
        { label: 'Config Stored', ok: p.configHasPane, cat: 'config' },
        { label: 'Config Prompt', ok: p.configPromptMatch, cat: 'config' },
        { label: 'Config Worktree', ok: p.configWorktreeMatch, cat: 'config' },
        { label: 'Config Agent', ok: p.configAgentMatch, cat: 'config' },
        { label: 'Config Pane ID', ok: p.configPaneIdMatch, cat: 'config' },
        { label: 'File Exists', ok: p.fileExists, cat: 'file' },
        { label: 'Content Valid', ok: p.fileContentValid, cat: 'file' },
        { label: 'File in Diff', ok: p.expectedFileInDiff, cat: 'file' },
        { label: 'Git Worktree', ok: p.gitIsWorktree, cat: 'git' },
        { label: 'Feature Branch', ok: p.gitBranchIsFeature, cat: 'git' },
        { label: 'tmux ID Valid', ok: p.tmuxPaneIdFormat, cat: 'git' },
        { label: 'Path Under .aumx', ok: p.worktreeUnderAumx, cat: 'git' },
        { label: 'Write Tool Used', ok: p.agentUsedWriteTool, cat: 'agent' },
        { label: 'No Tool Errors', ok: p.agentToolErrors === 0, cat: 'agent' },
        { label: 'Activity Tab', ok: p.activityVerified, cat: 'ui' },
        { label: 'Conversation', ok: p.conversationVerified, cat: 'ui' },
        { label: 'Tokens Tab', ok: p.tokensVerified, cat: 'ui' },
        { label: 'Diff Tab', ok: p.diffVerified, cat: 'ui' },
      ];
      const checkRows = checks
        .map((c) => `<span class="check ${c.ok ? 'pass' : 'fail'}">${c.ok ? '\u2713' : '\u2717'} ${c.label}</span>`)
        .join('');

      const paneTokenMax = p.session?.totalTokens ?? 1;
      const tokenSection = p.session ? `
          <div class="detail-section" style="grid-column:1/-1">
            <h4>Token Usage Breakdown</h4>
            <div style="display:grid;grid-template-columns:100px 1fr;gap:6px 12px;align-items:center">
              <span style="font-size:11px;color:var(--text-muted)">Input</span>
              ${tokenBar(p.session.inputTokens, '#60a5fa', paneTokenMax)}
              <span style="font-size:11px;color:var(--text-muted)">Output</span>
              ${tokenBar(p.session.outputTokens, '#a78bfa', paneTokenMax)}
              <span style="font-size:11px;color:var(--text-muted)">Cache Read</span>
              ${tokenBar(p.session.cacheReadTokens, '#4ade80', paneTokenMax)}
              <span style="font-size:11px;color:var(--text-muted)">Cache Create</span>
              ${tokenBar(p.session.cacheCreationTokens, '#fb923c', paneTokenMax)}
            </div>
            <div style="margin-top:10px;display:flex;gap:16px;flex-wrap:wrap">
              <span class="metric-pill"><strong>${fmtTokens(p.session.totalTokens)}</strong> total</span>
              <span class="metric-pill"><strong>${p.session.messageCount}</strong> messages</span>
              <span class="metric-pill"><strong>${p.session.toolCallCount}</strong> tool calls</span>
              <span class="metric-pill">${p.session.isOngoing ? '<span style="color:#4ade80">\u25CF</span> Live' : '<span style="color:#6b7280">\u25CF</span> Done'}</span>
            </div>
          </div>` : '';

      const fileSnippet = p.fileContentSnippet
        ? `<div class="detail-section" style="grid-column:1/-1">
            <h4>File Content Preview (${p.expectedFile}, ${p.fileSizeBytes}B)</h4>
            <pre class="file-preview">${esc(p.fileContentSnippet)}${p.fileContentSnippet.length >= 200 ? '...' : ''}</pre>
          </div>`
        : '';

      const toolsList = p.toolCallNames.length > 0
        ? `<div class="detail-section" style="grid-column:1/-1">
            <h4>Agent Tool Calls (${p.toolCallNames.length})</h4>
            <div style="display:flex;flex-wrap:wrap;gap:4px">${[...new Set(p.toolCallNames)].map((t) => `<code style="font-size:11px;background:var(--surface);padding:2px 6px;border-radius:4px">${esc(t)} <span style="color:var(--text-muted)">\u00d7${p.toolCallNames.filter((n) => n === t).length}</span></code>`).join('')}</div>
          </div>`
        : '';

      const gitFilesList = [...p.changedFilesList, ...p.untrackedFilesList];
      const gitFilesHtml = gitFilesList.length > 0
        ? `<div class="detail-section" style="grid-column:1/-1">
            <h4>Git Diff Files (${p.filesChanged} changed, ${p.untrackedFiles} untracked)</h4>
            <div style="display:flex;flex-wrap:wrap;gap:4px">${gitFilesList.map((f) => {
              const isExpected = f === p.expectedFile || f.endsWith(`/${p.expectedFile}`);
              return `<code style="font-size:11px;background:${isExpected ? 'rgba(74,222,128,0.12)' : 'var(--surface)'};color:${isExpected ? 'var(--green)' : 'var(--text)'};padding:2px 6px;border-radius:4px;border:1px solid ${isExpected ? 'rgba(74,222,128,0.3)' : 'var(--border)'}">${esc(f)}</code>`;
            }).join('')}</div>
          </div>`
        : '';

      const paneScreenshots = report.screenshots
        .filter((s) => s.name.includes(`pane-${p.index}`))
        .map((s) => {
          const data = embedScreenshot(s.path);
          return data
            ? `<div class="screenshot-thumb"><img src="${data}" alt="${s.name}" loading="lazy"/><span>${s.name}</span></div>`
            : '';
        })
        .join('');

      return `
      <div class="pane-card">
        <div class="pane-header">
          <div class="pane-title">
            <span class="pane-index">#${p.index + 1}</span>
            <span class="pane-slug">${esc(p.slug)}</span>
            <span class="status-badge" style="background:${statusColor}20;color:${statusColor};border:1px solid ${statusColor}40">${statusLabel}</span>
            <span class="status-badge" style="background:rgba(88,166,255,0.12);color:var(--accent);border:1px solid rgba(88,166,255,0.25)">${passedChecks}/${totalChecksPerPane} checks</span>
            ${p.agentDurationMs > 0 ? `<span class="status-badge" style="background:rgba(251,146,60,0.12);color:var(--orange);border:1px solid rgba(251,146,60,0.25)">${fmtDuration(p.agentDurationMs)}</span>` : ''}
          </div>
          <span class="pane-agent">${esc(p.agent)}</span>
        </div>
        <div class="pane-prompt">${esc(p.prompt)}</div>
        <div class="checks-row">${checkRows}</div>
        <div class="pane-details">
          <div class="detail-section">
            <h4>Pane Configuration</h4>
            <table>
              <tr><td>aumx ID</td><td><code>${esc(p.id)}</code></td></tr>
              <tr><td>tmux Pane ID</td><td><code>${esc(p.paneId)}</code></td></tr>
              <tr><td>Slug</td><td><code>${esc(p.slug)}</code></td></tr>
              <tr><td>Branch Name</td><td><code>${esc(p.branchName || 'N/A')}</code></td></tr>
              <tr><td>Type</td><td><code>${esc(p.type)}</code></td></tr>
              <tr><td>Agent</td><td><code>${esc(p.agent)}</code></td></tr>
              <tr><td>Agent Status</td><td><code>${esc(p.agentStatus)}</code></td></tr>
              <tr><td>Agent Duration</td><td>${p.agentDurationMs > 0 ? fmtDuration(p.agentDurationMs) : 'N/A'}</td></tr>
              <tr><td>Prompt Stored</td><td>${p.promptStored ? '\u2713 Yes' : '\u2717 No'}</td></tr>
            </table>
          </div>
          <div class="detail-section">
            <h4>Config Persistence (aumx.config.json)</h4>
            <table>
              <tr><td>Entry Exists</td><td>${p.configHasPane ? '\u2713 Yes' : '\u2717 No'}</td></tr>
              <tr><td>Prompt Matches</td><td>${p.configPromptMatch ? '\u2713' : '\u2717'}</td></tr>
              <tr><td>Agent Matches</td><td>${p.configAgentMatch ? '\u2713' : '\u2717'}</td></tr>
              <tr><td>Pane ID Matches</td><td>${p.configPaneIdMatch ? '\u2713' : '\u2717'}</td></tr>
              <tr><td>Worktree Matches</td><td>${p.configWorktreeMatch ? '\u2713' : '\u2717'}</td></tr>
            </table>
          </div>
          <div class="detail-section">
            <h4>Git Worktree Isolation</h4>
            <table>
              <tr><td>Worktree Path</td><td><code style="font-size:10px">${esc(p.worktreePath || 'N/A')}</code></td></tr>
              <tr><td>Path Valid</td><td>${p.worktreePathValid ? '\u2713' : '\u2717'}</td></tr>
              <tr><td>Under .aumx/</td><td>${p.worktreeUnderAumx ? '\u2713' : '\u2717'}</td></tr>
              <tr><td>Is Git Repo</td><td>${p.gitIsGitRepo ? '\u2713' : '\u2717'}</td></tr>
              <tr><td>Is Worktree</td><td>${p.gitIsWorktree ? '\u2713' : '\u2717'}</td></tr>
              <tr><td>Branch</td><td><code>${esc(p.gitBranch || 'N/A')}</code></td></tr>
              <tr><td>Feature Branch</td><td>${p.gitBranchIsFeature ? '\u2713 Yes (not main/master)' : '\u2717 No'}</td></tr>
              <tr><td>Repo Root</td><td><code style="font-size:10px">${esc(p.gitRepoRoot || 'N/A')}</code></td></tr>
            </table>
          </div>
          <div class="detail-section">
            <h4>File Verification</h4>
            <table>
              <tr><td>Expected File</td><td><code>${esc(p.expectedFile)}</code></td></tr>
              <tr><td>File Exists</td><td>${p.fileExists ? '\u2713' : '\u2717'}</td></tr>
              <tr><td>Content Valid</td><td>${p.fileContentValid ? '\u2713 All patterns matched' : '\u2717 Pattern mismatch'}</td></tr>
              <tr><td>File Size</td><td>${p.fileSizeBytes}B</td></tr>
              <tr><td>In Git Diff</td><td>${p.expectedFileInDiff ? '\u2713' : '\u2717'}</td></tr>
              <tr><td>Files Changed</td><td>${p.filesChanged}</td></tr>
              <tr><td>Untracked Files</td><td>${p.untrackedFiles}</td></tr>
              <tr><td>Total Git Files</td><td>${p.filesChanged + p.untrackedFiles}</td></tr>
            </table>
          </div>
          ${tokenSection}
          ${fileSnippet}
          ${toolsList}
          ${gitFilesHtml}
        </div>
        ${paneScreenshots ? `<div class="pane-screenshots">${paneScreenshots}</div>` : ''}
      </div>`;
    })
    .join('');

  const phaseRows = report.phases
    .map((p) => {
      const icon = p.status === 'passed' ? '\u2713' : p.status === 'failed' ? '\u2717' : '\u2014';
      const color = p.status === 'passed' ? '#4ade80' : p.status === 'failed' ? '#f87171' : '#6b7280';
      return `
      <tr>
        <td><span style="color:${color};font-weight:600">${icon}</span></td>
        <td>${esc(p.name)}</td>
        <td><span class="status-badge" style="background:${color}20;color:${color};border:1px solid ${color}40">${p.status}</span></td>
        <td class="mono">${fmtDuration(p.durationMs)}</td>
        <td style="color:#f87171">${p.error ? esc(p.error) : ''}</td>
      </tr>`;
    })
    .join('');

  // Global screenshots (non-pane-specific)
  const globalScreenshots = report.screenshots
    .filter((s) => !s.name.match(/pane-\d/))
    .map((s) => {
      const data = embedScreenshot(s.path);
      return data
        ? `<div class="screenshot-card"><img src="${data}" alt="${s.name}" loading="lazy"/><span>${s.name}</span></div>`
        : '';
    })
    .join('');

  const errorsSection =
    report.consoleErrors.length > 0
      ? `<section class="section">
          <h2>Console Errors</h2>
          <div class="errors-list">${report.consoleErrors.map((e) => `<pre class="error-line">${esc(e)}</pre>`).join('')}</div>
        </section>`
      : '';

  const statusColor = overallStatus === 'PASSED' ? '#4ade80' : '#f87171';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>aumx Multi-Pane Agent E2E Report</title>
<style>
  :root {
    --bg: #0d1117;
    --surface: #161b22;
    --surface2: #1c2128;
    --border: #30363d;
    --text: #e6edf3;
    --text-muted: #8b949e;
    --accent: #58a6ff;
    --green: #4ade80;
    --red: #f87171;
    --orange: #fb923c;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', sans-serif;
    background: var(--bg);
    color: var(--text);
    line-height: 1.6;
    min-height: 100vh;
  }
  .container { max-width: 1200px; margin: 0 auto; padding: 32px 24px; }

  /* Header */
  .report-header {
    background: linear-gradient(135deg, var(--surface) 0%, var(--surface2) 100%);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 32px;
    margin-bottom: 24px;
  }
  .report-header h1 {
    font-size: 24px;
    font-weight: 700;
    margin-bottom: 4px;
    display: flex;
    align-items: center;
    gap: 12px;
  }
  .report-header .subtitle {
    color: var(--text-muted);
    font-size: 14px;
    margin-bottom: 20px;
  }
  .summary-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
    gap: 16px;
  }
  .summary-card {
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 16px;
    text-align: center;
  }
  .summary-card .value {
    font-size: 28px;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
  }
  .summary-card .label {
    font-size: 11px;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin-top: 4px;
  }

  /* Sections */
  .section {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 24px;
    margin-bottom: 24px;
  }
  .section h2 {
    font-size: 16px;
    font-weight: 600;
    margin-bottom: 16px;
    padding-bottom: 12px;
    border-bottom: 1px solid var(--border);
  }
  .section h2 .badge {
    font-size: 11px;
    font-weight: 500;
    padding: 2px 8px;
    border-radius: 9999px;
    margin-left: 8px;
    vertical-align: middle;
  }

  /* Phase table */
  .phase-table { width: 100%; border-collapse: collapse; }
  .phase-table th {
    text-align: left;
    font-size: 11px;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    padding: 8px 12px;
    border-bottom: 1px solid var(--border);
  }
  .phase-table td {
    padding: 10px 12px;
    border-bottom: 1px solid var(--border);
    font-size: 13px;
  }
  .phase-table tr:last-child td { border-bottom: none; }
  .mono { font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', monospace; font-size: 12px; }

  /* Status badge */
  .status-badge {
    display: inline-block;
    font-size: 11px;
    font-weight: 600;
    padding: 2px 10px;
    border-radius: 9999px;
    text-transform: uppercase;
    letter-spacing: 0.03em;
  }

  /* Pane cards */
  .pane-cards { display: flex; flex-direction: column; gap: 16px; }
  .pane-card {
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 20px;
    transition: border-color 0.15s;
  }
  .pane-card:hover { border-color: var(--accent); }
  .pane-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 8px;
  }
  .pane-title { display: flex; align-items: center; gap: 10px; }
  .pane-index {
    font-size: 12px;
    font-weight: 700;
    color: var(--accent);
    background: var(--accent);
    background: rgba(88, 166, 255, 0.12);
    padding: 2px 8px;
    border-radius: 6px;
  }
  .pane-slug { font-size: 15px; font-weight: 600; }
  .pane-agent {
    font-size: 12px;
    color: var(--text-muted);
    font-family: 'SF Mono', 'Fira Code', monospace;
  }
  .pane-prompt {
    background: var(--surface2);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 10px 14px;
    font-size: 13px;
    color: var(--text-muted);
    margin-bottom: 16px;
    line-height: 1.5;
  }
  .pane-details {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 16px;
    margin-bottom: 16px;
  }
  @media (max-width: 768px) { .pane-details { grid-template-columns: 1fr; } }
  .detail-section h4 {
    font-size: 11px;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin-bottom: 8px;
  }
  .detail-section table { width: 100%; border-collapse: collapse; }
  .detail-section td {
    padding: 4px 0;
    font-size: 12px;
    border-bottom: 1px solid var(--border);
  }
  .detail-section td:first-child { color: var(--text-muted); width: 45%; }
  .detail-section td:last-child { text-align: right; }
  .detail-section code {
    font-family: 'SF Mono', 'Fira Code', monospace;
    font-size: 11px;
    background: var(--surface);
    padding: 1px 6px;
    border-radius: 4px;
    word-break: break-all;
  }

  /* Checks */
  .checks-row { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 12px; }
  .check {
    font-size: 11px;
    font-weight: 500;
    padding: 3px 10px;
    border-radius: 6px;
  }
  .check.pass { background: rgba(74, 222, 128, 0.1); color: var(--green); border: 1px solid rgba(74, 222, 128, 0.2); }
  .check.fail { background: rgba(248, 113, 113, 0.1); color: var(--red); border: 1px solid rgba(248, 113, 113, 0.2); }

  /* Metric pills */
  .metric-pill {
    font-size: 11px;
    color: var(--text-muted);
    background: var(--surface);
    padding: 3px 10px;
    border-radius: 6px;
    border: 1px solid var(--border);
  }
  .metric-pill strong {
    color: var(--text);
    font-weight: 600;
  }

  /* File preview */
  .file-preview {
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 12px 14px;
    font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', monospace;
    font-size: 11px;
    color: var(--text-muted);
    white-space: pre-wrap;
    word-break: break-all;
    max-height: 160px;
    overflow-y: auto;
    line-height: 1.5;
  }

  /* Screenshots */
  .screenshots-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
    gap: 16px;
  }
  .screenshot-card {
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 8px;
    overflow: hidden;
    transition: border-color 0.15s;
  }
  .screenshot-card:hover { border-color: var(--accent); }
  .screenshot-card img { width: 100%; display: block; }
  .screenshot-card span {
    display: block;
    padding: 8px 12px;
    font-size: 11px;
    color: var(--text-muted);
    font-family: 'SF Mono', 'Fira Code', monospace;
    border-top: 1px solid var(--border);
  }
  .pane-screenshots {
    display: flex;
    gap: 8px;
    overflow-x: auto;
    padding: 4px 0;
  }
  .screenshot-thumb {
    flex-shrink: 0;
    width: 200px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 6px;
    overflow: hidden;
  }
  .screenshot-thumb img { width: 100%; display: block; }
  .screenshot-thumb span {
    display: block;
    padding: 4px 8px;
    font-size: 10px;
    color: var(--text-muted);
    font-family: 'SF Mono', 'Fira Code', monospace;
    border-top: 1px solid var(--border);
  }

  /* Errors */
  .errors-list { display: flex; flex-direction: column; gap: 8px; }
  .error-line {
    background: rgba(248, 113, 113, 0.06);
    border: 1px solid rgba(248, 113, 113, 0.15);
    border-radius: 6px;
    padding: 10px 14px;
    font-family: 'SF Mono', 'Fira Code', monospace;
    font-size: 12px;
    color: var(--red);
    white-space: pre-wrap;
    word-break: break-all;
  }

  /* How it works */
  .how-section {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    gap: 16px;
  }
  .how-card {
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 16px;
  }
  .how-card .step-num {
    font-size: 11px;
    font-weight: 700;
    color: var(--accent);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin-bottom: 6px;
  }
  .how-card h4 { font-size: 13px; font-weight: 600; margin-bottom: 4px; }
  .how-card p { font-size: 12px; color: var(--text-muted); line-height: 1.5; }

  /* Footer */
  .report-footer {
    text-align: center;
    color: var(--text-muted);
    font-size: 12px;
    padding: 24px 0;
    border-top: 1px solid var(--border);
    margin-top: 8px;
  }
</style>
</head>
<body>
<div class="container">
  <!-- Header -->
  <div class="report-header">
    <h1>
      Multi-Pane Agent E2E Report
      <span class="status-badge" style="background:${statusColor}20;color:${statusColor};border:1px solid ${statusColor}40;font-size:13px">${overallStatus}</span>
    </h1>
    <p class="subtitle">
      ${new Date(report.startTime).toLocaleString()} &mdash; Total duration: ${fmtDuration(totalDuration)}
    </p>
    <div class="summary-grid">
      <div class="summary-card">
        <div class="value" style="color:${statusColor}">${passedPhases}/${totalPhases}</div>
        <div class="label">Phases Passed</div>
      </div>
      <div class="summary-card">
        <div class="value" style="color:${succeededPanes === totalPanes ? 'var(--green)' : 'var(--orange)'}">${succeededPanes}/${totalPanes}</div>
        <div class="label">Agents Completed</div>
      </div>
      <div class="summary-card">
        <div class="value" style="color:${worktreesValid === totalPanes ? 'var(--green)' : 'var(--orange)'}">${worktreesValid}/${totalPanes}</div>
        <div class="label">Worktrees Isolated</div>
      </div>
      <div class="summary-card">
        <div class="value">${fmtTokens(totalTokensUsed)}</div>
        <div class="label">Total Tokens</div>
      </div>
      <div class="summary-card">
        <div class="value">${totalToolCalls}</div>
        <div class="label">Tool Calls</div>
      </div>
      <div class="summary-card">
        <div class="value">${totalMessages}</div>
        <div class="label">Messages</div>
      </div>
      <div class="summary-card">
        <div class="value">${totalFilesChanged}</div>
        <div class="label">Git Files Changed</div>
      </div>
      <div class="summary-card">
        <div class="value">${fmtDuration(totalDuration)}</div>
        <div class="label">Total Duration</div>
      </div>
    </div>

    <!-- Token breakdown row -->
    <div style="margin-top:16px;display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px">
      <div style="background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:12px 16px">
        <div style="font-size:20px;font-weight:700;color:#60a5fa;font-variant-numeric:tabular-nums">${fmtTokens(totalInputTokens)}</div>
        <div style="font-size:10px;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.05em;margin-top:2px">Input Tokens</div>
      </div>
      <div style="background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:12px 16px">
        <div style="font-size:20px;font-weight:700;color:#a78bfa;font-variant-numeric:tabular-nums">${fmtTokens(totalOutputTokens)}</div>
        <div style="font-size:10px;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.05em;margin-top:2px">Output Tokens</div>
      </div>
      <div style="background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:12px 16px">
        <div style="font-size:20px;font-weight:700;color:#4ade80;font-variant-numeric:tabular-nums">${fmtTokens(totalCacheRead)}</div>
        <div style="font-size:10px;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.05em;margin-top:2px">Cache Read</div>
      </div>
      <div style="background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:12px 16px">
        <div style="font-size:20px;font-weight:700;color:#fb923c;font-variant-numeric:tabular-nums">${fmtTokens(totalCacheCreate)}</div>
        <div style="font-size:10px;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.05em;margin-top:2px">Cache Create</div>
      </div>
      <div style="background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:12px 16px">
        <div style="font-size:20px;font-weight:700;color:var(--text);font-variant-numeric:tabular-nums">${cacheHitRate.toFixed(1)}%</div>
        <div style="font-size:10px;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.05em;margin-top:2px">Cache Hit Rate</div>
      </div>
      <div style="background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:12px 16px">
        <div style="font-size:20px;font-weight:700;color:var(--text);font-variant-numeric:tabular-nums">${avgAgentTime > 0 ? fmtDuration(avgAgentTime) : 'N/A'}</div>
        <div style="font-size:10px;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.05em;margin-top:2px">Avg Agent Time</div>
      </div>
    </div>
  </div>

  <!-- How It Works -->
  <section class="section">
    <h2>How This Test Works</h2>
    <div class="how-section">
      <div class="how-card">
        <div class="step-num">Phase 0</div>
        <h4>App Launch & Preflight</h4>
        <p>Launches Electron, waits for app shell, runs system:check IPC to verify Claude agent is installed.</p>
      </div>
      <div class="how-card">
        <div class="step-num">Phase 1</div>
        <h4>Create ${EXPECTED_PANES} Claude Panes</h4>
        <p>Creates panes via pane:create IPC with Claude + worktree enabled against the target git project root. Each pane gets its own git worktree.</p>
      </div>
      <div class="how-card">
        <div class="step-num">Phase 2</div>
        <h4>Wait for Agents</h4>
        <p>Polls pane:list for all panes until every pane reaches idle state, and records max simultaneous active panes to verify parallel execution.</p>
      </div>
      <div class="how-card">
        <div class="step-num">Phase 3</div>
        <h4>Verify Files</h4>
        <p>Checks aumx config persistence, file existence/content, and git state via git:diff IPC (isWorktree, branch, changes).</p>
      </div>
      <div class="how-card">
        <div class="step-num">Phase 4</div>
        <h4>Verify Activity &amp; Conversation</h4>
        <p>IPC: session messages, tokens, tool calls. DOM: Prompts/Tools stats, Live/Done badge. Clicks Conversation sub-tab to verify rendered messages and tool calls. Clicks Timeline sub-tab.</p>
      </div>
      <div class="how-card">
        <div class="step-num">Phase 5</div>
        <h4>Verify Tokens Tab</h4>
        <p>IPC: checks inputTokens/outputTokens &gt; 0. DOM: verifies Context Usage, Total Used, Tool Calls metric cards.</p>
      </div>
      <div class="how-card">
        <div class="step-num">Phase 6</div>
        <h4>Verify Diff Tab</h4>
        <p>Switches to fleet view. For each pane, clicks the Diff tab and verifies git diff content is rendered with the expected file visible.</p>
      </div>
      <div class="how-card">
        <div class="step-num">Phase 7</div>
        <h4>Verify Sidebar</h4>
        <p>Confirms all created panes appear in the sidebar, are idle, and validates the full-suite runtime budget.</p>
      </div>
      <div class="how-card">
        <div class="step-num">Cleanup</div>
        <h4>Teardown</h4>
        <p>Closes each pane via pane:close IPC (with action:callback fallback), then closes the Electron app.</p>
      </div>
    </div>
  </section>

  <!-- Phase Timeline -->
  <section class="section">
    <h2>Phase Timeline <span class="badge" style="background:${statusColor}20;color:${statusColor};border:1px solid ${statusColor}40">${passedPhases}/${totalPhases} passed</span></h2>
    <table class="phase-table">
      <thead><tr><th></th><th>Phase</th><th>Status</th><th>Duration</th><th>Error</th></tr></thead>
      <tbody>${phaseRows}</tbody>
    </table>
  </section>

  <!-- Token Usage Comparison -->
  <section class="section">
    <h2>Token Usage per Agent <span class="badge" style="background:rgba(167,139,250,0.15);color:#a78bfa;border:1px solid rgba(167,139,250,0.3)">${fmtTokens(totalTokensUsed)} total</span></h2>
    <div style="display:flex;flex-direction:column;gap:16px">
      ${report.panes.map((p) => {
        const s = p.session;
        if (!s) return `<div style="color:var(--text-muted);font-size:12px">${esc(p.slug)}: No session data</div>`;
        const total = s.totalTokens || 1;
        const inputPct = Math.round((s.inputTokens / total) * 100);
        const outputPct = Math.round((s.outputTokens / total) * 100);
        const cacheReadPct = Math.round((s.cacheReadTokens / total) * 100);
        const cacheCreatePct = Math.round((s.cacheCreationTokens / total) * 100);
        return `<div>
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
            <span style="font-size:13px;font-weight:600">${esc(p.slug)}</span>
            <span class="mono" style="font-size:12px;color:var(--text-muted)">${fmtTokens(s.totalTokens)} tokens &middot; ${s.messageCount} msgs &middot; ${s.toolCallCount} tools${p.agentDurationMs > 0 ? ` &middot; ${fmtDuration(p.agentDurationMs)}` : ''}</span>
          </div>
          <div style="display:flex;height:10px;border-radius:5px;overflow:hidden;background:var(--border)">
            <div style="width:${inputPct}%;background:#60a5fa" title="Input: ${fmtTokens(s.inputTokens)} (${inputPct}%)"></div>
            <div style="width:${outputPct}%;background:#a78bfa" title="Output: ${fmtTokens(s.outputTokens)} (${outputPct}%)"></div>
            <div style="width:${cacheReadPct}%;background:#4ade80" title="Cache Read: ${fmtTokens(s.cacheReadTokens)} (${cacheReadPct}%)"></div>
            <div style="width:${cacheCreatePct}%;background:#fb923c" title="Cache Create: ${fmtTokens(s.cacheCreationTokens)} (${cacheCreatePct}%)"></div>
          </div>
        </div>`;
      }).join('')}
      <div style="display:flex;gap:16px;font-size:11px;color:var(--text-muted);margin-top:4px">
        <span><span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:#60a5fa;vertical-align:middle;margin-right:4px"></span>Input</span>
        <span><span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:#a78bfa;vertical-align:middle;margin-right:4px"></span>Output</span>
        <span><span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:#4ade80;vertical-align:middle;margin-right:4px"></span>Cache Read</span>
        <span><span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:#fb923c;vertical-align:middle;margin-right:4px"></span>Cache Create</span>
      </div>
    </div>
  </section>

  <!-- Verification Matrix -->
  <section class="section">
    <h2>Verification Matrix <span class="badge" style="background:rgba(88,166,255,0.12);color:var(--accent);border:1px solid rgba(88,166,255,0.25)">${totalChecksPerPane * totalPanes} checks</span></h2>
    <div style="overflow-x:auto">
      <table class="phase-table" style="min-width:600px">
        <thead>
          <tr>
            <th style="min-width:140px">Check</th>
            ${report.panes.map((p) => `<th style="text-align:center">${esc(p.slug.replace(/^e2e-[^-]+-/, ''))}</th>`).join('')}
          </tr>
        </thead>
        <tbody>
          ${[
            { group: 'Agent', checks: ['Completed', 'Write Tool', 'No Errors'] },
            { group: 'Config', checks: ['Stored', 'Prompt', 'Agent', 'Pane ID', 'Worktree'] },
            { group: 'File', checks: ['Exists', 'Content Valid', 'In Diff'] },
            { group: 'Git', checks: ['Is Worktree', 'Feature Branch', 'tmux ID', 'Under .aumx'] },
            { group: 'UI', checks: ['Activity', 'Conversation', 'Tokens', 'Diff'] },
          ].map((g) => {
            return `<tr><td colspan="${totalPanes + 1}" style="font-size:10px;font-weight:700;color:var(--accent);text-transform:uppercase;letter-spacing:0.06em;padding-top:12px;border-bottom:none">${g.group}</td></tr>` +
              g.checks.map((label) => {
                const values = report.panes.map((p) => {
                  const m: Record<string, boolean> = {
                    'Completed': p.agentCompleted, 'Write Tool': p.agentUsedWriteTool, 'No Errors': p.agentToolErrors === 0,
                    'Stored': p.configHasPane, 'Prompt': p.configPromptMatch, 'Agent': p.configAgentMatch,
                    'Pane ID': p.configPaneIdMatch, 'Worktree': p.configWorktreeMatch,
                    'Exists': p.fileExists, 'Content Valid': p.fileContentValid, 'In Diff': p.expectedFileInDiff,
                    'Is Worktree': p.gitIsWorktree, 'Feature Branch': p.gitBranchIsFeature,
                    'tmux ID': p.tmuxPaneIdFormat, 'Under .aumx': p.worktreeUnderAumx,
                    'Activity': p.activityVerified, 'Conversation': p.conversationVerified,
                    'Tokens': p.tokensVerified, 'Diff': p.diffVerified,
                  };
                  return m[label] ?? false;
                });
                return `<tr><td style="font-size:12px">${label}</td>${values.map((v) => `<td style="text-align:center;font-size:14px;color:${v ? 'var(--green)' : 'var(--red)'}">${v ? '\u2713' : '\u2717'}</td>`).join('')}</tr>`;
              }).join('');
          }).join('')}
        </tbody>
      </table>
    </div>
  </section>

  <!-- Pane Details -->
  <section class="section">
    <h2>Pane Details <span class="badge" style="background:var(--accent);color:var(--bg)">${totalPanes} panes</span></h2>
    <div class="pane-cards">${paneCards}</div>
  </section>

  ${errorsSection}

  <!-- Screenshots Gallery -->
  ${
    globalScreenshots
      ? `<section class="section">
          <h2>Screenshots</h2>
          <div class="screenshots-grid">${globalScreenshots}</div>
        </section>`
      : ''
  }

  <!-- System Info -->
  <section class="section">
    <h2>System Information</h2>
    <table class="phase-table">
      <tbody>
        <tr><td>tmux</td><td>${esc(report.systemCheck?.tmux ?? 'N/A')}</td></tr>
        <tr><td>git</td><td>${esc(report.systemCheck?.git ?? 'N/A')}</td></tr>
        <tr><td>Available Agents</td><td>${esc(report.systemCheck?.agents?.join(', ') ?? 'N/A')}</td></tr>
        <tr><td>Node Environment</td><td>test</td></tr>
        <tr><td>Report Generated</td><td>${new Date().toISOString()}</td></tr>
      </tbody>
    </table>
  </section>

  <div class="report-footer">
    Generated by <strong>aumx</strong> Multi-Pane Agent E2E Test Suite
  </div>
</div>
</body>
</html>`;
}

function esc(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function writeReport(): void {
  try {
    report.endTime = Date.now();
    const html = generateReport();
    writeFileSync(REPORT_PATH, html, 'utf-8');
    console.log(`Report written to: ${REPORT_PATH}`);
  } catch (e) {
    console.error('Failed to write report:', e);
  }
}

// ---------------------------------------------------------------------------
// Test Suite
// ---------------------------------------------------------------------------

if (process.env.AUMX_E2E !== '1') {
  console.warn('Multi-Pane Agent E2E skipped — set AUMX_E2E=1 to run');
}

describe.runIf(process.env.AUMX_E2E === '1')('Multi-Pane Agent E2E', () => {
  let app: ElectronApplication;
  let page: Page;
  let projectRoot = '';
  let testSessionName = '';
  const createdPanes: CreatedPane[] = [];
  const consoleErrors: string[] = [];

  // -------------------------------------------------------------------------
  // Phase 0: App Launch & Preflight
  // -------------------------------------------------------------------------

  beforeAll(async () => {
    const phaseStart = Date.now();
    try {
      // Verify build
      expect(existsSync(MAIN_ENTRY), `Build output missing: ${MAIN_ENTRY}`).toBe(true);

      // Never create E2E worktrees inside the source repository. A temp Git
      // fixture is removed even if pane cleanup or Electron shutdown fails.
      projectRoot = realpathSync(mkdtempSync(join(tmpdir(), 'aumx-multi-pane-e2e-')));
      execFileSync('git', ['init', '--initial-branch=main'], {
        cwd: projectRoot,
        stdio: 'ignore',
      });
      execFileSync('git', ['config', 'user.email', 'e2e@aumx.local'], { cwd: projectRoot });
      execFileSync('git', ['config', 'user.name', 'Aumx E2E'], { cwd: projectRoot });
      writeFileSync(join(projectRoot, '.gitignore'), '.amux/\n.aumx/\n');
      writeFileSync(join(projectRoot, 'README.md'), '# multi-pane E2E fixture\n');
      execFileSync('git', ['add', '.gitignore', 'README.md'], { cwd: projectRoot });
      execFileSync('git', ['commit', '-m', 'initial fixture'], {
        cwd: projectRoot,
        stdio: 'ignore',
      });

      // Launch Electron
      app = await electron.launch({
        args: [MAIN_ENTRY],
        cwd: projectRoot,
        env: {
          ...process.env,
          NODE_ENV: 'test',
          AUMX_DEV: 'true',
        },
      });

      page = await getAppWindow(app);

      // Expose __aumxStores for E2E store access (e.g. navigateToFleetView).
      // Vite replaces process.env at build time, so we use window.__AUMX_E2E instead.
      await app.context().addInitScript(() => {
        (window as any).__AUMX_E2E = true;
      });
      await page.reload();
      testSessionName = (await getSessionInfo(page)).sessionName;

      // Collect console errors
      page.on('console', (msg: ConsoleMessage) => {
        if (msg.type() === 'error') consoleErrors.push(msg.text());
      });

      // Wait for app shell
      await page.waitForSelector('[data-testid="app-shell"]', { timeout: 15_000 }).catch(() => {});
      // Ensure viewport is wide enough for the FocusView split layout
      await page.setViewportSize({ width: 1280, height: 900 });
      // Wait for sidebar to render (proves React hydration is complete)
      await page.locator('aside').waitFor({ state: 'visible', timeout: 10_000 }).catch(() => {});
      await initializePaneStatusTracker(page);

      await showOverlay(page, 0, 'Launching App', 'Verifying build, system check, agent availability');
      await screenshotStep(page, '00-app-ready');

      // Preflight: verify Claude agent is available
      const systemCheck = await getSystemCheck(page);
      report.systemCheck = {
        tmux: systemCheck?.tmux?.version ?? (systemCheck?.tmux?.available ? 'available' : 'unavailable'),
        git: systemCheck?.git?.version ?? (systemCheck?.git?.available ? 'available' : 'unavailable'),
        agents: systemCheck?.agents ?? [],
      };
      if (!systemCheck?.agents?.includes('claude')) {
        console.warn('Claude agent not available — skipping multi-pane tests');
        throw new Error(
          `SKIP: Claude agent not found. Available agents: ${JSON.stringify(systemCheck?.agents ?? [])}`,
        );
      }

      // Verify the target project used by this test is a git repository
      const rootDiff = await getGitDiff(page, projectRoot);
      expect(rootDiff.repo?.isGitRepo).toBe(true);

      await showOverlay(page, 0, 'Preflight Passed', `Agents: ${systemCheck.agents.join(', ')}`);

      // Cleanup leftovers from interrupted prior runs for deterministic test state
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

      console.log('Preflight passed. Available agents:', systemCheck.agents);
      report.phases.push({ name: 'App Launch & Preflight', status: 'passed', durationMs: Date.now() - phaseStart });
    } catch (e) {
      report.phases.push({
        name: 'App Launch & Preflight',
        status: 'failed',
        durationMs: Date.now() - phaseStart,
        error: e instanceof Error ? e.message : String(e),
      });
      throw e;
    }
  }, 60_000);

  // -------------------------------------------------------------------------
  // Cleanup
  // -------------------------------------------------------------------------

  afterAll(async () => {
    // Write report before cleanup (captures final state)
    report.consoleErrors = consoleErrors.filter(
      (e) => !e.includes('Autofill.enable') && !e.includes('Autofill.setAddresses') && !e.includes('favicon.ico'),
    );
    writeReport();

    try {
      if (page) {
        await hideOverlay(page).catch(() => {});
        await screenshotStep(page, '99-before-close').catch(() => {});

        // Best-effort cleanup of created panes
        for (const pane of createdPanes) {
          await closePaneBestEffort(page, pane);
        }
        // Wait for created panes to disappear from pane:list
        await pollUntil(
          async () => {
            const remaining = await getPanes(page);
            return remaining.every((p) => !createdPanes.some((c) => c.id === p.id));
          },
          { timeout: 5_000, interval: 1_000, label: 'cleanup-settle' },
        ).catch(() => {});
      }
    } finally {
      if (app) await app.close().catch(() => {});
      if (testSessionName) killMultiPaneTestSessionBestEffort(testSessionName);
      if (projectRoot) rmSync(projectRoot, { force: true, recursive: true });
    }
  }, 60_000);

  // -------------------------------------------------------------------------
  // Phase 1: Create Claude Panes with Worktrees
  // -------------------------------------------------------------------------

  it(`creates ${EXPECTED_PANES} Claude panes with worktrees`, async () => {
    const phaseStart = Date.now();
    try {
      for (let i = 0; i < PANE_PROMPTS.length; i++) {
        const { prompt, expectedFile } = PANE_PROMPTS[i];

        await showOverlay(page, 1, `Creating Pane ${i + 1}/${PANE_PROMPTS.length}`, `Agent: Claude Code &middot; File: ${expectedFile}`);
        const createdPane = await createPaneViaIPC(page, prompt, projectRoot);

        const newPane = await pollUntil(
          async () => {
            const panes = await getPanes(page);
            return panes.find((p) => p.id === createdPane.id) ?? null;
          },
          { timeout: PANE_CREATION_TIMEOUT, interval: 500, label: `waitForPane(${i})` },
        );

        // Deep pane config assertions
        expect(newPane).toBeTruthy();
        expect(newPane.id).toBeTruthy();
        expect(newPane.slug).toBeTruthy();
        expect(newPane.agent).toBe('claude');
        expect(newPane.paneId).toBeTruthy();

        // tmux pane ID format: %<number>
        expect(newPane.paneId).toMatch(/^%\d+$/);

        // Worktree path must be absolute and exist
        expect(newPane.worktreePath).toBeTruthy();
        expect(newPane.worktreePath).toMatch(/^\//);
        await pollUntil(
          async () => existsSync(newPane.worktreePath!) || null,
          { timeout: 5_000, interval: 250, label: `waitForWorktree(${newPane.slug})` },
        );
        // New projects keep worktrees under .amux/worktrees/.
        expect(newPane.worktreePath).toContain('.amux/worktrees/');

        // Pane type should be worktree (default)
        if (newPane.type) {
          expect(newPane.type).toBe('worktree');
        }

        // Prompt must be stored exactly as submitted
        expect(newPane.prompt).toBe(prompt);

        // Branch name should be set
        const branchName = newPane.branchName ?? newPane.slug;
        expect(branchName).toBeTruthy();
        // Slug should be kebab-case (lowercase, hyphens, no spaces)
        expect(newPane.slug).toMatch(/^[a-z0-9][a-z0-9-]*$/);

        createdPanes.push({
          id: newPane.id,
          slug: newPane.slug,
          agent: newPane.agent,
          worktreePath: newPane.worktreePath,
          paneId: newPane.paneId,
          expectedFile,
          createdAtMs: Date.now(),
          completedAtMs: 0,
          succeeded: false,
        });

        report.panes.push({
          index: i,
          id: newPane.id,
          slug: newPane.slug,
          agent: newPane.agent ?? 'claude',
          paneId: newPane.paneId,
          worktreePath: newPane.worktreePath ?? '',
          expectedFile,
          prompt,
          branchName,
          type: newPane.type ?? 'worktree',
          promptStored: newPane.prompt === prompt,
          worktreePathValid: newPane.worktreePath ? existsSync(newPane.worktreePath) : false,
          worktreeUnderAumx: newPane.worktreePath?.includes('.amux/worktrees/') ?? false,
          tmuxPaneIdFormat: /^%\d+$/.test(newPane.paneId ?? ''),
          configHasPane: false,
          configPromptMatch: false,
          configAgentMatch: false,
          configPaneIdMatch: false,
          configWorktreeMatch: false,
          agentCompleted: false,
          agentStatus: newPane.agentStatus ?? 'unknown',
          agentDurationMs: 0,
          fileExists: false,
          fileContentValid: false,
          fileContentSnippet: '',
          fileSizeBytes: 0,
          gitChanges: false,
          gitBranch: '',
          gitBranchIsFeature: false,
          gitRepoRoot: '',
          gitIsWorktree: false,
          gitIsGitRepo: false,
          filesChanged: 0,
          untrackedFiles: 0,
          changedFilesList: [],
          untrackedFilesList: [],
          expectedFileInDiff: false,
          fileVerified: false,
          agentUsedWriteTool: false,
          agentToolErrors: 0,
          toolCallNames: [],
          session: null,
          activityVerified: false,
          conversationVerified: false,
          tokensVerified: false,
          diffVerified: false,
        });

        await screenshotStep(page, `01-pane-${i}-created`);
        console.log(
          `Pane ${i} created: id=${newPane.id} slug=${newPane.slug} ` +
            `paneId=${newPane.paneId} worktree=${newPane.worktreePath ?? 'N/A'}`,
        );

      }

      await showOverlay(page, 1, 'Verifying Pane Identity', 'Checking unique slugs, worktrees, cross-pane isolation');

      // Cross-pane identity must be unique (separate slugs/worktrees per pane)
      const uniqueSlugs = new Set(createdPanes.map((p) => p.slug));
      const uniqueWorktrees = new Set(createdPanes.map((p) => p.worktreePath).filter(Boolean));
      expect(uniqueSlugs.size).toBe(EXPECTED_PANES);
      expect(uniqueWorktrees.size).toBe(EXPECTED_PANES);

      expect(createdPanes).toHaveLength(EXPECTED_PANES);
      report.phases.push({ name: `Create ${EXPECTED_PANES} Panes`, status: 'passed', durationMs: Date.now() - phaseStart });
    } catch (e) {
      report.phases.push({
        name: `Create ${EXPECTED_PANES} Panes`,
        status: 'failed',
        durationMs: Date.now() - phaseStart,
        error: e instanceof Error ? e.message : String(e),
      });
      throw e;
    }
  }, 120_000);

  // -------------------------------------------------------------------------
  // Phase 2: Wait for All Agents to Complete
  // -------------------------------------------------------------------------

  it(`waits for all ${EXPECTED_PANES} agents to finish and confirms parallel activity`, async () => {
    if (createdPanes.length !== EXPECTED_PANES) {
      report.phases.push({ name: 'Wait for Agents', status: 'skipped', durationMs: 0 });
      return;
    }
    const phaseStart = Date.now();
    try {
      await showOverlay(page, 2, 'Waiting for Agents', `${EXPECTED_PANES} Claude agents writing files&hellip;`);
      const waitResult = await waitForAllPanesIdle(
        page,
        createdPanes.map((p) => ({ id: p.id, createdAtMs: p.createdAtMs })),
        AGENT_WORK_TIMEOUT,
      );
      const requiredParallelism = Math.min(EXPECTED_PANES, 2);
      const statusParallelObserved =
        waitResult.maxConcurrentActive >= requiredParallelism || waitResult.overlapConfirmed;
      const fileCompletionByPaneId = new Map<string, number>();

      // Ground truth: verify expected files actually exist in worktrees
      // If status detection passed but files are missing, the agent didn't finish
      for (let i = 0; i < createdPanes.length; i++) {
        const pane = createdPanes[i];
        let completionMs = Date.now();
        if (pane.worktreePath) {
          const filePath = resolve(pane.worktreePath, pane.expectedFile);
          if (!existsSync(filePath)) {
            await pollUntil(
              async () => existsSync(filePath) || null,
              { timeout: 60_000, interval: 3_000, label: `waitForFile(${pane.expectedFile})` },
            );
          }
          const fileStat = statSync(filePath);
          completionMs = Number.isFinite(fileStat.mtimeMs) ? fileStat.mtimeMs : Date.now();
          fileCompletionByPaneId.set(pane.id, completionMs);
        }
        createdPanes[i].completedAtMs = completionMs;
        createdPanes[i].succeeded = true;
        const durationMs = completionMs - createdPanes[i].createdAtMs;
        if (report.panes[i]) {
          report.panes[i].agentCompleted = true;
          report.panes[i].agentStatus = 'idle';
          report.panes[i].agentDurationMs = durationMs > 0 ? durationMs : 0;
        }
      }

      const paneIds = createdPanes.map((p) => p.id);
      const sessionOverlap = await pollUntil(
        async () => {
          const windows = await getSessionWindows(page, paneIds);
          const allWindowsReady = windows.every(
            (w) => Number.isFinite(w.startMs) && Number.isFinite(w.endMs),
          );
          if (!allWindowsReady) return null;
          return { windows, ...computeSessionOverlap(windows) };
        },
        { timeout: 20_000, interval: 1_000, label: 'waitForSessionWindows' },
      ).catch(async () => {
        const windows = await getSessionWindows(page, paneIds);
        return { windows, ...computeSessionOverlap(windows) };
      });
      // Deterministic overlap proof: a later pane was launched before an earlier
      // pane's expected output file was finished.
      const launchOverlapObserved = createdPanes.some((earlier) => {
        const earlierCompletionMs = fileCompletionByPaneId.get(earlier.id);
        if (!Number.isFinite(earlierCompletionMs)) return false;
        return createdPanes.some(
          (later) =>
            later.id !== earlier.id
            && later.createdAtMs > earlier.createdAtMs
            && (earlierCompletionMs as number) >= later.createdAtMs,
        );
      });

      const parallelObserved =
        statusParallelObserved || sessionOverlap.observed || launchOverlapObserved;
      expect(
        parallelObserved,
        `Expected at least ${requiredParallelism} panes active concurrently ` +
          `(status: maxConcurrentActive=${waitResult.maxConcurrentActive}, overlapConfirmed=${waitResult.overlapConfirmed}; ` +
          `session: observed=${sessionOverlap.observed}, overlapMs=${sessionOverlap.overlapMs}; ` +
          `launchOverlap=${launchOverlapObserved})`,
      ).toBe(true);

      console.log(
        `Agent completion: ${createdPanes.length}/${createdPanes.length} succeeded, ` +
          `maxConcurrentActive=${waitResult.maxConcurrentActive}, overlapConfirmed=${waitResult.overlapConfirmed}, ` +
          `sessionOverlap=${sessionOverlap.observed} (${sessionOverlap.overlapMs}ms), ` +
          `launchOverlap=${launchOverlapObserved}`,
      );

      await showOverlay(page, 2, 'Agents Complete', `${createdPanes.filter((p) => p.succeeded).length}/${createdPanes.length} succeeded`);
      await screenshotStep(page, '02-agents-done');
      report.phases.push({ name: 'Wait for Agents', status: 'passed', durationMs: Date.now() - phaseStart });
    } catch (e) {
      report.phases.push({
        name: 'Wait for Agents',
        status: 'failed',
        durationMs: Date.now() - phaseStart,
        error: e instanceof Error ? e.message : String(e),
      });
      throw e;
    }
  }, 300_000);

  // -------------------------------------------------------------------------
  // Phase 3: Verify Files in Git Worktrees
  // -------------------------------------------------------------------------

  it('verifies agent-created files, git worktree isolation, and agent tool usage', async () => {
    if (createdPanes.length !== EXPECTED_PANES) {
      report.phases.push({ name: 'Verify Files & Worktrees', status: 'skipped', durationMs: 0 });
      return;
    }
    const phaseStart = Date.now();
    try {
      await showOverlay(page, 3, 'Verifying Files &amp; Git', 'Checking config, files, content, worktree isolation, tool usage');

      // Guard: all expected filenames must be unique for cross-pane isolation checks to work
      const uniqueExpectedFiles = new Set(PANE_PROMPTS.map((p) => p.expectedFile));
      expect(uniqueExpectedFiles.size).toBe(PANE_PROMPTS.length);

      // Verify pane persistence in the active project metadata config.
      const sessionInfo = await getSessionInfo(page);
      const configPath = getProjectConfigPath(sessionInfo.projectRoot);
      expect(existsSync(configPath), `Missing aumx config file: ${configPath}`).toBe(true);
      const configRaw = readFileSync(configPath, 'utf-8');
      const config = JSON.parse(configRaw) as { panes?: AumxPane[] };
      const configPanes = config.panes ?? [];

      const latestPanes = await getPanes(page);
      const latestMap = new Map(latestPanes.map((p) => [p.id, p]));

      let verifiedCount = 0;

      for (let i = 0; i < createdPanes.length; i++) {
        const pane = createdPanes[i];
        const rp = report.panes[i];
        const promptDef = PANE_PROMPTS[i];

        if (!pane.succeeded) {
          console.warn(`Skipping verification for failed pane: ${pane.slug}`);
          continue;
        }

        await showOverlay(page, 3, `Verifying Pane ${i + 1}/${createdPanes.length}`, `${pane.slug} &middot; ${pane.expectedFile}`);

        // Refresh worktreePath from latest IPC data
        const latest = latestMap.get(pane.id);
        if (latest?.worktreePath) {
          pane.worktreePath = latest.worktreePath;
          if (rp) rp.worktreePath = latest.worktreePath;
        }

        if (!pane.worktreePath) {
          console.warn(`No worktreePath for pane: ${pane.slug}`);
          continue;
        }

        // === Config persistence verification ===
        const configPane = configPanes.find((p) => p.id === pane.id);
        const configHasPane = !!configPane;
        const configPromptMatch = configPane?.prompt === promptDef.prompt;
        const configAgentMatch = configPane?.agent === 'claude';
        const configPaneIdMatch = configPane?.paneId === pane.paneId;
        const configWorktreeMatch = configPane?.worktreePath === pane.worktreePath;

        expect(configHasPane).toBe(true);
        expect(configPromptMatch).toBe(true);
        expect(configAgentMatch).toBe(true);
        expect(configPaneIdMatch).toBe(true);
        expect(configWorktreeMatch).toBe(true);

        // === File existence ===
        const filePath = resolve(pane.worktreePath, pane.expectedFile);
        const fileExists = existsSync(filePath);
        expect(fileExists).toBe(true);

        // === File content validation ===
        let fileContent = '';
        let fileSizeBytes = 0;
        let contentValid = false;
        if (fileExists) {
          fileContent = readFileSync(filePath, 'utf-8');
          fileSizeBytes = Buffer.byteLength(fileContent, 'utf-8');

          // File must not be empty
          expect(fileContent.trim().length).toBeGreaterThan(0);

          // File must match all content patterns for this prompt
          for (const pattern of promptDef.contentPatterns) {
            expect(fileContent).toMatch(pattern);
          }
          contentValid = promptDef.contentPatterns.every((p) => p.test(fileContent));
        }

        // === Git worktree deep verification ===
        const diffResult = await getGitDiff(page, pane.worktreePath);
        expect(diffResult?.error).toBeFalsy();

        // Repo state
        expect(diffResult.repo?.isGitRepo).toBe(true);
        expect(diffResult.repo?.isWorktree).toBe(true);
        expect(diffResult.repo?.branch).toBeTruthy();

        // Branch must NOT be main/master — it's a feature branch
        const branch = diffResult.repo?.branch ?? '';
        expect(branch).not.toMatch(/^(main|master)$/);

        // In a worktree, --show-toplevel returns the worktree root (== worktreePath).
        // Isolation is already proven by isWorktree === true above.
        if (diffResult.repo?.repoRoot) {
          expect(resolve(diffResult.repo.repoRoot)).toBe(resolve(pane.worktreePath));
        }

        // Git must show changes — the expected file should appear in changed or untracked lists
        const changedFiles: string[] = diffResult.changedFiles ?? [];
        const untrackedFilesList: string[] = diffResult.untrackedFiles ?? [];
        const allGitFiles = [...changedFiles, ...untrackedFilesList];
        const expectedFileInDiff = allGitFiles.some(
          (f) => f === pane.expectedFile || f.endsWith(`/${pane.expectedFile}`),
        );

        // The expected file must appear in git's file tracking
        expect(expectedFileInDiff).toBe(true);

        const hasGitChanges = (diffResult.filesChanged ?? 0) > 0 || untrackedFilesList.length > 0;
        expect(hasGitChanges).toBe(true);

        // === Session tool verification ===
        let agentUsedWriteTool = false;
        let agentToolErrors = 0;
        const toolCallNames: string[] = [];

        const session = await waitForSessionToolUsage(page, pane.id, 45_000);
        if (session) {
          for (const msg of session.messages ?? []) {
            for (const tc of msg.toolCalls ?? []) {
              toolCallNames.push(tc.name);
              // Agents use Write/file_write/create_file/bash to create files
              if (/write|create|bash/i.test(tc.name)) {
                agentUsedWriteTool = true;
              }
            }
            for (const tr of msg.toolResults ?? []) {
              if (tr.isError) agentToolErrors++;
            }
          }
        }
        // Agent must have used at least one file-creation tool
        expect(agentUsedWriteTool).toBe(true);

        // === Collect all data into report ===
        if (rp) {
          rp.fileExists = fileExists;
          rp.fileContentValid = contentValid;
          rp.fileContentSnippet = fileContent.slice(0, 200);
          rp.fileSizeBytes = fileSizeBytes;
          rp.configHasPane = configHasPane;
          rp.configPromptMatch = configPromptMatch;
          rp.configAgentMatch = configAgentMatch;
          rp.configPaneIdMatch = configPaneIdMatch;
          rp.configWorktreeMatch = configWorktreeMatch;
          rp.gitChanges = hasGitChanges;
          rp.gitBranch = branch;
          rp.gitBranchIsFeature = !/^(main|master)$/.test(branch);
          rp.gitRepoRoot = diffResult.repo?.repoRoot ?? '';
          rp.gitIsWorktree = diffResult.repo?.isWorktree ?? false;
          rp.gitIsGitRepo = diffResult.repo?.isGitRepo ?? false;
          rp.filesChanged = diffResult.filesChanged ?? 0;
          rp.untrackedFiles = untrackedFilesList.length;
          rp.changedFilesList = changedFiles;
          rp.untrackedFilesList = untrackedFilesList;
          rp.expectedFileInDiff = expectedFileInDiff;
          rp.fileVerified = true;
          rp.agentUsedWriteTool = agentUsedWriteTool;
          rp.agentToolErrors = agentToolErrors;
          rp.toolCallNames = toolCallNames;
        }

        console.log(
          `Pane ${pane.slug}: file=${fileExists} content=${contentValid} size=${fileSizeBytes}B ` +
            `branch=${branch} isWorktree=${diffResult.repo?.isWorktree} ` +
            `expectedInDiff=${expectedFileInDiff} writeTool=${agentUsedWriteTool} ` +
            `toolErrors=${agentToolErrors} tools=[${toolCallNames.join(',')}]`,
        );

        verifiedCount++;
      }

      await showOverlay(page, 3, 'Cross-Pane Isolation', 'Verifying worktree files are not shared across panes');

      // Cross-pane worktree isolation: pane A's expected file must NOT exist in pane B's worktree
      const succeededWithWorktrees = createdPanes.filter((p) => p.succeeded && p.worktreePath);
      for (let a = 0; a < succeededWithWorktrees.length; a++) {
        for (let b = 0; b < succeededWithWorktrees.length; b++) {
          if (a === b) continue;
          const paneA = succeededWithWorktrees[a];
          const paneB = succeededWithWorktrees[b];
          if (paneA.expectedFile !== paneB.expectedFile) {
            const crossPath = resolve(paneB.worktreePath!, paneA.expectedFile);
            expect(
              existsSync(crossPath),
              `Isolation violation: ${paneA.expectedFile} from pane "${paneA.slug}" found in pane "${paneB.slug}" worktree`,
            ).toBe(false);
          }
        }
      }

      await screenshotStep(page, '03-files-verified');
      const succeededCount = createdPanes.filter((p) => p.succeeded).length;
      expect(verifiedCount).toBe(succeededCount);
      report.phases.push({
        name: 'Verify Files & Worktrees',
        status: 'passed',
        durationMs: Date.now() - phaseStart,
      });
    } catch (e) {
      report.phases.push({
        name: 'Verify Files & Worktrees',
        status: 'failed',
        durationMs: Date.now() - phaseStart,
        error: e instanceof Error ? e.message : String(e),
      });
      throw e;
    }
  }, 60_000);

  // -------------------------------------------------------------------------
  // Phase 4: Verify Activity Tab for Each Pane
  // -------------------------------------------------------------------------

  it('shows real conversation data in the Activity tab', async () => {
    if (createdPanes.length !== EXPECTED_PANES) {
      report.phases.push({ name: 'Verify Activity Tab', status: 'skipped', durationMs: 0 });
      return;
    }
    const phaseStart = Date.now();
    try {
      let verifiedCount = 0;

      for (let i = 0; i < createdPanes.length; i++) {
        const pane = createdPanes[i];
        const rp = report.panes[i];

        if (!pane.succeeded) {
          console.warn(`Skipping Activity check for failed pane: ${pane.slug}`);
          continue;
        }

        await showOverlay(page, 4, `Activity &mdash; Pane ${i + 1}`, `IPC: checking session data for ${pane.slug}`);

        // IPC verification — data layer
        let session: NormalizedSession;
        try {
          session = await waitForSessionData(page, pane.id, 45_000);
        } catch (e) {
          console.error(`Session data timeout for pane ${pane.slug}: ${e}`);
          continue;
        }

        expect(session.messages.length).toBeGreaterThan(0);
        expect(session.metrics.totalTokens).toBeGreaterThan(0);
        expect(session.metrics.toolCallCount).toBeGreaterThan(0);
        expect(session.agent).toBe('claude');

        // Collect session data for report
        if (rp) {
          rp.session = {
            messageCount: session.messages?.length ?? 0,
            totalTokens: session.metrics?.totalTokens ?? 0,
            inputTokens: session.metrics?.inputTokens ?? 0,
            outputTokens: session.metrics?.outputTokens ?? 0,
            cacheReadTokens: session.metrics?.cacheReadTokens ?? 0,
            cacheCreationTokens: session.metrics?.cacheCreationTokens ?? 0,
            toolCallCount: session.metrics?.toolCallCount ?? 0,
            isOngoing: session.isOngoing ?? false,
          };
        }

        await showOverlay(page, 4, `Activity &mdash; Pane ${i + 1}`, 'DOM: navigating to Activity tab, checking stats');

        // DOM verification — visual layer
        await navigateToFocusView(page, pane.id);
        await switchTab(page, 'Activity', 'Prompts');

        const isEmpty = await page.locator('text="No Activity Yet"').isVisible({ timeout: 1_000 }).catch(() => false);
        expect(isEmpty).toBe(false);

        // Verify Activity panel renders session stats (use :has-text for substring match)
        const hasPrompts = await page.locator(':has-text("Prompts")').first().isVisible({ timeout: 3_000 }).catch(() => false);
        const hasTools = await page.locator(':has-text("Tools")').first().isVisible({ timeout: 2_000 }).catch(() => false);
        expect(hasPrompts).toBe(true);
        expect(hasTools).toBe(true);

        // Live/Done badge
        const liveOrDone = await page.locator(':has-text("Live"), :has-text("Done")').first().isVisible({ timeout: 2_000 }).catch(() => false);
        expect(liveOrDone).toBe(true);

        // Sub-tabs must exist
        const hasConversation = await page
          .locator('button:has-text("Conversation")')
          .isVisible({ timeout: 2_000 })
          .catch(() => false);
        const hasTimeline = await page
          .locator('button:has-text("Timeline")')
          .isVisible({ timeout: 2_000 })
          .catch(() => false);
        expect(hasConversation).toBe(true);
        expect(hasTimeline).toBe(true);

        // Click into Conversation sub-tab and verify real messages rendered
        await showOverlay(page, 4, `Conversation &mdash; Pane ${i + 1}`, 'Checking rendered messages and tool calls');
        await page.locator('button:has-text("Conversation")').click();
        await new Promise((r) => setTimeout(r, 800));

        // Conversation view should have rendered message content (not empty)
        const noActivityVisible = await page.locator('text="No Activity Yet"').isVisible({ timeout: 1_000 }).catch(() => false);
        expect(noActivityVisible).toBe(false);

        // Verify at least one tool call is rendered in the conversation (agents always use Write)
        const hasRenderedTools = await page
          .locator(':has-text("Write"), :has-text("Read"), :has-text("Bash"), :has-text("Edit")')
          .first()
          .isVisible({ timeout: 3_000 })
          .catch(() => false);
        expect(hasRenderedTools).toBe(true);

        // Click into Timeline sub-tab to verify it renders
        await showOverlay(page, 4, `Timeline &mdash; Pane ${i + 1}`, 'Checking timeline visualization');
        await page.locator('button:has-text("Timeline")').click();
        await new Promise((r) => setTimeout(r, 800));
        await screenshotStep(page, `04-timeline-pane-${i}`);

        if (rp) {
          rp.activityVerified = true;
          rp.conversationVerified = true;
        }
        await screenshotStep(page, `04-activity-pane-${i}`);
        verifiedCount++;
      }

      const succeededCount = createdPanes.filter((p) => p.succeeded).length;
      expect(verifiedCount).toBe(succeededCount);
      report.phases.push({ name: 'Verify Activity Tab', status: 'passed', durationMs: Date.now() - phaseStart });
    } catch (e) {
      report.phases.push({
        name: 'Verify Activity Tab',
        status: 'failed',
        durationMs: Date.now() - phaseStart,
        error: e instanceof Error ? e.message : String(e),
      });
      throw e;
    }
  }, 60_000);

  // -------------------------------------------------------------------------
  // Phase 5: Verify Tokens Tab for Each Pane
  // -------------------------------------------------------------------------

  it('shows real token usage data in the Tokens tab', async () => {
    if (createdPanes.length !== EXPECTED_PANES) {
      report.phases.push({ name: 'Verify Tokens Tab', status: 'skipped', durationMs: 0 });
      return;
    }
    const phaseStart = Date.now();
    try {
      let verifiedCount = 0;

      for (let i = 0; i < createdPanes.length; i++) {
        const pane = createdPanes[i];
        const rp = report.panes[i];

        if (!pane.succeeded) {
          console.warn(`Skipping Tokens check for failed pane: ${pane.slug}`);
          continue;
        }

        await showOverlay(page, 5, `Tokens &mdash; Pane ${i + 1}`, `IPC: checking input/output tokens for ${pane.slug}`);

        let session: NormalizedSession;
        try {
          session = await waitForSessionData(page, pane.id, 45_000);
        } catch (e) {
          console.warn(`No session for Tokens check: ${pane.slug} (${e})`);
          continue;
        }

        expect(session.metrics.inputTokens).toBeGreaterThan(0);
        expect(session.metrics.outputTokens).toBeGreaterThan(0);

        // Update session in report if not already set
        if (rp && !rp.session) {
          rp.session = {
            messageCount: session.messages?.length ?? 0,
            totalTokens: session.metrics?.totalTokens ?? 0,
            inputTokens: session.metrics?.inputTokens ?? 0,
            outputTokens: session.metrics?.outputTokens ?? 0,
            cacheReadTokens: session.metrics?.cacheReadTokens ?? 0,
            cacheCreationTokens: session.metrics?.cacheCreationTokens ?? 0,
            toolCallCount: session.metrics?.toolCallCount ?? 0,
            isOngoing: session.isOngoing ?? false,
          };
        }

        await showOverlay(page, 5, `Tokens &mdash; Pane ${i + 1}`, 'DOM: verifying Context Usage, Total Used, Tool Calls');
        await navigateToFocusView(page, pane.id);
        await switchTab(page, 'Tokens', 'Context Usage');

        const isEmpty = await page.locator('text="No Token Data"').isVisible({ timeout: 1_000 }).catch(() => false);
        expect(isEmpty).toBe(false);

        const hasContextUsage = await page
          .locator(':has-text("Context Usage")')
          .first()
          .isVisible({ timeout: 3_000 })
          .catch(() => false);
        expect(hasContextUsage).toBe(true);

        const hasTotalUsed = await page
          .locator(':has-text("Total Used")')
          .first()
          .isVisible({ timeout: 2_000 })
          .catch(() => false);
        const hasToolCalls = await page
          .locator(':has-text("Tool Calls")')
          .first()
          .isVisible({ timeout: 2_000 })
          .catch(() => false);
        expect(hasTotalUsed).toBe(true);
        expect(hasToolCalls).toBe(true);

        if (rp) rp.tokensVerified = true;
        await screenshotStep(page, `05-tokens-pane-${i}`);
        verifiedCount++;
      }

      const succeededCount = createdPanes.filter((p) => p.succeeded).length;
      expect(verifiedCount).toBe(succeededCount);
      report.phases.push({ name: 'Verify Tokens Tab', status: 'passed', durationMs: Date.now() - phaseStart });
    } catch (e) {
      report.phases.push({
        name: 'Verify Tokens Tab',
        status: 'failed',
        durationMs: Date.now() - phaseStart,
        error: e instanceof Error ? e.message : String(e),
      });
      throw e;
    }
  }, 60_000);

  // -------------------------------------------------------------------------
  // Phase 6: Verify Diff Tab in Fleet View
  // -------------------------------------------------------------------------

  it('shows git diff content for each pane in fleet view', async () => {
    if (createdPanes.length !== EXPECTED_PANES) {
      report.phases.push({ name: 'Verify Diff Tab', status: 'skipped', durationMs: 0 });
      return;
    }
    const phaseStart = Date.now();
    try {
      await showOverlay(page, 6, 'Verifying Diff Tab', 'Switching to fleet view to inspect git diffs');
      await navigateToFleetView(page);

      let verifiedCount = 0;

      for (let i = 0; i < createdPanes.length; i++) {
        const pane = createdPanes[i];
        if (!pane.succeeded) continue;

        await showOverlay(page, 6, `Git Diff &mdash; Pane ${i + 1}`, `Checking diff view for ${pane.slug}`);

        const paneCellContainer = page.locator(`[data-testid="pane-cell"][data-pane-id="${pane.id}"]`).first();
        await paneCellContainer.scrollIntoViewIfNeeded({ timeout: 5_000 }).catch(() => {});
        const cellVisible = await paneCellContainer.isVisible({ timeout: 3_000 }).catch(() => false);
        if (!cellVisible) {
          console.warn(`PaneCell not visible for slug: ${pane.slug}`);
          continue;
        }

        const diffTab = paneCellContainer.locator('button[role="tab"]:has-text("Diff")').first();
        const diffTabVisible = await diffTab.isVisible({ timeout: 2_000 }).catch(() => false);
        if (!diffTabVisible) {
          const anyDiffTab = page.locator('button[role="tab"]:has-text("Diff")').nth(i);
          if (await anyDiffTab.isVisible({ timeout: 2_000 }).catch(() => false)) {
            await anyDiffTab.click();
          }
        } else {
          await diffTab.click();
        }
        await new Promise((r) => setTimeout(r, 800));

        // Verify diff content is rendered (not the empty "No changes" state)
        // GitDiffView shows file groups like "Modified Files", "Added Files", or "Unversioned Files"
        // and status glyphs like M, A, D plus file names
        const hasNoChanges = await page
          .locator('text="No changes"')
          .isVisible({ timeout: 1_000 })
          .catch(() => false);

        const hasNoWorktree = await page
          .locator('text="No Worktree"')
          .isVisible({ timeout: 1_000 })
          .catch(() => false);

        // At least one of these should be false — the pane should have real diff content
        const hasDiffContent = !hasNoChanges && !hasNoWorktree;
        expect(hasDiffContent, `Pane ${pane.slug} should have git diff content`).toBe(true);

        // Verify the expected file appears in the diff view
        const hasExpectedFile = await paneCellContainer
          .locator(`:has-text("${pane.expectedFile}")`)
          .first()
          .isVisible({ timeout: 3_000 })
          .catch(() => false);
        expect(hasExpectedFile, `Expected ${pane.expectedFile} in diff view`).toBe(true);

        if (report.panes[i]) report.panes[i].diffVerified = true;
        await screenshotStep(page, `06-diff-pane-${i}`);
        verifiedCount++;
      }

      const succeededCount = createdPanes.filter((p) => p.succeeded).length;
      expect(verifiedCount).toBe(succeededCount);
      report.phases.push({ name: 'Verify Diff Tab', status: 'passed', durationMs: Date.now() - phaseStart });
    } catch (e) {
      report.phases.push({
        name: 'Verify Diff Tab',
        status: 'failed',
        durationMs: Date.now() - phaseStart,
        error: e instanceof Error ? e.message : String(e),
      });
      throw e;
    }
  }, 60_000);

  // -------------------------------------------------------------------------
  // Phase 7: Verify Sidebar State
  // -------------------------------------------------------------------------

  it(`sidebar shows all ${EXPECTED_PANES} panes with correct status and runtime budget`, async () => {
    if (createdPanes.length !== EXPECTED_PANES) {
      report.phases.push({ name: 'Verify Sidebar', status: 'skipped', durationMs: 0 });
      return;
    }
    const phaseStart = Date.now();
    try {
      await showOverlay(page, 7, 'Verifying Sidebar', 'Checking pane status, sidebar items, runtime budget');

      const panes = await getPanes(page);
      const statusSnapshot = await getPaneStatusSnapshot(page);
      for (const created of createdPanes) {
        if (!created.succeeded) continue;
        const found = panes.find((p) => p.id === created.id);
        expect(found).toBeTruthy();
        const status = statusSnapshot.statusByPaneId[created.id] ?? found?.agentStatus;
        expect(['idle', 'waiting']).toContain(status);
      }

      for (const created of createdPanes) {
        const expanded = page.locator(`aside li button:has-text("${created.slug}")`).first();
        const collapsed = page.locator(`aside button[title="${created.slug}"]`).first();
        const isVisible =
          (await expanded.isVisible({ timeout: 1_000 }).catch(() => false))
          || (await collapsed.isVisible({ timeout: 1_000 }).catch(() => false));
        expect(isVisible).toBe(true);
      }

      const elapsedMs = Date.now() - report.startTime;
      expect(elapsedMs).toBeLessThanOrEqual(TOTAL_RUNTIME_BUDGET_MS);

      await showOverlay(page, 7, 'All Checks Passed', `Total runtime: ${Math.round(elapsedMs / 1000)}s`);
      await screenshotStep(page, '07-sidebar-final');
      report.phases.push({ name: 'Verify Sidebar', status: 'passed', durationMs: Date.now() - phaseStart });
    } catch (e) {
      report.phases.push({
        name: 'Verify Sidebar',
        status: 'failed',
        durationMs: Date.now() - phaseStart,
        error: e instanceof Error ? e.message : String(e),
      });
      throw e;
    }
  }, 30_000);
});
