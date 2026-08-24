import type { Page } from 'playwright';
import { MOCK_TERMINALS } from '../fixtures';

// The real InteractiveTerminal root (`[data-testid="interactive-terminal"]`)
// is the one stable anchor for both the fleet grid (nested inside a
// pane-cell) and Focus view (standalone) — it is `position:relative` and
// carries `data-pane-id`. Its own real chrome, the boot spinner and the
// "Reconnecting terminal" toast (`[data-testid="terminal-failure-card"]`,
// z-index 30), lives directly inside it. A prior revision targeted a
// `.bg-black` terminal-background class that no longer exists in the app
// (the terminal background moved to an inline style), so nothing ever
// painted and the real boot/reconnect chrome showed through uncovered.
// Painting straight into this root, above z-index 30, fixes both issues.
const OVERLAY_Z_INDEX = 40;

export async function paintMockTerminals(page: Page): Promise<void> {
  await page.evaluate(
    ({ mockData, zIndex }) => {
      const COLORS: Record<string, string> = {
        system: '#7c7c87',
        user: '#cbd5e1',
        assistant: '#e6edf3',
        tool: '#7DD3FC',
        output: '#5eead4',
        status: '#a78bfa',
      };
      const AGENT_TINT: Record<string, string> = {
        claude: 'rgba(139,92,246,0.04)',
        codex: 'rgba(245,158,11,0.04)',
        opencode: 'rgba(125,211,252,0.04)',
      };
      const AGENT_ACCENT: Record<string, string> = {
        claude: '#A78BFA',
        codex: '#FBBF24',
        opencode: '#7DD3FC',
      };

      function paintInto(host: HTMLElement, mock: any): void {
        let overlay = host.querySelector(':scope > .__cinema_terminal_overlay') as HTMLElement | null;
        if (overlay) overlay.remove();

        overlay = document.createElement('div');
        overlay.className = '__cinema_terminal_overlay';
        overlay.style.cssText = `
          position:absolute;inset:0;z-index:${zIndex};pointer-events:none;
          background:linear-gradient(180deg, rgba(0,0,0,0.97) 0%, rgba(6,7,11,0.99) 100%), ${AGENT_TINT[mock.agent]};
          padding:16px 18px;
          font-family:'SFMono-Regular',Menlo,Monaco,'Google Sans Code',monospace;
          font-size:12px;line-height:1.55;color:#cbd5e1;
          overflow:hidden;
          animation:cinema-fade-in 400ms ease both;
        `;

        const header = `
          <div style="display:flex;align-items:center;gap:10px;padding-bottom:8px;margin-bottom:8px;border-bottom:1px solid rgba(255,255,255,0.06);">
            <span style="width:10px;height:10px;border-radius:50%;background:${AGENT_ACCENT[mock.agent]};box-shadow:0 0 10px ${AGENT_ACCENT[mock.agent]}aa;"></span>
            <span style="color:${AGENT_ACCENT[mock.agent]};font-weight:600;font-size:11px;letter-spacing:0.04em;">${mock.agentLabel}</span>
            <span style="margin-left:auto;color:#52535a;font-size:10px;letter-spacing:0.06em;">pts/0</span>
          </div>
        `;

        const lines = mock.lines.map((line: any) => {
          const c = COLORS[line.kind] ?? '#cbd5e1';
          const text = String(line.text).replace(/</g, '&lt;').replace(/>/g, '&gt;');
          return `<div style="color:${c};white-space:pre;overflow:hidden;text-overflow:ellipsis;">${text}</div>`;
        }).join('');

        const prompt = `
          <div style="margin-top:10px;display:flex;align-items:center;gap:8px;">
            <span style="color:${AGENT_ACCENT[mock.agent]};font-weight:700;">›</span>
            <span style="color:#7c7c87;">_</span>
            <span style="width:8px;height:14px;background:${AGENT_ACCENT[mock.agent]};animation:cinema-cursor-pulse 1.1s ease-in-out infinite;display:inline-block;vertical-align:-2px;"></span>
          </div>
        `;

        overlay.innerHTML = header + lines + prompt;
        host.appendChild(overlay);
      }

      // Single pass: every InteractiveTerminal root, fleet-nested or
      // standalone in Focus view, keyed by its own data-pane-id — no
      // positional guessing, so DOM order never matters.
      const hosts = Array.from(document.querySelectorAll('[data-testid="interactive-terminal"]'));
      hosts.forEach((host) => {
        const paneId = (host as HTMLElement).dataset.paneId;
        const mock = paneId ? (mockData as any)[paneId] : undefined;
        if (!mock) return;
        paintInto(host as HTMLElement, mock);
      });
    },
    { mockData: MOCK_TERMINALS, zIndex: OVERLAY_Z_INDEX },
  );
}

export async function clearMockTerminals(page: Page): Promise<void> {
  await page.evaluate(() => {
    document.querySelectorAll('.__cinema_terminal_overlay').forEach((e) => e.remove());
  });
}

interface StagingGateSummary {
  hostsTotal: number;
  hostsMissingOverlay: string[];
  visibleBootSpinners: string[];
  visibleFailureCards: string[];
}

interface CinemaStagingWindow {
  __cinemaComputeStagingStatus?: () => StagingGateSummary;
}

// `terminal-boot-overlay`/`terminal-failure-card` stay CSS-visible (nonzero
// size, opacity-100) in the real DOM for as long as the fake pane's attach
// keeps retrying — that never resolves for staged panes. They are only
// truly invisible to the camera once our overlay (z-index 40, `inset:0`,
// appended into the very same `[data-testid="interactive-terminal"]` host)
// is present, which by construction always paints above them. Naive
// geometry/opacity checks alone would false-positive on chrome that is
// actually fully covered — `elementFromPoint` can't help either, since both
// layers are `pointer-events:none`. So "suppressed" = host has the overlay.
//
// Both the staging gate's poll predicate and its failure summarizer need
// this exact classification, but they run as two independently-serialized
// page.evaluate()/waitForFunction() callbacks — Playwright can't share a
// Node-side closure between them. So the computation is installed once on
// `window`, idempotently, and both call sites invoke that single instance.
async function ensureStagingStatusFn(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as CinemaStagingWindow;
    if (w.__cinemaComputeStagingStatus) return;
    w.__cinemaComputeStagingStatus = (): StagingGateSummary => {
      const isCssVisible = (el: Element | null): boolean => {
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return false;
        const style = window.getComputedStyle(el);
        return style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) > 0.05;
      };
      const isSuppressed = (el: Element): boolean => {
        const host = el.closest('[data-testid="interactive-terminal"]');
        return !!host && !!host.querySelector(':scope > .__cinema_terminal_overlay');
      };
      const paneIdOf = (el: Element) => (el.closest('[data-testid="interactive-terminal"]') as HTMLElement | null)?.dataset.paneId
        ?? (el as HTMLElement).dataset.paneId
        ?? '(unknown pane)';

      const hosts = Array.from(document.querySelectorAll('[data-testid="interactive-terminal"]'));
      const hostsMissingOverlay = hosts.filter((h) => isCssVisible(h) && !isSuppressed(h)).map(paneIdOf);
      const visibleBootSpinners = Array.from(document.querySelectorAll('[data-testid="terminal-boot-overlay"]'))
        .filter((el) => el.getAttribute('data-booting') === 'true' && isCssVisible(el) && !isSuppressed(el))
        .map(paneIdOf);
      const visibleFailureCards = Array.from(document.querySelectorAll('[data-testid="terminal-failure-card"]'))
        .filter((el) => isCssVisible(el) && !isSuppressed(el))
        .map(paneIdOf);

      return {
        hostsTotal: hosts.length, hostsMissingOverlay, visibleBootSpinners, visibleFailureCards,
      };
    };
  });
}

async function summarizeStaging(page: Page): Promise<StagingGateSummary> {
  await ensureStagingStatusFn(page);
  return page.evaluate(() => (window as unknown as CinemaStagingWindow).__cinemaComputeStagingStatus!());
}

// Staging gate: every visible staged terminal must be covered by the mock
// overlay, and zero real boot-spinner/reconnecting-toast chrome may still be
// showing through. Throws (failing the test, never the recording) on
// timeout, with a DOM summary of exactly what's still visible plus the
// underlying wait error (a genuine page crash reads very differently from a
// plain timeout, so that distinction must survive into the thrown message).
export async function assertStagedTerminalsClean(page: Page, timeoutMs = 5_000): Promise<void> {
  await ensureStagingStatusFn(page);
  try {
    await page.waitForFunction(() => {
      const status = (window as unknown as CinemaStagingWindow).__cinemaComputeStagingStatus!();
      return status.hostsMissingOverlay.length === 0
        && status.visibleBootSpinners.length === 0
        && status.visibleFailureCards.length === 0;
    }, undefined, { timeout: timeoutMs });
  } catch (error) {
    const summary = await summarizeStaging(page);
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Staging gate failed — real terminal chrome is visible.\n${JSON.stringify(summary, null, 2)}\n\nUnderlying error: ${reason}`,
    );
  }
}
