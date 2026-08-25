// Scene composition for both cuts: staged-store mutation + narrative
// sequencing, built from the cinema system (camera/cursor/transitions/
// callouts) and the overlay builders (terminal/focus/kanban/marketplace/
// review/file-browser/misc).
import type { Page } from 'playwright';
import {
  callout,
  camera,
  clickRipple,
  clickSelector,
  dissolve,
  hideCallout,
  hideCursor,
  moveCursorTo,
  moveCursorToSelector,
  resetCamera,
  showCursor,
  sleep,
  staggerChildren,
  tickCounter,
  trace,
  typeIntoElement,
  vignetteSpotlight,
  vignetteSpotlightOff,
} from './cinema';
import * as brand from './cinema-brand';
import {
  ANTHROPIC_PROVIDER_STATUS,
  buildSession,
  DEMO_PANES,
  OPENAI_PROVIDER_STATUS,
} from './fixtures';
import {
  assertStagedTerminalsClean,
  clearMockTerminals,
  hideCreateDialogMockup,
  hideFileBrowserPanel,
  hideMarketplaceMockup,
  hideProviderHealthMockup,
  hideReviewPaneSpawn,
  hideReviewPopover,
  hideSendFixesDialog,
  paintFileBrowserFileOpen,
  paintFileBrowserPanel,
  paintFleetTopBar,
  paintFocusPanel,
  paintMarketplaceMockup,
  paintMockTerminals,
  paintReviewPaneSpawn,
  paintReviewPopover,
  paintSendFixesDialog,
  setFocusPanelSection,
  showCreateDialogMockup,
  showProviderHealthMockup,
} from './overlays';

type ViewMode = 'fleet' | 'focus' | 'kanban' | 'summary';
type AgentStatus = 'working' | 'analyzing' | 'waiting' | 'idle';

// ── Staged-store mutation helpers ─────────────────────────────────────
async function installDemoBootstrap(page: Page): Promise<void> {
  await page.evaluate(
    (data) => {
      const w = window as any;
      w.__MUXBASE_E2E = true;
      const stores = w.__muxbaseStores;
      if (!stores) return;

      const sanitizedPanes = data.panes.map((p: any) => ({ ...p, type: 'worktree' }));
      stores.pane.setState({
        panes: sanitizedPanes,
        loaded: true,
        selectedPaneId: sanitizedPanes[0]?.id ?? null,
      });

      const sessionMap: Record<string, any> = {};
      for (const session of data.sessions) sessionMap[session.paneId] = session.session;
      stores.agentSession.setState({ sessions: sessionMap });
    },
    {
      panes: DEMO_PANES,
      sessions: DEMO_PANES.map((p) => ({ paneId: p.id, session: buildSession(p) })),
    },
  );
}

async function setProviderHealth(page: Page): Promise<void> {
  await page.evaluate((statuses) => {
    const w = window as any;
    const store = w.__muxbaseStores?.['providerStatus'] ?? w.useProviderStatusStore;
    if (store && typeof store.setState === 'function') {
      store.setState({ statuses, fetchedAt: Date.now() });
      return;
    }
    const dynamicStore = (Object.values(w) as any[]).find(
      (v) => v && typeof v === 'object' && typeof v.setState === 'function' && 'statuses' in (v.getState?.() ?? {}),
    );
    if (dynamicStore) dynamicStore.setState({ statuses, fetchedAt: Date.now() });
  }, { anthropic: ANTHROPIC_PROVIDER_STATUS, openai: OPENAI_PROVIDER_STATUS });
}

async function setView(page: Page, viewMode: ViewMode, focusPaneId?: string): Promise<void> {
  await page.evaluate(
    ({ mode, fid }) => {
      const stores = (window as any).__muxbaseStores;
      if (!stores?.ui) return;
      if (mode === 'focus' && fid) {
        stores.ui.setState({ activeView: 'dashboard', viewMode: 'focus', focusPaneId: fid, scrollToMessageId: null });
      } else if (mode === 'fleet') {
        stores.ui.setState({ activeView: 'dashboard', viewMode: 'fleet', focusPaneId: null, scrollToMessageId: null });
      } else {
        stores.ui.setState({ activeView: 'dashboard', viewMode: mode });
      }
    },
    { mode: viewMode, fid: focusPaneId ?? null },
  );
}

async function setSelectedPane(page: Page, paneId: string | null): Promise<void> {
  await page.evaluate((id) => {
    (window as any).__muxbaseStores?.pane?.setState?.({ selectedPaneId: id });
  }, paneId);
}

async function updatePaneStatus(page: Page, paneId: string, status: AgentStatus): Promise<void> {
  await page.evaluate(
    ({ id, status }) => {
      const stores = (window as any).__muxbaseStores;
      const state = stores?.pane?.getState?.();
      if (!state) return;
      const panes = state.panes.map((p: any) => (p.id === id ? { ...p, agentStatus: status } : p));
      stores.pane.setState({ panes });
    },
    { id: paneId, status },
  );
}

async function markPaneReady(page: Page, paneId: string): Promise<void> {
  await page.evaluate((id) => {
    const stores = (window as any).__muxbaseStores;
    const state = stores?.pane?.getState?.();
    if (!state) return;
    const next = new Set(state.justFinishedPaneIds ?? []);
    next.add(id);
    const panes = state.panes.map((p: any) => (p.id === id ? { ...p, agentStatus: 'idle' } : p));
    stores.pane.setState({ panes, justFinishedPaneIds: next });
  }, paneId);
}

// Measures the union bounding box of two selectors in identity (untransformed)
// space, mirroring camera()'s own string-target measurement technique — the
// body's cinema transform is stripped for the read, then restored — so the
// result is safe to pass back into camera() as an explicit rect target.
async function measureUnionRect(
  page: Page,
  selectorA: string,
  selectorB: string,
): Promise<{ x: number; y: number; width: number; height: number } | null> {
  return page.evaluate(
    ({ selectorA, selectorB }) => {
      const body = document.body;
      const prevTransition = body.style.transition;
      const prevTransform = body.style.transform;
      body.style.transition = 'none';
      body.style.transform = 'none';
      const a = document.querySelector(selectorA);
      const b = document.querySelector(selectorB);
      let rect: { x: number; y: number; width: number; height: number } | null = null;
      if (a && b) {
        const ra = a.getBoundingClientRect();
        const rb = b.getBoundingClientRect();
        const left = Math.min(ra.left, rb.left);
        const top = Math.min(ra.top, rb.top);
        const right = Math.max(ra.right, rb.right);
        const bottom = Math.max(ra.bottom, rb.bottom);
        rect = { x: left, y: top, width: right - left, height: bottom - top };
      }
      body.style.transform = prevTransform;
      body.style.transition = prevTransition;
      return rect;
    },
    { selectorA, selectorB },
  );
}

// Installs the staged fleet (4 panes, 4 statuses) and paints their terminals
// while the caller's boot cover is still up, gates on the real terminal boot/
// reconnect chrome being fully suppressed, then reveals. Shared by both cuts
// so the poster/title-card frame is always a genuinely live, clean fleet.
async function bootstrapAndReveal(page: Page): Promise<void> {
  await installDemoBootstrap(page);
  await setProviderHealth(page);
  await setView(page, 'fleet');
  await setSelectedPane(page, null);
  trace('bootstrap:pane-cell-wait:start');
  await page.locator('[data-testid="pane-cell"]').first().waitFor({ state: 'visible', timeout: 8_000 });
  trace('bootstrap:pane-cell-wait:done');
  await paintMockTerminals(page);
  trace('bootstrap:gate:start');
  await assertStagedTerminalsClean(page);
  trace('bootstrap:gate:done');
  await page.evaluate(() => {
    document.getElementById('__cinema_boot_cover')?.remove();
    document.getElementById('__cinema_blackout')?.remove();
  });
}

export interface CutResult {
  /** Date.now() at the instant the opening composition settles and its hold begins — the encoder's head-trim point. */
  revealEpochMs: number;
}

// ── HERO CUT (~17.3s, seamless loop, README autoplay) ──────────────────
export async function runHeroCut(page: Page): Promise<CutResult> {
  await bootstrapAndReveal(page);
  await showCursor(page);

  const posterOpts = { brand: 'MuxBase', tagline: 'The agentic IDE — mission control for your AI coding agents' };

  // Frame 1 — the poster. Fully-populated fleet, lockup on a scrim, held.
  await brand.showPosterLockup(page, posterOpts);
  await sleep(700); // let the lockup's entrance (cinema-card-in, 700ms) fully settle
  await sleep(450); // dim layer: 300ms ease + ~150ms buffer — stamp only once it's fully settled, so the trimmed first frame matches the outro's dim (loop-seam parity)
  // videoStartEpochMs is stamped after getAppWindow resolves, which is systematically
  // later than Playwright's true video t=0, so the encoder's computed trim
  // (reveal - videoStart) underestimates real elapsed time. This extra buffer keeps the
  // stamp comfortably past the dim settling even when that underestimate eats into it.
  await sleep(400);
  const revealEpochMs = Date.now();
  await sleep(1100); // truly static hold — encoder trims here; stays >=1000ms to absorb clock/video drift

  // Beat A — lockup fades, wide fleet streaming (~2s)
  await brand.hidePosterLockup(page);
  await sleep(1100);

  // Beat B — punch in on Claude's pane finishing (~3s)
  await markPaneReady(page, 'pane-auth');
  await camera(page, '[data-testid="pane-cell"]', { scale: 1.22, durationMs: 600 });
  await callout(page, {
    n: '01',
    title: 'One prompt → one isolated worktree.',
    body: 'Every pane gets its own branch, filesystem, and live terminal.',
    corner: 'bottom-right',
  });
  await sleep(1300);
  await hideCallout(page);
  await resetCamera(page, { durationMs: 400 });

  // Beat C — cut to Focus view: conversation + a diff glance (~3.5s)
  await clearMockTerminals(page);
  trace('hero:beatC:dissolve:start');
  await dissolve(page, async () => {
    await setView(page, 'focus', 'pane-auth');
    await setSelectedPane(page, 'pane-auth');
    trace('hero:beatC:terminal-wait:start');
    await page.locator('[data-testid="interactive-terminal"]').first()
      .waitFor({ state: 'visible', timeout: 5_000 }).catch(() => undefined);
    trace('hero:beatC:terminal-wait:done');
    await paintFleetTopBar(page);
    await paintMockTerminals(page); // repaint the now-standalone Focus terminal
    await paintFocusPanel(page, 'pane-auth');
  });
  trace('hero:beatC:gate:start');
  await assertStagedTerminalsClean(page);
  trace('hero:beatC:gate:done');
  await callout(page, {
    n: '02',
    title: 'See every layer.',
    body: 'Conversation, diff, tokens — the agent\'s work, opened.',
    corner: 'top-right',
  });
  await sleep(700);
  await setFocusPanelSection(page, 'diff');
  await sleep(1000);
  await hideCallout(page);

  // Beat D — review handoff climax (~4.5s). Punch the camera into the
  // popover+diff column so the diff card's natural (shorter-than-column)
  // height never leaves a void at the bottom of frame.
  await paintReviewPopover(page, 'codex');
  const reviewZoomRect = await measureUnionRect(page, '#__cinema_review_popover', '#__cinema_focus_body');
  if (reviewZoomRect) await camera(page, reviewZoomRect, { scale: 1.2, durationMs: 550 });
  await callout(page, {
    n: '03',
    title: 'Agents review each other.',
    body: 'Pick a different model to audit the diff — read-only, pinned to the SHA.',
    corner: 'bottom-left',
  });
  await clickSelector(page, '#__cinema_review_popover [data-segment="codex"]', { real: false });
  await sleep(180);
  await clickSelector(page, '#__cinema_start_review_btn', { real: false });
  await hideReviewPopover(page);
  await resetCamera(page, { durationMs: 400 });

  await dissolve(page, async () => {
    await paintReviewPaneSpawn(page);
  });
  // Punch into the transcript + findings columns together — both are
  // shorter than the pane's full height, so a tight zoom on their union
  // keeps the void below them out of frame.
  const reviewPaneZoomRect = await measureUnionRect(page, '#__cinema_review_transcript', '#__cinema_review_findings');
  if (reviewPaneZoomRect) await camera(page, reviewPaneZoomRect, { scale: 1.2, durationMs: 550 });
  await sleep(800);
  await resetCamera(page, { durationMs: 400 });

  await clickSelector(page, '#__cinema_send_fixes_btn', { real: false });
  await paintSendFixesDialog(page);
  await camera(page, '#__cinema_send_to_author_btn', { scale: 1.15, durationMs: 550 });
  await clickSelector(page, '#__cinema_send_to_author_btn', { real: false });
  await sleep(350);
  await hideCallout(page);
  await hideSendFixesDialog(page);
  await hideReviewPaneSpawn(page);
  await resetCamera(page, { durationMs: 450 });
  await hideCursor(page);

  // Outro — pull back to the exact poster composition (~2.5s), loop-seamless
  trace('hero:outro:dissolve:start');
  await dissolve(page, async () => {
    await setView(page, 'fleet');
    await setSelectedPane(page, null);
    await page.locator('[data-testid="pane-cell"]').first()
      .waitFor({ state: 'visible', timeout: 5_000 }).catch(() => undefined);
    await paintMockTerminals(page);
  });
  trace('hero:outro:gate:start');
  await assertStagedTerminalsClean(page);
  trace('hero:outro:gate:done');
  await brand.showPosterLockup(page, { ...posterOpts, github: 'github.com/muxbase-app/muxbase' });
  await sleep(1100);

  return { revealEpochMs };
}

// ── FULL CUT (~48-52s, 7-scene narrative) ──────────────────────────────
export async function runFullCut(page: Page): Promise<CutResult> {
  await bootstrapAndReveal(page);
  await showCursor(page);

  // Scene 1 — title over the live fleet
  await brand.showTitleCard(page, {
    brand: 'MuxBase',
    tagline: 'Claude · Codex · opencode — in parallel',
    sub: 'Run Claude Code, Codex, and opencode on the same repo — in parallel, in isolated git worktrees.',
  });
  await sleep(700); // let the title's entrance (cinema-card-in, 700ms) fully settle
  // videoStartEpochMs is stamped after getAppWindow resolves, which is systematically
  // later than Playwright's true video t=0, so the encoder's computed trim
  // (reveal - videoStart) underestimates real elapsed time. This extra buffer keeps the
  // stamp comfortably past the entrance settling even when that underestimate eats into it.
  await sleep(400);
  const revealEpochMs = Date.now();
  await sleep(1500); // truly static hold — encoder trims here; stays >=1000ms to absorb clock/video drift
  await brand.hideTitleCard(page);

  // Scene 2 — spawn a pane, typing reveal, camera punches into the prompt
  await clearMockTerminals(page);
  await showCreateDialogMockup(page);
  await sleep(360);
  await camera(page, '#__cinema_prompt_field', { scale: 1.16 });
  await typeIntoElement(
    page,
    '#__cinema_prompt_text',
    'Refactor auth flow to use the new token rotation strategy.',
    { msPerChar: 30, caret: true },
  );
  await callout(page, {
    n: '01',
    title: 'One prompt. One isolated worktree.',
    body: 'Every pane gets its own branch, filesystem, and live terminal.',
    corner: 'bottom-left',
  });
  await sleep(700);
  await resetCamera(page, { durationMs: 500 });
  await clickSelector(page, '#__cinema_launch_btn', { real: false });
  await sleep(260);
  await hideCallout(page);
  await hideCreateDialogMockup(page);

  // Scene 3 — fleet view, four agents in parallel
  await dissolve(page, async () => {
    await setView(page, 'fleet');
    await setSelectedPane(page, null);
    await updatePaneStatus(page, 'pane-auth', 'working');
    await updatePaneStatus(page, 'pane-perf', 'analyzing');
    await updatePaneStatus(page, 'pane-tests', 'waiting');
    await paintMockTerminals(page);
  });
  await assertStagedTerminalsClean(page);
  await callout(page, {
    n: '02',
    title: 'Many agents. One screen.',
    body: 'Four panes, four statuses — working, analyzing, waiting, review-ready.',
    corner: 'bottom-left',
  });
  const statusDot = page.locator('[data-testid="pane-cell"]').first().locator('[role="status"]').first();
  const dotBox = await statusDot.boundingBox().catch(() => null);
  if (dotBox) {
    await vignetteSpotlight(page, { x: dotBox.x + dotBox.width / 2, y: dotBox.y + dotBox.height / 2 });
    await sleep(1000);
    await vignetteSpotlightOff(page);
  }
  await markPaneReady(page, 'pane-docs');
  await sleep(500);
  await hideCallout(page);

  // Scene 4 — Focus view (Activity → Tokens tour) + provider health
  await clearMockTerminals(page);
  await dissolve(page, async () => {
    await setView(page, 'focus', 'pane-auth');
    await setSelectedPane(page, 'pane-auth');
    await updatePaneStatus(page, 'pane-auth', 'working');
    await page.locator('[data-testid="interactive-terminal"]').first()
      .waitFor({ state: 'visible', timeout: 5_000 }).catch(() => undefined);
    await paintFleetTopBar(page);
    await paintMockTerminals(page); // repaint the now-standalone Focus terminal
    await paintFocusPanel(page, 'pane-auth');
  });
  await assertStagedTerminalsClean(page);
  await callout(page, {
    n: '03',
    title: 'See every layer.',
    body: 'Activity · Diff · Tokens — the agent\'s mind, opened.',
    corner: 'top-right',
  });
  await sleep(700);
  for (const label of ['Activity', 'Tokens']) {
    const tab = page.locator(`[role="tab"]:has-text("${label}")`).first();
    await moveCursorToSelector(page, `[role="tab"]:has-text("${label}")`);
    const box = await tab.boundingBox().catch(() => null);
    if (box) await clickRipple(page, box.x + box.width / 2, box.y + box.height / 2);
    await tab.click({ force: true }).catch(() => undefined);
    await sleep(1000);
  }
  await hideCallout(page);
  await sleep(160);

  const tokensEl = page.locator('span').filter({ hasText: /[0-9]+(\.[0-9]+)?k\s+tokens/i }).first();
  const sparkBox = await tokensEl.boundingBox().catch(() => null);
  await callout(page, {
    n: '04',
    title: 'Catch a bad model day.',
    body: 'Live aistupidlevel benchmark per pane.',
    corner: 'top-left',
  });
  if (sparkBox) {
    await moveCursorTo(page, sparkBox.x + sparkBox.width / 2, sparkBox.y + sparkBox.height / 2);
    await showProviderHealthMockup(page, { x: Math.min(sparkBox.x, 1000), y: sparkBox.y + sparkBox.height + 8 });
  } else {
    await showProviderHealthMockup(page, { x: 980, y: 82 });
  }
  await sleep(180);
  await tickCounter(page, '#__cinema_bench_score', { from: 0, to: 55, duration: 700 });
  await sleep(800);
  await hideProviderHealthMockup(page);
  await hideCallout(page);

  // Scene 4b — file browser
  await dissolve(page, async () => {
    await paintFileBrowserPanel(page);
  });
  await callout(page, {
    n: '05',
    title: 'Browse the worktree. Open any file.',
    body: 'Every pane has its own isolated file tree — navigate, inspect, edit.',
    corner: 'top-right',
  });
  await sleep(600);
  await moveCursorToSelector(page, '#__cinema_filebrowser [data-file="rotate.ts"]').catch(() => undefined);
  await paintFileBrowserFileOpen(page);
  await sleep(1200);
  await hideCallout(page);
  await hideFileBrowserPanel(page);

  // Scene 5 — review handoff: Codex audits Claude
  await dissolve(page, async () => {
    await markPaneReady(page, 'pane-auth');
    await paintReviewPopover(page, 'codex');
  });
  await callout(page, {
    n: '06',
    title: 'Let one agent review another.',
    body: 'Pick a different model to audit the diff — read-only, pinned to the SHA.',
    corner: 'bottom-left',
  });
  await clickSelector(page, '#__cinema_review_popover [data-segment="codex"]', { real: false });
  await sleep(500);
  await camera(page, '#__cinema_start_review_btn', { scale: 1.18 });
  await clickSelector(page, '#__cinema_start_review_btn', { real: false });
  await sleep(500);
  await resetCamera(page, { durationMs: 450 });
  await hideReviewPopover(page);
  await hideCallout(page);

  await dissolve(page, async () => {
    await paintReviewPaneSpawn(page);
  });
  await callout(page, {
    n: '07',
    title: 'Codex audits Claude\'s diff.',
    body: 'Read-only, pinned to the SHA. Findings stream in as it works.',
    corner: 'bottom-right',
  });
  const fullReviewPaneZoomRect = await measureUnionRect(page, '#__cinema_review_transcript', '#__cinema_review_findings');
  if (fullReviewPaneZoomRect) await camera(page, fullReviewPaneZoomRect, { scale: 1.2 });
  await sleep(1500);
  await resetCamera(page, { durationMs: 450 });
  await camera(page, '#__cinema_send_fixes_btn', { scale: 1.15 });
  await clickSelector(page, '#__cinema_send_fixes_btn', { real: false });
  await sleep(500);
  await resetCamera(page, { durationMs: 450 });
  await hideCallout(page);

  await paintSendFixesDialog(page);
  await sleep(700);
  await camera(page, '#__cinema_send_to_author_btn', { scale: 1.15 });
  await clickSelector(page, '#__cinema_send_to_author_btn', { real: false });
  await sleep(600);
  await resetCamera(page, { durationMs: 450 });
  await hideSendFixesDialog(page);
  await hideReviewPaneSpawn(page);

  // Scene 6 — marketplace, six cards, fast staggered entrance
  await clearMockTerminals(page);
  await dissolve(page, async () => {
    await setView(page, 'fleet');
    await paintMarketplaceMockup(page);
  });
  await staggerChildren(page, '#__cinema_marketplace_grid', { offsetMs: 50, durationMs: 280 });
  await sleep(460);
  await callout(page, {
    n: '08',
    title: "Didn't want to build a reviewer? Install one.",
    body: 'Skills, MCP servers, and agents from the community — one click, all your panes.',
    corner: 'bottom-right',
  });
  await sleep(1600);
  await hideCallout(page);
  await hideMarketplaceMockup(page);

  // Scene 7 — outro
  await hideCursor(page);
  await brand.showOutroCard(page, {
    pills: ['Many agents in parallel', 'Isolated worktrees', 'Fleet · Focus · Files', 'Agent-to-agent review', 'Marketplace'],
    github: 'github.com/muxbase-app/muxbase',
  });
  await sleep(2600);
  await brand.hideOutroCard(page);

  return { revealEpochMs };
}
