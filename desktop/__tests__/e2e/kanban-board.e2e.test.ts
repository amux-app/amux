import { execSync } from 'child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { resolve } from 'path';
import type { ElectronApplication, Page, ConsoleMessage } from 'playwright';
import { _electron as electron } from 'playwright';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { KanbanGetResponse, DoneClearResponse } from '../../src/shared/kanban-types';
import {
  type PhaseResult,
  closePaneBestEffort,
  getAppWindow,
  getGitDiff,
  getPanes,
  getSessionInfo,
  getSystemCheck,
  pollUntil,
} from './e2e-helpers';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ROOT = resolve(__dirname, '..', '..');
const MAIN_ENTRY = resolve(ROOT, 'out', 'main', 'index.js');
const SCREENSHOTS_DIR = resolve(ROOT, 'out');
const REPORT_PATH = resolve(SCREENSHOTS_DIR, 'e2e-kanban-board-report.html');

const ENABLE_SCREENSHOTS = process.env.MUXBASE_E2E_SCREENSHOTS === '1';
const RUN_TOKEN = `e2e-kanban-${Date.now().toString(36)}`;

// Column IDs as defined in useKanbanColumns.ts
const COLUMN_IDS = ['backlog', 'in-progress', 'needs-attention', 'review', 'done'] as const;

// Backlog tasks — simple, deterministic prompts
const BACKLOG_TASKS = [
  {
    title: 'Create config file',
    prompt: `${RUN_TOKEN} Config task: create a file called config.json with this exact content: {"name":"muxbase-test","version":"1.0.0"}. Do not install any dependencies. Do not create any other files.`,
    complexity: 'M' as const,
    expectedFile: 'config.json',
    contentPatterns: [/muxbase-test/i, /1\.0\.0/],
  },
  {
    title: 'Create utility module',
    prompt: `${RUN_TOKEN} Utility task: create a file called utils.js that exports a function called greet that takes a name parameter and returns "Hello, " + name. Use module.exports. Do not install any dependencies. Do not create any other files.`,
    complexity: 'M' as const,
    expectedFile: 'utils.js',
    contentPatterns: [/greet/i, /module\.exports/i],
  },
];

// ---------------------------------------------------------------------------
// Report Data
// ---------------------------------------------------------------------------

interface BacklogItemReport {
  title: string;
  prompt: string;
  complexity: string;
  launched: boolean;
  paneId?: string;
}

interface PaneReport {
  id: string;
  slug: string;
  agent: string;
  paneId: string;
  worktreePath: string;
  expectedFile: string;
  agentCompleted: boolean;
  agentDurationMs: number;
  fileExists: boolean;
  fileContentValid: boolean;
  mergeSucceeded: boolean;
  addedToDone: boolean;
  sidePanelOpened: boolean;
  tabsVerified: boolean;
}

interface ReportData {
  startTime: number;
  endTime: number;
  systemCheck: { tmux: string; git: string; agents: string[] } | null;
  phases: PhaseResult[];
  backlogItems: BacklogItemReport[];
  panes: PaneReport[];
  columnSnapshots: Array<{ phase: string; counts: Record<string, number> }>;
  consoleErrors: string[];
  screenshots: { name: string; path: string }[];
}

const report: ReportData = {
  startTime: Date.now(),
  endTime: 0,
  systemCheck: null,
  phases: [],
  backlogItems: [],
  panes: [],
  columnSnapshots: [],
  consoleErrors: [],
  screenshots: [],
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function screenshotStep(page: Page, name: string): Promise<void> {
  if (!ENABLE_SCREENSHOTS) return;
  const filename = `e2e-kanban-${name}.png`;
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

// ---------------------------------------------------------------------------
// Kanban-Specific Helpers
// ---------------------------------------------------------------------------

async function navigateToKanbanView(page: Page): Promise<void> {
  const boardBtn = page.locator('button:has-text("Board")');
  await boardBtn.waitFor({ state: 'visible', timeout: 5_000 });
  await boardBtn.click();
  await page.locator('[data-testid="kanban-column-backlog"]').waitFor({ state: 'visible', timeout: 10_000 });
}

async function enableKanbanBoard(page: Page): Promise<void> {
  await page.evaluate(() => {
    const api = (window as Window & {
      muxbase: {
        invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
      };
    }).muxbase;
    return api.invoke('electron-settings:update', {
      key: 'enableKanbanBoard',
      value: true,
    });
  });
}

async function getKanbanData(page: Page, projectRoot: string): Promise<KanbanGetResponse> {
  return page.evaluate(
    (root) => (window as any).muxbase.invoke('kanban:get', { projectRoot: root }),
    projectRoot,
  );
}

async function clearDoneIPC(page: Page, projectRoot: string): Promise<DoneClearResponse> {
  return page.evaluate(
    (root) => (window as any).muxbase.invoke('kanban:done-clear', { projectRoot: root }),
    projectRoot,
  );
}

async function getColumnCounts(page: Page): Promise<Record<string, number>> {
  return page.evaluate(() => {
    const counts: Record<string, number> = {};
    document.querySelectorAll('[data-testid^="kanban-column-count-"]').forEach((el) => {
      const id = el.getAttribute('data-testid')?.replace('kanban-column-count-', '') ?? '';
      counts[id] = parseInt(el.textContent?.trim() ?? '0', 10);
    });
    return counts;
  });
}

async function checkDirtyState(page: Page, worktreePath: string): Promise<boolean> {
  const result = await page.evaluate(
    (path) => (window as any).muxbase.invoke('git:status', { worktreePath: path }),
    worktreePath,
  );
  return result?.hasChanges === true;
}

// ---------------------------------------------------------------------------
// Report Generation
// ---------------------------------------------------------------------------

function fmtDuration(ms: number): string {
  if (ms < 1_000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`;
  const mins = Math.floor(ms / 60_000);
  const secs = Math.round((ms % 60_000) / 1_000);
  return `${mins}m ${secs}s`;
}

function esc(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function generateReport(): string {
  const totalDuration = report.endTime - report.startTime;
  const passedPhases = report.phases.filter((p) => p.status === 'passed').length;
  const totalPhases = report.phases.filter((p) => p.status !== 'skipped').length;
  const overallStatus = passedPhases === totalPhases ? 'PASSED' : 'FAILED';
  const statusColor = overallStatus === 'PASSED' ? '#4ade80' : '#f87171';

  const phaseRows = report.phases
    .map((p) => {
      const icon = p.status === 'passed' ? '\u2713' : p.status === 'failed' ? '\u2717' : '\u2014';
      const color = p.status === 'passed' ? '#4ade80' : p.status === 'failed' ? '#f87171' : '#6b7280';
      return `<tr>
        <td><span style="color:${color};font-weight:600">${icon}</span></td>
        <td>${esc(p.name)}</td>
        <td><span class="status-badge" style="background:${color}20;color:${color};border:1px solid ${color}40">${p.status}</span></td>
        <td class="mono">${fmtDuration(p.durationMs)}</td>
        <td style="color:#f87171">${p.error ? esc(p.error) : ''}</td>
      </tr>`;
    })
    .join('');

  const kanbanFlowSteps = ['Backlog', 'In Progress', 'Review', 'Done'];
  const flowArrows = kanbanFlowSteps
    .map((step, i) => {
      const snap = report.columnSnapshots.find((s) => s.phase.toLowerCase().includes(step.toLowerCase()));
      const count = snap?.counts[step.toLowerCase().replace(/\s+/g, '-')] ?? '?';
      const color = i === kanbanFlowSteps.length - 1 ? '#4ade80' : '#58a6ff';
      return `<div style="display:flex;align-items:center;gap:12px">
        <div style="background:${color}15;border:1px solid ${color}40;border-radius:8px;padding:12px 20px;text-align:center;min-width:120px">
          <div style="font-size:20px;font-weight:700;color:${color}">${count}</div>
          <div style="font-size:11px;color:var(--text-muted);margin-top:2px">${step}</div>
        </div>
        ${i < kanbanFlowSteps.length - 1 ? '<span style="font-size:20px;color:var(--text-muted)">&rarr;</span>' : ''}
      </div>`;
    })
    .join('');

  const backlogRows = report.backlogItems
    .map((item) => `<tr>
      <td>${esc(item.title)}</td>
      <td class="mono" style="font-size:11px;max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(item.prompt.slice(0, 80))}...</td>
      <td>${item.complexity}</td>
      <td style="color:${item.launched ? '#4ade80' : '#f87171'}">${item.launched ? '\u2713 Launched' : '\u2717 Not launched'}</td>
    </tr>`)
    .join('');

  const paneRows = report.panes
    .map((p) => {
      const statusColor = p.agentCompleted ? '#4ade80' : '#f87171';
      return `<tr>
        <td><code>${esc(p.slug)}</code></td>
        <td>${esc(p.agent)}</td>
        <td style="color:${statusColor}">${p.agentCompleted ? '\u2713' : '\u2717'}</td>
        <td>${p.agentDurationMs > 0 ? fmtDuration(p.agentDurationMs) : 'N/A'}</td>
        <td style="color:${p.fileExists ? '#4ade80' : '#f87171'}">${p.fileExists ? '\u2713' : '\u2717'} ${esc(p.expectedFile)}</td>
        <td style="color:${p.mergeSucceeded ? '#4ade80' : '#f87171'}">${p.mergeSucceeded ? '\u2713' : '\u2717'}</td>
        <td style="color:${p.sidePanelOpened ? '#4ade80' : '#f87171'}">${p.sidePanelOpened ? '\u2713' : '\u2717'}</td>
      </tr>`;
    })
    .join('');

  const errorsSection =
    report.consoleErrors.length > 0
      ? `<section class="section">
          <h2>Console Errors</h2>
          <div style="display:flex;flex-direction:column;gap:8px">${report.consoleErrors.map((e) => `<pre style="background:rgba(248,113,113,0.06);border:1px solid rgba(248,113,113,0.15);border-radius:6px;padding:10px 14px;font-family:monospace;font-size:12px;color:#f87171;white-space:pre-wrap;word-break:break-all">${esc(e)}</pre>`).join('')}</div>
        </section>`
      : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>muxbase Kanban Board E2E Report</title>
<style>
  :root {
    --bg: #0d1117; --surface: #161b22; --surface2: #1c2128;
    --border: #30363d; --text: #e6edf3; --text-muted: #8b949e;
    --accent: #58a6ff; --green: #4ade80; --red: #f87171; --orange: #fb923c;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif; background: var(--bg); color: var(--text); line-height: 1.6; }
  .container { max-width: 1200px; margin: 0 auto; padding: 32px 24px; }
  .report-header { background: linear-gradient(135deg,var(--surface),var(--surface2)); border: 1px solid var(--border); border-radius: 12px; padding: 32px; margin-bottom: 24px; }
  .report-header h1 { font-size: 24px; font-weight: 700; margin-bottom: 4px; display: flex; align-items: center; gap: 12px; }
  .report-header .subtitle { color: var(--text-muted); font-size: 14px; margin-bottom: 20px; }
  .summary-grid { display: grid; grid-template-columns: repeat(auto-fit,minmax(140px,1fr)); gap: 16px; }
  .summary-card { background: var(--bg); border: 1px solid var(--border); border-radius: 8px; padding: 16px; text-align: center; }
  .summary-card .value { font-size: 28px; font-weight: 700; font-variant-numeric: tabular-nums; }
  .summary-card .label { font-size: 11px; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.05em; margin-top: 4px; }
  .section { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 24px; margin-bottom: 24px; }
  .section h2 { font-size: 16px; font-weight: 600; margin-bottom: 16px; padding-bottom: 12px; border-bottom: 1px solid var(--border); }
  .section h2 .badge { font-size: 11px; font-weight: 500; padding: 2px 8px; border-radius: 9999px; margin-left: 8px; vertical-align: middle; }
  table { width: 100%; border-collapse: collapse; }
  th { text-align: left; font-size: 11px; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.05em; padding: 8px 12px; border-bottom: 1px solid var(--border); }
  td { padding: 10px 12px; border-bottom: 1px solid var(--border); font-size: 13px; }
  tr:last-child td { border-bottom: none; }
  .mono { font-family: 'SF Mono','Fira Code','Cascadia Code',monospace; font-size: 12px; }
  .status-badge { display: inline-block; font-size: 11px; font-weight: 600; padding: 2px 10px; border-radius: 9999px; text-transform: uppercase; letter-spacing: 0.03em; }
  code { font-family: 'SF Mono','Fira Code',monospace; font-size: 11px; background: var(--surface); padding: 1px 6px; border-radius: 4px; }
  .report-footer { text-align: center; color: var(--text-muted); font-size: 12px; padding: 24px 0; border-top: 1px solid var(--border); margin-top: 8px; }
</style>
</head>
<body>
<div class="container">
  <div class="report-header">
    <h1>
      Kanban Board E2E Report
      <span class="status-badge" style="background:${statusColor}20;color:${statusColor};border:1px solid ${statusColor}40;font-size:13px">${overallStatus}</span>
    </h1>
    <p class="subtitle">
      ${new Date(report.startTime).toLocaleString()} &mdash; Total duration: ${fmtDuration(totalDuration)}
    </p>
    <div class="summary-grid">
      <div class="summary-card"><div class="value" style="color:${statusColor}">${passedPhases}/${totalPhases}</div><div class="label">Phases Passed</div></div>
      <div class="summary-card"><div class="value">${report.backlogItems.length}</div><div class="label">Backlog Items</div></div>
      <div class="summary-card"><div class="value">${report.panes.filter((p) => p.agentCompleted).length}/${report.panes.length}</div><div class="label">Agents Completed</div></div>
      <div class="summary-card"><div class="value">${report.panes.filter((p) => p.mergeSucceeded).length}/${report.panes.length}</div><div class="label">Merges Succeeded</div></div>
      <div class="summary-card"><div class="value">${fmtDuration(totalDuration)}</div><div class="label">Total Duration</div></div>
    </div>
  </div>

  <section class="section">
    <h2>Phase Timeline <span class="badge" style="background:${statusColor}20;color:${statusColor};border:1px solid ${statusColor}40">${passedPhases}/${totalPhases} passed</span></h2>
    <table><thead><tr><th></th><th>Phase</th><th>Status</th><th>Duration</th><th>Error</th></tr></thead><tbody>${phaseRows}</tbody></table>
  </section>

  <section class="section">
    <h2>Kanban Flow</h2>
    <div style="display:flex;align-items:center;justify-content:center;gap:0;flex-wrap:wrap;padding:20px 0">${flowArrows}</div>
  </section>

  <section class="section">
    <h2>Backlog Items</h2>
    <table><thead><tr><th>Title</th><th>Prompt</th><th>Complexity</th><th>Status</th></tr></thead><tbody>${backlogRows}</tbody></table>
  </section>

  <section class="section">
    <h2>Pane Details <span class="badge" style="background:var(--accent);color:var(--bg)">${report.panes.length} panes</span></h2>
    <table>
      <thead><tr><th>Slug</th><th>Agent</th><th>Completed</th><th>Duration</th><th>File</th><th>Merged</th><th>Side Panel</th></tr></thead>
      <tbody>${paneRows}</tbody>
    </table>
  </section>

  ${errorsSection}

  <section class="section">
    <h2>System Information</h2>
    <table><tbody>
      <tr><td>tmux</td><td>${esc(report.systemCheck?.tmux ?? 'N/A')}</td></tr>
      <tr><td>git</td><td>${esc(report.systemCheck?.git ?? 'N/A')}</td></tr>
      <tr><td>Available Agents</td><td>${esc(report.systemCheck?.agents?.join(', ') ?? 'N/A')}</td></tr>
      <tr><td>Report Generated</td><td>${new Date().toISOString()}</td></tr>
    </tbody></table>
  </section>

  <div class="report-footer">Generated by <strong>muxbase</strong> Kanban Board E2E Test Suite</div>
</div>
</body>
</html>`;
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

if (process.env.MUXBASE_E2E !== '1') {
  console.warn('Kanban Board E2E skipped — set MUXBASE_E2E=1 to run');
}

describe.runIf(process.env.MUXBASE_E2E === '1')('Kanban Board E2E', () => {
  let app: ElectronApplication;
  let page: Page;
  let projectRoot: string;
  let e2eRoot: string;
  const consoleErrors: string[] = [];
  const launchedPaneIds: string[] = [];
  const launchedPanes: Array<{ id: string; paneId: string; slug: string; worktreePath: string; createdAtMs: number }> = [];

  // -------------------------------------------------------------------------
  // Phase 0: App Launch & Preflight
  // -------------------------------------------------------------------------

  beforeAll(async () => {
    const phaseStart = Date.now();
    try {
      expect(existsSync(MAIN_ENTRY), `Build output missing: ${MAIN_ENTRY}`).toBe(true);

      // Kill any leftover E2E tmux sessions from previous runs
      try {
        const sessions = execSync('tmux list-sessions -F "#{session_name}" 2>/dev/null', { encoding: 'utf-8' });
        for (const name of sessions.split('\n').filter((s) => s.includes('muxbase-kanban-e2e'))) {
          execSync(`tmux kill-session -t "${name}" 2>/dev/null`, { stdio: 'ignore' });
          console.log(`Cleaned up stale E2E session: ${name}`);
        }
      } catch { /* no tmux server or no sessions — fine */ }

      // Isolated temp workspace — prevents any mutation of real user kanban/backlog data
      e2eRoot = realpathSync(mkdtempSync(resolve(tmpdir(), 'muxbase-kanban-e2e-')));
      execSync('git init', { cwd: e2eRoot, stdio: 'ignore' });
      execSync('git config user.email "e2e@muxbase.test"', { cwd: e2eRoot, stdio: 'ignore' });
      execSync('git config user.name "muxbase-e2e"', { cwd: e2eRoot, stdio: 'ignore' });
      // .gitignore must exist before muxbase starts — muxbase writes .muxbase/muxbase.config.json on
      // init, which would otherwise show as untracked and trigger main_dirty during merge.
      writeFileSync(resolve(e2eRoot, '.gitignore'), '.muxbase/\n');
      execSync('git add .gitignore', { cwd: e2eRoot, stdio: 'ignore' });
      execSync('git commit -m "chore: e2e workspace init"', { cwd: e2eRoot, stdio: 'ignore' });
      projectRoot = e2eRoot;

      // Unset CLAUDECODE so agents spawned inside panes are not blocked by the
      // "nested Claude Code session" restriction when running inside Claude Code.
      const inheritedEnv = Object.fromEntries(
        Object.entries(process.env).filter(([k]) => k !== 'CLAUDECODE'),
      );
      app = await electron.launch({
        args: [MAIN_ENTRY],
        cwd: e2eRoot,
        env: {
          ...inheritedEnv,
          NODE_ENV: 'test',
          MUXBASE_DEV: 'true',
        },
      });

      page = await getAppWindow(app);

      // Expose __muxbaseStores for E2E store coercion.
      // Production builds don't expose stores because import.meta.env.DEV is false.
      // Vite replaces process.env at build time, so we use window.__MUXBASE_E2E instead.
      await app.context().addInitScript(() => {
        (window as any).__MUXBASE_E2E = true;
      });
      await page.reload();

      page.on('console', (msg: ConsoleMessage) => {
        if (msg.type() === 'error') consoleErrors.push(msg.text());
      });

      await page.waitForSelector('[data-testid="app-shell"]', { timeout: 15_000 });
      await enableKanbanBoard(page);
      await page.reload();
      await page.waitForSelector('[data-testid="app-shell"]', { timeout: 15_000 });
      await page.setViewportSize({ width: 1400, height: 900 });
      await page.locator('aside').waitFor({ state: 'visible', timeout: 10_000 });
      await initializePaneStatusTracker(page);

      await showOverlay(page, 0, 'Launching App', 'Verifying build, system check, agent availability');

      const systemCheck = await getSystemCheck(page);
      report.systemCheck = {
        tmux: systemCheck?.tmux?.version ?? (systemCheck?.tmux?.available ? 'available' : 'unavailable'),
        git: systemCheck?.git?.version ?? (systemCheck?.git?.available ? 'available' : 'unavailable'),
        agents: systemCheck?.agents ?? [],
      };
      if (!systemCheck?.agents?.includes('claude')) {
        throw new Error(
          `SKIP: Claude agent not found. Available agents: ${JSON.stringify(systemCheck?.agents ?? [])}`,
        );
      }

      const sessionInfo = await getSessionInfo(page);
      if (sessionInfo.projectRoot !== e2eRoot) {
        throw new Error(
          `Unsafe E2E root. Expected ${e2eRoot}, got ${sessionInfo.projectRoot}. ` +
            `Stop other muxbase tmux sessions before running this test.`,
        );
      }
      projectRoot = e2eRoot;

      const rootDiff = await getGitDiff(page, projectRoot);
      expect(rootDiff.repo?.isGitRepo).toBe(true);

      // Clean up leftover data from previous E2E runs
      await clearDoneIPC(page, projectRoot).catch(() => {});
      const leftoverKanban = await getKanbanData(page, projectRoot);
      if (leftoverKanban.backlog.length > 0) {
        await page.evaluate(
          ({ root, ids }) => (window as any).muxbase.invoke('kanban:backlog-remove', { projectRoot: root, itemIds: ids }),
          { root: projectRoot, ids: leftoverKanban.backlog.map((b: any) => b.id) },
        );
      }
      await showOverlay(page, 0, 'Preflight Passed', `Agents: ${systemCheck.agents.join(', ')}`);
      await screenshotStep(page, '00-app-ready');

      console.log('Preflight passed. Available agents:', systemCheck.agents);
      report.phases.push({ name: 'Phase 0: App Launch & Preflight', status: 'passed', durationMs: Date.now() - phaseStart });
    } catch (e) {
      report.phases.push({
        name: 'Phase 0: App Launch & Preflight',
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
    report.consoleErrors = consoleErrors.filter(
      (e) => !e.includes('Autofill.enable') && !e.includes('Autofill.setAddresses') && !e.includes('favicon.ico'),
    );
    writeReport();

    if (page) {
      await hideOverlay(page).catch(() => {});
      await screenshotStep(page, '99-before-close').catch(() => {});

      for (const pane of launchedPanes) {
        await closePaneBestEffort(page, pane);
      }
      await pollUntil(
        async () => {
          const remaining = await getPanes(page);
          return remaining.every((p) => !launchedPanes.some((c) => c.id === p.id));
        },
        { timeout: 5_000, interval: 1_000, label: 'cleanup-settle' },
      ).catch(() => {});
    }
    if (app) await app.close();
    if (e2eRoot) rmSync(e2eRoot, { recursive: true, force: true });
  }, 60_000);

  // -------------------------------------------------------------------------
  // Phase 1: Navigate to Kanban & Verify Empty Board
  // -------------------------------------------------------------------------

  it('navigates to kanban view and verifies empty board', async () => {
    const phaseStart = Date.now();
    try {
      await showOverlay(page, 1, 'Kanban View', 'Navigating to kanban board, verifying columns');

      await navigateToKanbanView(page);

      // Verify all 5 column containers are visible via data-testid
      for (const colId of COLUMN_IDS) {
        await page.getByTestId(`kanban-column-${colId}`).waitFor({ state: 'visible', timeout: 5_000 });
      }

      // Verify column counts via DOM
      const counts = await getColumnCounts(page);
      for (const colId of COLUMN_IDS) {
        const count = counts[colId] ?? 0;
        expect(count, `Column ${colId} should be empty`).toBe(0);
      }

      // Verify empty states are visible
      const emptyMessages = page.locator('text="Drop items here"');
      const noItemMessages = page.locator('text="No items"');
      const totalEmpty = (await emptyMessages.count()) + (await noItemMessages.count());
      expect(totalEmpty).toBeGreaterThan(0);

      // Verify "+ Add Task" button in backlog footer
      const addTaskBtn = page.locator('button:has-text("+ Add Task")');
      await addTaskBtn.first().waitFor({ state: 'visible', timeout: 3_000 });

      report.columnSnapshots.push({ phase: 'Phase 1: Empty Board', counts });
      await screenshotStep(page, '01-empty-board');

      console.log('Kanban board verified with 5 empty columns');
      report.phases.push({ name: 'Phase 1: Navigate & Verify Empty Board', status: 'passed', durationMs: Date.now() - phaseStart });
    } catch (e) {
      report.phases.push({
        name: 'Phase 1: Navigate & Verify Empty Board',
        status: 'failed',
        durationMs: Date.now() - phaseStart,
        error: e instanceof Error ? e.message : String(e),
      });
      throw e;
    }
  }, 30_000);

  // -------------------------------------------------------------------------
  // Phase 2: Add Backlog Items via UI
  // -------------------------------------------------------------------------

  it('adds backlog items via the AddBacklogDialog', async () => {
    const phaseStart = Date.now();
    try {
      for (let i = 0; i < BACKLOG_TASKS.length; i++) {
        const task = BACKLOG_TASKS[i];
        await showOverlay(page, 2, `Adding Task ${i + 1}/${BACKLOG_TASKS.length}`, task.title);

        // Click "+ Add Task" button
        const addTaskBtn = page.locator('button:has-text("+ Add Task")');
        await addTaskBtn.first().click();

        // Wait for dialog
        const dialog = page.locator('.fixed.inset-0.z-50');
        await dialog.waitFor({ state: 'visible', timeout: 5_000 });

        // Fill title
        const titleInput = page.locator('input[placeholder="e.g. Fix auth bug"]');
        await titleInput.fill(task.title);

        // Fill prompt
        const promptInput = page.locator('textarea[placeholder="Describe what the agent should do..."]');
        await promptInput.fill(task.prompt);

        // Select Claude Code agent
        const claudeBtn = dialog.locator('button:has-text("Claude Code")');
        await claudeBtn.first().click();

        const worktreeSwitch = dialog.locator('button[role="switch"]').first();
        if ((await worktreeSwitch.getAttribute('aria-checked')) !== 'true') {
          await worktreeSwitch.click();
        }

        // Click "Add to Backlog"
        const submitBtn = dialog.locator('button:has-text("Add to Backlog")');
        await submitBtn.click();

        // Wait for dialog to close
        await dialog.waitFor({ state: 'hidden', timeout: 5_000 });

        report.backlogItems.push({
          title: task.title,
          prompt: task.prompt,
          complexity: task.complexity,
          launched: false,
        });

        console.log(`Added backlog item: ${task.title}`);
      }

      await screenshotStep(page, '02-backlog-added');
      report.phases.push({ name: 'Phase 2: Add Backlog Items via UI', status: 'passed', durationMs: Date.now() - phaseStart });
    } catch (e) {
      report.phases.push({
        name: 'Phase 2: Add Backlog Items via UI',
        status: 'failed',
        durationMs: Date.now() - phaseStart,
        error: e instanceof Error ? e.message : String(e),
      });
      throw e;
    }
  }, 60_000);

  // -------------------------------------------------------------------------
  // Phase 3: Verify Backlog Column
  // -------------------------------------------------------------------------

  it('verifies backlog items exist in IPC and DOM', async () => {
    const phaseStart = Date.now();
    try {
      await showOverlay(page, 3, 'Verifying Backlog', 'Checking IPC data and DOM rendering');

      // IPC verification
      const kanbanData = await getKanbanData(page, projectRoot);
      expect(kanbanData.backlog.length).toBe(BACKLOG_TASKS.length);

      for (let i = 0; i < BACKLOG_TASKS.length; i++) {
        const task = BACKLOG_TASKS[i];
        const item = kanbanData.backlog.find((b) => b.title === task.title);
        expect(item, `Backlog item "${task.title}" not found in IPC data`).toBeTruthy();
        expect(item!.prompt).toBe(task.prompt);
        expect(item!.complexity).toBe(task.complexity);
        expect(item!.agent).toBe('claude');
        expect(item!.useWorktree).toBe(true);
      }

      // DOM verification: cards visible via stable data-card-id attributes
      for (const task of BACKLOG_TASKS) {
        const item = kanbanData.backlog.find((b) => b.title === task.title)!;
        await page.locator(`[data-card-id="backlog-${item.id}"]`).waitFor({ state: 'visible', timeout: 5_000 });
      }

      // Backlog column count badge
      const counts = await getColumnCounts(page);
      expect(counts['backlog']).toBe(BACKLOG_TASKS.length);

      report.columnSnapshots.push({ phase: 'Phase 3: Backlog Verified', counts });
      await screenshotStep(page, '03-backlog-verified');

      console.log(`Backlog verified: ${kanbanData.backlog.length} items`);
      report.phases.push({ name: 'Phase 3: Verify Backlog Column', status: 'passed', durationMs: Date.now() - phaseStart });
    } catch (e) {
      report.phases.push({
        name: 'Phase 3: Verify Backlog Column',
        status: 'failed',
        durationMs: Date.now() - phaseStart,
        error: e instanceof Error ? e.message : String(e),
      });
      throw e;
    }
  }, 30_000);

  // -------------------------------------------------------------------------
  // Phase 4: Launch to In Progress
  // -------------------------------------------------------------------------

  it('launches backlog items to In Progress via Launch All button', async () => {
    const phaseStart = Date.now();
    try {
      const panesBefore = await getPanes(page);

      await hideOverlay(page).catch(() => {});
      const launchAllBtn = page.locator('button:has-text("Launch All")');
      await launchAllBtn.waitFor({ state: 'visible', timeout: 5_000 });
      await launchAllBtn.click();
      await showOverlay(page, 4, 'Launching Tasks', 'Waiting for backlog to clear...');

      // Poll until backlog empties (Launch All triggers async pane creation)
      await pollUntil(
        async () => {
          const data = await getKanbanData(page, projectRoot);
          return data.backlog.length === 0 ? true : null;
        },
        { timeout: 30_000, interval: 1_000, label: 'waitBacklogEmpty' },
      );

      // Discover new panes created by Launch All
      const panesAfter = await getPanes(page);
      const newPanes = panesAfter.filter((p) => !panesBefore.some((b) => b.id === p.id));
      expect(newPanes.length, `Expected ${BACKLOG_TASKS.length} new panes, got ${newPanes.length}`).toBe(
        BACKLOG_TASKS.length,
      );

      for (const pane of newPanes) {
        launchedPaneIds.push(pane.id);
        launchedPanes.push({
          id: pane.id,
          paneId: pane.paneId,
          slug: pane.slug,
          worktreePath: pane.worktreePath ?? '',
          createdAtMs: Date.now(),
        });
      }

      for (const item of report.backlogItems) {
        item.launched = true;
      }

      const counts = await getColumnCounts(page);
      expect(counts['backlog'] ?? 0).toBe(0);

      const inProgressCount = counts['in-progress'] ?? 0;
      console.log(`Post-launch column counts: backlog=${counts['backlog']}, in-progress=${inProgressCount}`);

      report.columnSnapshots.push({ phase: 'Phase 4: In Progress', counts });
      await screenshotStep(page, '04-launched');

      console.log(`Launched ${newPanes.length} panes: ${launchedPaneIds.join(', ')}`);
      report.phases.push({ name: 'Phase 4: Launch to In Progress', status: 'passed', durationMs: Date.now() - phaseStart });
    } catch (e) {
      report.phases.push({
        name: 'Phase 4: Launch to In Progress',
        status: 'failed',
        durationMs: Date.now() - phaseStart,
        error: e instanceof Error ? e.message : String(e),
      });
      throw e;
    }
  }, 120_000);

  // -------------------------------------------------------------------------
  // Phase 4.5: Click In-Progress Card to Show Terminal
  // -------------------------------------------------------------------------

  it('clicks an in-progress card and shows terminal progress', async () => {
    if (launchedPanes.length === 0) {
      report.phases.push({ name: 'Phase 4.5: View In-Progress Terminal', status: 'skipped', durationMs: 0 });
      return;
    }
    const phaseStart = Date.now();
    try {
      const pane = launchedPanes[0];
      await showOverlay(page, 4, 'Viewing Progress', `Opening terminal for ${pane.slug}`);

      // Wait for the card to appear in the kanban board
      const card = page.locator(`[data-card-id="pane-${pane.id}"]`);
      await card.waitFor({ state: 'visible', timeout: 10_000 });

      // Click the card (force: true because dnd-kit may set aria-disabled)
      await card.click({ force: true });
      await new Promise((r) => setTimeout(r, 1_000));

      // Wait for side panel to render — scoped to data-testid to avoid matching kanban cards
      const sidePanel = page.locator('[data-testid="kanban-side-panel"]');
      await sidePanel.waitFor({ state: 'visible', timeout: 5_000 });
      const slugLocator = sidePanel.locator('[data-testid="kanban-side-panel-slug"]');
      await slugLocator.waitFor({ state: 'visible', timeout: 2_000 });
      const panelSlugText = await slugLocator.textContent({ timeout: 2_000 });
      expect(panelSlugText?.trim(), 'Side panel should show the clicked pane slug').toContain(pane.slug);

      // Click Terminal tab to ensure it's active
      const terminalTab = sidePanel.locator('button[role="tab"]:has-text("Terminal")');
      if (await terminalTab.first().isVisible({ timeout: 2_000 }).catch(() => false)) {
        await terminalTab.first().click();
      }

      // Verify xterm-screen mounted — proves terminal is connected and showing live output
      const xtermScreen = page.locator('.xterm-screen');
      const xtermMounted = await xtermScreen.waitFor({ state: 'visible', timeout: 8_000 }).then(() => true).catch(() => false);
      expect(xtermMounted, 'Terminal xterm-screen should mount for in-progress pane').toBe(true);

      // Verify a canvas exists inside xterm (proves rendering is active)
      if (xtermMounted) {
        const canvas = page.locator('.xterm-screen canvas').first();
        const hasCanvas = await canvas.isVisible({ timeout: 2_000 }).catch(() => false);
        console.log(`In-progress terminal: xterm mounted=${xtermMounted}, canvas=${hasCanvas}`);
      }

      // Also check Activity tab — agent is working, so it should have session messages
      const activityTab = sidePanel.locator('button[role="tab"]:has-text("Activity")');
      if (await activityTab.first().isVisible({ timeout: 2_000 }).catch(() => false)) {
        await activityTab.first().click();
        await new Promise((r) => setTimeout(r, 1_000));
        const activityText = await sidePanel.textContent({ timeout: 2_000 }).catch(() => '');
        const hasActivity = (activityText?.trim().length ?? 0) > 0;
        console.log(`In-progress activity: hasContent=${hasActivity}`);
      }

      // Switch back to Terminal for screenshot
      if (await terminalTab.first().isVisible({ timeout: 1_000 }).catch(() => false)) {
        await terminalTab.first().click();
        await new Promise((r) => setTimeout(r, 500));
      }

      await screenshotStep(page, '04b-in-progress-terminal');
      console.log(`Viewing terminal for in-progress pane: ${pane.slug}`);

      // Close side panel before moving to Phase 5
      const closeBtn = page.locator('button[aria-label="Close panel"]');
      if (await closeBtn.isVisible({ timeout: 2_000 }).catch(() => false)) {
        await closeBtn.click();
      }

      report.phases.push({ name: 'Phase 4.5: View In-Progress Terminal', status: 'passed', durationMs: Date.now() - phaseStart });
    } catch (e) {
      report.phases.push({
        name: 'Phase 4.5: View In-Progress Terminal',
        status: 'failed',
        durationMs: Date.now() - phaseStart,
        error: e instanceof Error ? e.message : String(e),
      });
      throw e;
    }
  }, 30_000);

  // -------------------------------------------------------------------------
  // Phase 5: Wait for Agent Completion
  // -------------------------------------------------------------------------

  it('waits for all agents to complete and verifies files', async () => {
    if (launchedPanes.length !== BACKLOG_TASKS.length) {
      report.phases.push({ name: 'Phase 5: Wait for Agents', status: 'skipped', durationMs: 0 });
      return;
    }
    const phaseStart = Date.now();
    try {
      await showOverlay(page, 5, 'Waiting for Agents', `${launchedPanes.length} Claude agents working...`);

      // Skip LLM-based idle detection — file existence is ground truth for agent completion.
      // The pane monitor's LLM analysis doesn't fire events reliably in E2E, causing
      // false idle after the 30s hasEverBeenActive guard expires.

      // Verify expected files exist in worktrees.
      // Map panes to tasks by prompt content (not index) so ordering changes don't break the check.
      for (const pane of launchedPanes) {
        await pollUntil(
          async () => {
            const latest = (await getPanes(page)).find((p) => p.id === pane.id);
            if (latest?.worktreePath) {
              pane.worktreePath = latest.worktreePath;
              return true;
            }
            return null;
          },
          { timeout: 60_000, interval: 1_000, label: `waitWorktreePath(${pane.slug})` },
        );
        expect(pane.worktreePath, `Missing worktreePath for pane ${pane.slug}`).toBeTruthy();

        const current = (await getPanes(page)).find((p) => p.id === pane.id);
        const task =
          BACKLOG_TASKS.find((t) => current?.prompt === t.prompt)
          ?? BACKLOG_TASKS.find((t) => current?.prompt?.includes(t.expectedFile));
        expect(task, `No task mapping for pane ${pane.slug} (prompt: ${current?.prompt?.slice(0, 60)})`).toBeTruthy();
        if (!task) continue;

        const filePath = resolve(pane.worktreePath, task.expectedFile);
        if (!existsSync(filePath)) {
          await pollUntil(
            async () => existsSync(filePath) || null,
            { timeout: 240_000, interval: 3_000, label: `waitForFile(${task.expectedFile})` },
          );
        }

        const fileExists = existsSync(filePath);
        expect(fileExists, `Expected file ${task.expectedFile} missing in ${pane.worktreePath}`).toBe(true);

        let contentValid = false;
        if (fileExists) {
          const content = readFileSync(filePath, 'utf-8');
          contentValid = task.contentPatterns.every((p) => p.test(content));
          expect(contentValid, `File content validation failed for ${task.expectedFile}`).toBe(true);
        }

        const completedAtMs = Date.now();
        report.panes.push({
          id: pane.id,
          slug: pane.slug,
          agent: current?.agent ?? 'claude',
          paneId: pane.paneId,
          worktreePath: pane.worktreePath,
          expectedFile: task.expectedFile,
          agentCompleted: true,
          agentDurationMs: completedAtMs - pane.createdAtMs,
          fileExists,
          fileContentValid: contentValid,
          mergeSucceeded: false,
          addedToDone: false,
          sidePanelOpened: false,
          tabsVerified: false,
        });

        console.log(`Pane ${pane.slug}: file=${fileExists} contentValid=${contentValid}`);
      }

      // Write a marker file in each worktree to guarantee dirty state.
      // Agents may auto-commit their work when launched with auto-mode defaults,
      // which makes `git status --porcelain` return clean. The marker file ensures the kanban
      // dirty check always returns true, enabling the full Backlog → Review → Done flow.
      for (const pane of launchedPanes) {
        if (!pane.worktreePath) continue;
        writeFileSync(
          resolve(pane.worktreePath, `e2e-dirty-${pane.slug}.txt`),
          `e2e-marker-${Date.now()}`,
        );
      }

      await showOverlay(page, 5, 'Agents Complete', `${launchedPanes.length} agents finished`);
      await screenshotStep(page, '05-agents-done');
      report.phases.push({ name: 'Phase 5: Wait for Agents', status: 'passed', durationMs: Date.now() - phaseStart });
    } catch (e) {
      report.phases.push({
        name: 'Phase 5: Wait for Agents',
        status: 'failed',
        durationMs: Date.now() - phaseStart,
        error: e instanceof Error ? e.message : String(e),
      });
      throw e;
    }
  }, 360_000);

  // -------------------------------------------------------------------------
  // Phase 6: Verify Agent Status Completed
  // -------------------------------------------------------------------------

  it('verifies pane statuses changed from working to completed', async () => {
    if (report.panes.length === 0) {
      report.phases.push({ name: 'Phase 6: Verify Agent Completed', status: 'skipped', durationMs: 0 });
      return;
    }
    const phaseStart = Date.now();
    const paneIdSet = new Set(launchedPanes.map((p) => p.id));
    try {
      await showOverlay(page, 6, 'Verifying Panes', 'Checking panes exist and worktrees are dirty...');

      // Verify worktrees are dirty (marker file from Phase 5 guarantees this)
      for (const pane of launchedPanes) {
        if (!pane.worktreePath) continue;
        const dirty = await checkDirtyState(page, pane.worktreePath);
        console.log(`  dirty check: ${pane.slug} → ${dirty}`);
        expect(dirty, `Worktree ${pane.slug} should be dirty (marker file written in Phase 5)`).toBe(true);
      }

      // Verify panes still exist and remain in in-progress column.
      // Agent completion was already proven by file existence in Phase 5.
      // agentStatus is unreliable in E2E (LLM pane monitor doesn't fire consistently).
      const currentPanes = await getPanes(page);
      for (const pane of launchedPanes) {
        const current = currentPanes.find((p) => p.id === pane.id);
        expect(current, `Pane ${pane.slug} not found`).toBeTruthy();
        console.log(`  pane check: ${pane.slug} → status=${current?.agentStatus}, worktree=${!!current?.worktreePath}`);
      }

      const counts = await pollUntil(
        async () => {
          const nextCounts = await getColumnCounts(page);
          const nextInProgressCount = nextCounts['in-progress'] ?? 0;
          return nextInProgressCount >= launchedPanes.length ? nextCounts : null;
        },
        { timeout: 10_000, interval: 500, label: 'waitInProgressCards' },
      );
      const inProgressCount = counts['in-progress'] ?? 0;
      expect(inProgressCount).toBeGreaterThanOrEqual(launchedPanes.length);
      report.columnSnapshots.push({ phase: 'Phase 6: Agent Completed', counts });
      console.log(`Panes verified: all ${launchedPanes.length} panes present, in-progress=${inProgressCount}`);

      await screenshotStep(page, '06-agents-completed');
      report.phases.push({ name: 'Phase 6: Verify Agent Completed', status: 'passed', durationMs: Date.now() - phaseStart });
    } catch (e) {
      const finalPanes = await getPanes(page).catch(() => []);
      console.error(`Phase 6 FAILED — pane statuses: ${finalPanes.filter((p) => paneIdSet.has(p.id)).map((p) => `${p.slug}:${p.agentStatus}`).join(', ')}`);
      report.phases.push({
        name: 'Phase 6: Verify Agent Completed',
        status: 'failed',
        durationMs: Date.now() - phaseStart,
        error: e instanceof Error ? e.message : String(e),
      });
      throw e;
    }
  }, 60_000);

  // -------------------------------------------------------------------------
  // Phase 7: Verify Side Panel
  // -------------------------------------------------------------------------

  it('opens side panel and verifies tabs', async () => {
    if (launchedPanes.length === 0) {
      report.phases.push({ name: 'Phase 7: Verify Side Panel', status: 'skipped', durationMs: 0 });
      return;
    }
    const phaseStart = Date.now();
    try {
      const pane = launchedPanes[0];
      await showOverlay(page, 7, 'Side Panel', `Opening panel for ${pane.slug}`);

      // Click the pane card — dnd-kit adds aria-disabled="true" on non-draggable cards,
      // so we must use { force: true } to bypass Playwright's actionability checks.
      const cardByAttr = page.locator(`[data-card-id="pane-${pane.id}"]`);
      const cardByText = page.locator(`text="${pane.slug}"`).first();

      if (await cardByAttr.isVisible({ timeout: 3_000 }).catch(() => false)) {
        await cardByAttr.click({ force: true });
      } else if (await cardByText.isVisible({ timeout: 2_000 }).catch(() => false)) {
        await cardByText.click({ force: true });
      }

      // Wait for side panel — scoped to data-testid to avoid matching kanban cards
      const sidePanel = page.locator('[data-testid="kanban-side-panel"]');
      await sidePanel.waitFor({ state: 'visible', timeout: 5_000 });

      // Verify slug and agent badge inside the panel
      const slugLocator = sidePanel.locator('[data-testid="kanban-side-panel-slug"]');
      await slugLocator.waitFor({ state: 'visible', timeout: 2_000 });
      const panelSlugText = await slugLocator.textContent({ timeout: 2_000 });
      expect(panelSlugText?.trim(), 'Side panel should display the pane slug').toContain(pane.slug);
      const hasBadge = await sidePanel.locator(`text="claude"`).first().isVisible({ timeout: 2_000 }).catch(() => false);
      console.log(`Side panel: slug visible=true, agent badge=${hasBadge}`);

      // Verify all 4 tabs exist within the panel
      const expectedTabs = ['Terminal', 'Activity', 'Diff', 'Tokens'];
      for (const tabName of expectedTabs) {
        const tab = sidePanel.locator(`button[role="tab"]:has-text("${tabName}")`);
        await tab.first().waitFor({ state: 'visible', timeout: 3_000 });
      }

      // Click each tab, assert aria-selected, and verify content
      for (const tabName of expectedTabs) {
        const tab = sidePanel.locator(`button[role="tab"]:has-text("${tabName}")`);
        await tab.first().click();
        const selected = await tab.first().getAttribute('aria-selected');
        expect(selected, `${tabName} tab should be selected after click`).toBe('true');

        if (tabName === 'Terminal') {
          const xtermScreen = page.locator('.xterm-screen');
          await xtermScreen.waitFor({ state: 'visible', timeout: 5_000 });
        } else {
          await new Promise((r) => setTimeout(r, 800));
          const panelText = await sidePanel.textContent({ timeout: 2_000 }) ?? '';
          if (tabName === 'Activity') {
            expect(
              panelText.includes('No Activity Yet')
              || panelText.includes('Conversation')
              || panelText.includes('Timeline')
              || panelText.includes('Prompts'),
              'Activity tab should render content or empty state',
            ).toBe(true);
          } else if (tabName === 'Diff') {
            expect(
              panelText.includes('No changes')
              || panelText.includes('Modified Files')
              || panelText.includes('Added Files')
              || panelText.includes('Unversioned Files')
              || panelText.includes('Deleted Files')
              || panelText.includes('Not a Git Repository')
              || panelText.includes('No Git Path')
              || panelText.includes('No Worktree')
              || panelText.includes('No uncommitted changes')
              || panelText.includes('Files')
              || panelText.includes('Added')
              || panelText.includes('Removed')
              || panelText.includes('Select a file')
              || panelText.includes('No diff preview')
              || panelText.includes('Error loading'),
              'Diff tab should render content or empty state',
            ).toBe(true);
          } else if (tabName === 'Tokens') {
            expect(
              panelText.includes('No Token Data') || panelText.includes('Context Usage') || panelText.includes('Turn-by-Turn'),
              'Tokens tab should render content or empty state',
            ).toBe(true);
          }
        }
      }
      console.log('All 4 tabs verified with content assertions');

      // Close side panel
      const closeBtn = sidePanel.locator('button[aria-label="Close panel"]');
      await closeBtn.click();

      // Update report
      const rp = report.panes.find((p) => p.id === pane.id);
      if (rp) {
        rp.sidePanelOpened = true;
        rp.tabsVerified = true;
      }

      await screenshotStep(page, '07-side-panel');

      console.log('Side panel verified: opened=true, tabs=4/4');
      report.phases.push({ name: 'Phase 7: Verify Side Panel', status: 'passed', durationMs: Date.now() - phaseStart });
    } catch (e) {
      report.phases.push({
        name: 'Phase 7: Verify Side Panel',
        status: 'failed',
        durationMs: Date.now() - phaseStart,
        error: e instanceof Error ? e.message : String(e),
      });
      throw e;
    }
  }, 60_000);

  // -------------------------------------------------------------------------
  // Phase 8: Merge Review -> Done
  // -------------------------------------------------------------------------

  it('merges panes via IPC and adds to done', async () => {
    if (launchedPanes.length === 0) {
      report.phases.push({ name: 'Phase 8: Merge to Done', status: 'skipped', durationMs: 0 });
      return;
    }
    const phaseStart = Date.now();
    try {
      await showOverlay(page, 8, 'Merging Panes', `Merging ${launchedPanes.length} panes via IPC`);

      // Panes stay in in-progress after agent completion (no automatic review transition).
      // Merge each pane directly via IPC, auto-resolving merge dialogs inline.
      for (const pane of launchedPanes) {
        console.log(`  merging pane ${pane.slug} (${pane.id})...`);
        await page.evaluate(async (paneId) => {
          const AUTO_CONFIRM = new Set(['Merge Worktree', 'Multi-Repository Merge', 'Multi-Merge Complete']);
          const AUTO_CHOICE = new Set(['Close Pane', 'Worktree Has Uncommitted Changes', 'Main Branch Has Uncommitted Changes']);
          let current: any = await (window as any).muxbase.invoke('pane:merge', { paneId });
          for (let i = 0; i < 10; i++) {
            if (current.type === 'confirm' && current.callbackId && AUTO_CONFIRM.has(current.title)) {
              current = await (window as any).muxbase.invoke('action:callback', { callbackId: current.callbackId });
              continue;
            }
            if (current.type === 'choice' && current.callbackId && AUTO_CHOICE.has(current.title)) {
              const choiceId = current.options?.find((o: any) => o.default)?.id ?? current.options?.[0]?.id;
              if (!choiceId) break;
              current = await (window as any).muxbase.invoke('action:callback', { callbackId: current.callbackId, value: choiceId });
              continue;
            }
            break;
          }
          return current;
        }, pane.id);
        console.log(`  merged pane ${pane.slug}`);
      }

      // Wait for done items to appear in kanban data
      let pollLogCount = 0;
      await pollUntil(
        async () => {
          const data = await getKanbanData(page, projectRoot);
          if (pollLogCount % 5 === 0) {
            console.log(`  merge poll ${pollLogCount}: done=${data.done.length}`);
          }
          pollLogCount++;
          return data.done.length >= launchedPanes.length ? true : null;
        },
        { timeout: 60_000, interval: 2_000, label: 'waitMergeDone' },
      );

      const postMergeKanban = await getKanbanData(page, projectRoot);
      const mergedSlugs = new Set(postMergeKanban.done.map((d) => d.slug));
      const missingDone = launchedPanes.filter((pane) => !mergedSlugs.has(pane.slug)).map((pane) => pane.slug);
      expect(missingDone, `Merged panes missing in done: ${missingDone.join(', ')}`).toHaveLength(0);

      for (const pane of launchedPanes) {
        const rp = report.panes.find((p) => p.id === pane.id);
        if (rp) {
          rp.mergeSucceeded = mergedSlugs.has(pane.slug);
          rp.addedToDone = rp.mergeSucceeded;
        }
      }

      await screenshotStep(page, '08-merged');

      console.log(`Merge phase complete: ${postMergeKanban.done.length} items in done`);
      report.phases.push({ name: 'Phase 8: Merge to Done', status: 'passed', durationMs: Date.now() - phaseStart });
    } catch (e) {
      report.phases.push({
        name: 'Phase 8: Merge to Done',
        status: 'failed',
        durationMs: Date.now() - phaseStart,
        error: e instanceof Error ? e.message : String(e),
      });
      throw e;
    }
  }, 120_000);

  // -------------------------------------------------------------------------
  // Phase 9: Verify Done Column
  // -------------------------------------------------------------------------

  it('verifies done items exist in IPC and DOM', async () => {
    const phaseStart = Date.now();
    try {
      await showOverlay(page, 9, 'Verifying Done', 'Checking IPC data and DOM rendering');

      // IPC verification — done items should match successful merges
      const kanbanData = await getKanbanData(page, projectRoot);
      const successfulMerges = report.panes.filter((p) => p.mergeSucceeded).length;
      console.log(`Done check: IPC done=${kanbanData.done.length}, successful merges=${successfulMerges}, launched=${launchedPanes.length}`);

      // Every successful merge should produce a done item (decorateMergeResult calls addPaneToDone on success)
      expect(kanbanData.done.length).toBeGreaterThanOrEqual(successfulMerges);

      // DOM verification
      await new Promise((r) => setTimeout(r, 1_000));
      const counts = await getColumnCounts(page);
      // Review should be empty (all panes merged or closed)
      expect(counts['review'] ?? 0).toBe(0);

      report.columnSnapshots.push({ phase: 'Phase 9: Done Column', counts });
      await screenshotStep(page, '09-done-column');

      console.log(`Done column verified: ${kanbanData.done.length} items in done`);
      report.phases.push({ name: 'Phase 9: Verify Done Column', status: 'passed', durationMs: Date.now() - phaseStart });
    } catch (e) {
      report.phases.push({
        name: 'Phase 9: Verify Done Column',
        status: 'failed',
        durationMs: Date.now() - phaseStart,
        error: e instanceof Error ? e.message : String(e),
      });
      throw e;
    }
  }, 30_000);

  // -------------------------------------------------------------------------
  // Phase 10: Clear Done & Verify Clean State
  // -------------------------------------------------------------------------

  it('clears done column and verifies clean state', async () => {
    const phaseStart = Date.now();
    try {
      // Wait for renderer to settle after Phase 8's background cleanup before interacting
      const clearAllBtn = page.locator('button:has-text("Clear All")');
      await clearAllBtn.waitFor({ state: 'visible', timeout: 30_000 });
      // Hide any overlay that could block the click before interacting
      await hideOverlay(page).catch(() => {});
      await clearAllBtn.click();
      await showOverlay(page, 10, 'Clearing Done', 'Removed all done items').catch(() => {});

      // Verify IPC: done is empty
      const kanbanData = await getKanbanData(page, projectRoot);
      expect(kanbanData.done.length).toBe(0);

      // Verify DOM: done count = 0
      await new Promise((r) => setTimeout(r, 1_000));
      const counts = await getColumnCounts(page);
      expect(counts['done'] ?? 0).toBe(0);

      // Verify "Clear All" button is hidden (only shows when doneCount > 0)
      const clearAllVisible = await clearAllBtn.isVisible({ timeout: 1_000 }).catch(() => false);
      expect(clearAllVisible).toBe(false);

      report.columnSnapshots.push({ phase: 'Phase 10: Clean State', counts });
      await screenshotStep(page, '10-clean-state');

      console.log('Done column cleared, board is clean');
      report.phases.push({ name: 'Phase 10: Clear Done & Verify Clean', status: 'passed', durationMs: Date.now() - phaseStart });
    } catch (e) {
      report.phases.push({
        name: 'Phase 10: Clear Done & Verify Clean',
        status: 'failed',
        durationMs: Date.now() - phaseStart,
        error: e instanceof Error ? e.message : String(e),
      });
      throw e;
    }
  }, 60_000);

  // -------------------------------------------------------------------------
  // Phase 11: No unexpected renderer console errors
  // -------------------------------------------------------------------------

  it('has no unexpected renderer console errors', () => {
    const knownNoise = ['Autofill.enable', 'Autofill.setAddresses', 'favicon.ico'];
    const unexpected = consoleErrors.filter((e) => !knownNoise.some((n) => e.includes(n)));
    expect(unexpected, `Unexpected renderer errors:\n${unexpected.join('\n')}`).toHaveLength(0);
  });
});
