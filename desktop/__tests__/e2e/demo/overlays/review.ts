import type { Page } from 'playwright';
import { measureContentLeft, measureIdentityRect } from './layout';

const POPOVER_WIDTH = 264;
const POPOVER_GAP = 6;

export async function paintReviewPopover(page: Page, selectedAgent: 'claude' | 'codex' | 'opencode' = 'codex'): Promise<void> {
  // Mirrors the real ReviewLaunchButton: an AnchoredMenu hung under the header
  // trigger, right-aligned to it. Anchoring to the trigger is what makes the
  // card read as a popover rather than a panel floating over the content.
  const trigger = await measureIdentityRect(page, '#__cinema_review_trigger');
  await page.evaluate(({ selected, anchor, width, gap }) => {
    const old = document.getElementById('__cinema_review_popover');
    if (old) old.remove();

    const left = anchor
      ? Math.max(gap, anchor.x + anchor.width - width)
      : Math.max(gap, window.innerWidth - width - 40);
    const top = anchor ? anchor.y + anchor.height + gap : 96;

    const wrap = document.createElement('div');
    wrap.id = '__cinema_review_popover';
    wrap.style.cssText = `
      position:fixed;left:${left}px;top:${top}px;z-index:99999;pointer-events:none;
      width:${width}px;padding:14px;border-radius:14px;
      background:#14151c;
      border:1px solid rgba(255,255,255,0.10);
      box-shadow:0 16px 50px -12px rgba(0,0,0,0.7), inset 0 1px 0 rgba(255,255,255,0.06);
      font-family:'Inter',-apple-system,sans-serif;color:#e6edf3;
      animation:cinema-card-in 360ms cubic-bezier(0.16,1,0.3,1) both;
    `;

    const seg = (key: string, label: string, iconColor: string, iconSvg: string, isSel: boolean) => `
      <button data-segment="${key}" style="flex:1;display:flex;flex-direction:column;align-items:center;gap:5px;padding:9px 4px;border-radius:8px;border:none;background:${isSel ? '#0d0d10' : 'transparent'};color:${isSel ? '#fff' : '#8b949e'};font-family:inherit;font-size:10.5px;font-weight:600;${isSel ? 'box-shadow:0 1px 3px rgba(0,0,0,0.4), 0 0 0 1px rgba(255,255,255,0.10);' : ''}">
        <span style="color:${iconColor};display:inline-flex;">${iconSvg}</span>
        ${label}
      </button>
    `;

    wrap.innerHTML = `
      <div style="font-size:10px;letter-spacing:0.16em;color:#6b7280;font-weight:700;text-transform:uppercase;margin-bottom:10px;display:flex;align-items:center;gap:6px;">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none"><g stroke="#6b7280" stroke-width="1.8" opacity="0.7"><circle cx="10" cy="10" r="6"/><line x1="14.5" y1="14.5" x2="20" y2="20" stroke-linecap="round"/></g><polyline points="7.5 10.5 9.5 12.5 12.5 8.5" stroke="#58a6ff" stroke-width="2.3" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>
        Review with
      </div>

      <div style="display:flex;gap:4px;padding:4px;border-radius:11px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.06);">
        ${seg('claude', 'Claude', '#f59e0b', '<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l8 18-8-6-8 6 8-18z"/></svg>', selected === 'claude')}
        ${seg('codex', 'Codex', '#10b981', '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="9" ry="3.5"/></svg>', selected === 'codex')}
        ${seg('opencode', 'OpenCode', '#6366f1', '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="8 6 2 12 8 18"/><polyline points="16 6 22 12 16 18"/></svg>', selected === 'opencode')}
      </div>

      <div style="margin-top:10px;font-size:10px;color:#6b7280;line-height:1.5;">
        Spawns a read-only pane pinned to <span style="color:#cbd5e1;font-family:'SFMono-Regular',Menlo,monospace;">${selected === 'claude' ? 'Claude' : selected === 'codex' ? 'Codex' : 'OpenCode'}</span> on this branch's SHA.
      </div>

      <button id="__cinema_start_review_btn" style="margin-top:11px;width:100%;height:36px;border-radius:10px;border:none;background:#58a6ff;color:#03070d;font-family:inherit;font-size:13px;font-weight:650;box-shadow:0 0 22px -6px rgba(88,166,255,0.55);">
        Start Review
      </button>
    `;
    document.body.appendChild(wrap);
  }, {
    anchor: trigger, gap: POPOVER_GAP, selected: selectedAgent, width: POPOVER_WIDTH,
  });
}

export async function hideReviewPopover(page: Page): Promise<void> {
  await page.evaluate(() => {
    const el = document.getElementById('__cinema_review_popover');
    if (el) el.remove();
  });
}

// The real review pane is a normal pane with `role === 'review'`. The only
// chrome differences vs a regular pane are a "Review" outline badge next to
// the title and a "Send fixes" button in the header right-cluster. Findings
// stream in the codex agent's own terminal output; the findings LIST only
// appears in the SendFixesConfirmDialog. We mirror both here.
export async function paintReviewPaneSpawn(page: Page): Promise<void> {
  const contentLeft = await measureContentLeft(page);
  await page.evaluate((left) => {
    document.getElementById('__cinema_focus_panel')?.remove();
    document.getElementById('__cinema_review_pane')?.remove();

    const overlay = document.createElement('div');
    overlay.id = '__cinema_review_pane';
    overlay.style.cssText = `
      position:fixed;left:${left}px;top:0;right:0;bottom:0;z-index:50;pointer-events:none;
      background:#06070b;
      font-family:'Inter',-apple-system,sans-serif;color:#e6edf3;
      overflow:hidden;
      animation:cinema-fade-in 320ms cubic-bezier(0.22,1,0.36,1) both;
    `;

    const header = `
      <div style="display:flex;align-items:center;gap:8px;padding:10px 16px;border-bottom:1px solid rgba(255,255,255,0.06);background:#0a0b0e;height:42px;box-sizing:border-box;">
        <span style="display:inline-flex;align-items:center;gap:6px;color:#9aa0aa;font-size:11px;">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 18 9 12 15 6"/></svg>
          Fleet
        </span>
        <span style="display:inline-flex;align-items:center;gap:6px;margin-left:6px;">
          <span style="width:18px;height:18px;border-radius:5px;background:rgba(16,185,129,0.18);color:#10b981;display:inline-flex;align-items:center;justify-content:center;">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="9" ry="3.5"/></svg>
          </span>
          <span style="width:8px;height:8px;border-radius:50%;background:#34d399;box-shadow:0 0 8px #34d399aa;"></span>
          <span style="font-size:12px;font-weight:500;color:#e6edf3;">review-refactor-auth</span>
        </span>
        <span id="__cinema_review_badge" style="
          display:inline-flex;align-items:center;padding:1px 7px;border-radius:999px;
          border:1px solid rgba(88,166,255,0.42);color:#58a6ff;
          font-size:10px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;margin-left:2px;
        ">Review</span>
        <div style="margin-left:auto;display:flex;align-items:center;gap:6px;">
          <button id="__cinema_send_fixes_btn" style="
            display:inline-flex;align-items:center;gap:5px;height:24px;padding:0 7px;border-radius:5px;
            background:rgba(88,166,255,0.10);color:#58a6ff;
            border:none;font-family:inherit;font-size:11px;font-weight:500;cursor:default;
            box-shadow:0 0 0 1px rgba(88,166,255,0.40) inset;
          ">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
            Send fixes
          </button>
          <span style="display:inline-flex;align-items:center;gap:5px;padding:3px 9px;border-radius:999px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);font-size:11px;color:#9aa0aa;font-family:'SFMono-Regular',Menlo,monospace;">
            aurora-engine
          </span>
        </div>
      </div>
    `;

    const body = `
      <div style="display:flex;height:calc(100% - 42px);">
        <div id="__cinema_review_transcript" style="flex:1;min-width:0;background:linear-gradient(180deg, rgba(0,0,0,0.97) 0%, rgba(6,7,11,0.99) 100%), rgba(16,185,129,0.04);padding:16px 18px;font-family:'SFMono-Regular',Menlo,Monaco,monospace;font-size:12px;line-height:1.55;color:#cbd5e1;overflow:hidden;">
          <div style="display:flex;align-items:center;gap:10px;padding-bottom:8px;margin-bottom:8px;border-bottom:1px solid rgba(255,255,255,0.06);">
            <span style="width:10px;height:10px;border-radius:50%;background:#10b981;box-shadow:0 0 10px #10b981aa;"></span>
            <span style="color:#10b981;font-weight:600;font-size:11px;letter-spacing:0.04em;">Codex · gpt-5-codex</span>
            <span style="margin-left:auto;color:#52535a;font-size:10px;letter-spacing:0.06em;">read-only · pinned to 3a7c1e2</span>
          </div>
          <div style="color:#7c7c87;">── reviewing diff: refactor-auth-flow ──────────────</div>
          <div style="color:#7c7c87;">cwd: ~/aurora-engine · base: main · changed: 3 files (+172 −27)</div>
          <div style="color:#cbd5e1;margin-top:6px;">› Audit Claude's diff. Flag correctness issues only.</div>
          <div style="color:#e6edf3;margin-top:6px;">Scanning the diff across src/auth/{rotate,index}.ts and the new test suite.</div>
          <div style="color:#7DD3FC;">⏺ read_file  src/auth/rotate.ts                  (74 lines)</div>
          <div style="color:#7DD3FC;">⏺ read_file  src/auth/__tests__/rotate.test.ts   (118 lines)</div>
          <div style="color:#e6edf3;margin-top:4px;">Three findings — one critical, one warning, one nit.</div>
          <div id="__cinema_finding_critical" style="color:#f85149;margin-top:8px;">[critical] rotate.ts:24 — race condition</div>
          <div style="color:#cbd5e1;padding-left:14px;">Two concurrent rotate() callers can both pass !prev.isExpired()</div>
          <div style="color:#cbd5e1;padding-left:14px;">before either calls store.replace. Wrap in single-flight or use</div>
          <div style="color:#cbd5e1;padding-left:14px;">the store's atomic CAS.</div>
          <div style="color:#d29922;margin-top:8px;">[warning] rotate.test.ts — replay test asserts only happy path</div>
          <div style="color:#cbd5e1;padding-left:14px;">Add a negative case: reusing the same token after rotate() should</div>
          <div style="color:#cbd5e1;padding-left:14px;">be rejected.</div>
          <div style="color:#5eead4;margin-top:8px;">[nit] index.ts:9 — export the new Token type</div>
          <div style="color:#cbd5e1;padding-left:14px;">Consumers will want it; currently internal-only.</div>
          <div style="color:#5eead4;margin-top:10px;">✓ review complete · 3 findings · ready to hand off</div>
          <div style="margin-top:10px;display:flex;align-items:center;gap:8px;">
            <span style="color:#10b981;font-weight:700;">›</span>
            <span style="color:#7c7c87;">_</span>
            <span style="width:8px;height:14px;background:#10b981;animation:cinema-cursor-pulse 1.1s ease-in-out infinite;display:inline-block;vertical-align:-2px;"></span>
          </div>
        </div>

        <div style="width:38%;min-width:380px;background:#06070b;border-left:1px solid rgba(255,255,255,0.06);display:flex;flex-direction:column;">
          <div style="display:flex;align-items:center;border-bottom:1px solid rgba(255,255,255,0.06);background:#0a0b0e;">
            ${['Agent', 'Diff', 'Activity', 'Tokens', 'Worktree'].map((label, i) => `
              <button style="padding:11px 14px;font-size:11.5px;color:${i === 2 ? '#fff' : '#9aa0aa'};border-bottom:2px solid ${i === 2 ? '#58a6ff' : 'transparent'};background:none;border-left:none;border-right:none;border-top:none;cursor:default;font-family:inherit;font-weight:${i === 2 ? 600 : 400};">${label}</button>
            `).join('')}
          </div>
          <div id="__cinema_review_findings" style="flex:1;padding:18px 18px;overflow:hidden;">
            <div style="font-size:10px;letter-spacing:0.18em;color:#6b7280;font-weight:700;text-transform:uppercase;margin-bottom:6px;">Activity</div>
            <div style="font-size:18px;font-weight:700;letter-spacing:-0.01em;margin-bottom:18px;">3 findings · 2 files read</div>
            <div style="display:flex;flex-direction:column;gap:10px;">
              <div style="display:flex;align-items:center;gap:10px;padding:9px 11px;border:1px solid rgba(248,81,73,0.22);border-radius:9px;background:#0a0b0e;">
                <span style="width:16px;height:16px;border-radius:4px;background:rgba(248,81,73,0.18);color:#f85149;font-size:10px;font-weight:700;display:inline-flex;align-items:center;justify-content:center;">!</span>
                <div style="font-family:'SFMono-Regular',Menlo,monospace;font-size:11.5px;color:#e6edf3;flex:1;min-width:0;">rotate.ts:24</div>
                <span style="font-size:10px;color:#f85149;font-weight:700;letter-spacing:0.06em;">CRITICAL</span>
              </div>
              <div style="display:flex;align-items:center;gap:10px;padding:9px 11px;border:1px solid rgba(210,153,34,0.22);border-radius:9px;background:#0a0b0e;">
                <span style="width:16px;height:16px;border-radius:4px;background:rgba(210,153,34,0.18);color:#d29922;font-size:10px;font-weight:700;display:inline-flex;align-items:center;justify-content:center;">⚠</span>
                <div style="font-family:'SFMono-Regular',Menlo,monospace;font-size:11.5px;color:#e6edf3;flex:1;min-width:0;">rotate.test.ts</div>
                <span style="font-size:10px;color:#d29922;font-weight:700;letter-spacing:0.06em;">WARNING</span>
              </div>
              <div style="display:flex;align-items:center;gap:10px;padding:9px 11px;border:1px solid rgba(94,234,212,0.20);border-radius:9px;background:#0a0b0e;">
                <span style="width:16px;height:16px;border-radius:4px;background:rgba(94,234,212,0.18);color:#5eead4;font-size:10px;font-weight:700;display:inline-flex;align-items:center;justify-content:center;">ℹ</span>
                <div style="font-family:'SFMono-Regular',Menlo,monospace;font-size:11.5px;color:#e6edf3;flex:1;min-width:0;">index.ts:9</div>
                <span style="font-size:10px;color:#5eead4;font-weight:700;letter-spacing:0.06em;">NIT</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    `;

    overlay.innerHTML = header + body;
    document.body.appendChild(overlay);
  }, contentLeft);
}

export async function hideReviewPaneSpawn(page: Page): Promise<void> {
  await page.evaluate(() => {
    const el = document.getElementById('__cinema_review_pane');
    if (el) el.remove();
  });
}

// Mirrors the real SendFixesConfirmDialog.tsx: a max-w-2xl modal with header
// (title + close X), intro paragraph, plain pre-formatted findings text,
// footer (Cancel + Send to author with paper-plane icon).
export async function paintSendFixesDialog(page: Page): Promise<void> {
  await page.evaluate(() => {
    document.getElementById('__cinema_send_fixes')?.remove();

    const wrap = document.createElement('div');
    wrap.id = '__cinema_send_fixes';
    wrap.style.cssText = `
      position:fixed;inset:0;z-index:99999;pointer-events:none;
      display:flex;align-items:flex-start;justify-content:center;padding-top:10vh;
      background:rgba(0,0,0,0.5);
      -webkit-backdrop-filter:blur(4px);
      backdrop-filter:blur(4px);
      animation:cinema-fade-in 240ms ease both;
    `;

    wrap.innerHTML = `
      <div style="width:100%;max-width:42rem;margin:0 16px;border-radius:12px;
        border:1px solid rgba(255,255,255,0.08);
        background:#0d0d10;
        box-shadow:0 25px 50px -12px rgba(0,0,0,0.65);
        font-family:'Inter',-apple-system,sans-serif;color:#e6edf3;
        overflow:hidden;display:flex;flex-direction:column;max-height:80vh;
        animation:cinema-rise-in 320ms cubic-bezier(0.22,1,0.36,1) both;
      ">
        <div style="display:flex;align-items:center;gap:8px;padding:10px 16px;border-bottom:1px solid rgba(255,255,255,0.08);flex-shrink:0;">
          <span style="font-size:13px;font-weight:600;color:#e6edf3;flex:1;">
            Send review findings to <span style="font-family:'SFMono-Regular',Menlo,monospace;color:#58a6ff;">refactor-auth-flow</span>
          </span>
          <span style="padding:4px;border-radius:4px;color:#9aa0aa;display:inline-flex;">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg>
          </span>
        </div>

        <div style="padding:10px 16px;border-bottom:1px solid rgba(255,255,255,0.08);font-size:11.5px;color:#9aa0aa;line-height:1.5;flex-shrink:0;">
          The author's agent will read these findings and may start editing files. Review what will be sent before confirming.
        </div>

        <div style="flex:1;min-height:0;overflow-y:auto;padding:10px 16px;">
          <p style="font-size:11px;text-transform:uppercase;letter-spacing:0.04em;font-weight:600;color:#9aa0aa;margin:0 0 8px 0;">Findings from codex</p>
          <pre style="
            margin:0;padding:8px 12px;border-radius:6px;
            border:1px solid rgba(255,255,255,0.08);background:#06070b;
            font-family:'SFMono-Regular',Menlo,monospace;font-size:11px;line-height:1.55;color:#cbd5e1;
            white-space:pre-wrap;word-wrap:break-word;
            max-height:50vh;overflow-y:auto;
          ">[critical] src/auth/rotate.ts:24 — race condition in token replacement
Two concurrent rotate() callers can both pass the !prev.isExpired()
check before either calls store.replace. Wrap in a single-flight or
use the store's atomic CAS.

[warning] src/auth/__tests__/rotate.test.ts — replay test asserts only the happy path
Add a negative case that reuses the same token after rotate() and
expects rejection.

[nit] src/auth/index.ts:9 — export the new Token type
Consumers will likely want the type — currently it's internal-only.</pre>
        </div>

        <div style="display:flex;align-items:center;justify-content:flex-end;gap:8px;padding:10px 16px;border-top:1px solid rgba(255,255,255,0.08);background:#08090c;flex-shrink:0;">
          <div style="padding:6px 12px;border-radius:6px;border:1px solid rgba(255,255,255,0.08);font-size:12px;color:#e6edf3;">Cancel</div>
          <div id="__cinema_send_to_author_btn" style="
            padding:6px 12px;border-radius:6px;background:#58a6ff;color:#03070d;
            font-size:12px;font-weight:600;display:inline-flex;align-items:center;gap:5px;
          ">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
            Send to author
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(wrap);
  });
}

export async function hideSendFixesDialog(page: Page): Promise<void> {
  await page.evaluate(() => {
    const el = document.getElementById('__cinema_send_fixes');
    if (el) el.remove();
  });
}
