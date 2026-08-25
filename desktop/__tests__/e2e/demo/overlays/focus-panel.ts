import type { Page } from 'playwright';
import { MOCK_TERMINALS } from '../fixtures';

export async function paintFocusPanel(page: Page, mockId: string): Promise<void> {
  const mock = MOCK_TERMINALS[mockId];
  if (!mock) return;
  await page.evaluate((mockArg) => {
    const mock = mockArg as any;

    let overlay = document.getElementById('__cinema_focus_panel');
    if (overlay) overlay.remove();

    overlay = document.createElement('div');
    overlay.id = '__cinema_focus_panel';
    overlay.style.cssText = `
      position:fixed;right:0;top:54px;width:760px;bottom:0;z-index:50;pointer-events:none;
      background:#06070b;
      border-left:1px solid rgba(255,255,255,0.06);
      box-shadow:-20px 0 60px rgba(0,0,0,0.6);
      padding:0;overflow:hidden;
      font-family:'Inter',-apple-system,sans-serif;color:#e6edf3;
      animation:cinema-fade-in 400ms ease both;
    `;

    overlay.innerHTML = `
      <div style="display:flex;align-items:center;border-bottom:1px solid rgba(255,255,255,0.06);background:#0d0d10;">
        <div style="display:flex;flex:1;">
          <button data-tab="agent" style="padding:11px 16px;font-size:12px;color:#9aa0aa;border-bottom:2px solid transparent;background:none;border-left:none;border-right:none;border-top:none;cursor:default;font-family:inherit;">Agent</button>
          <button data-tab="diff" style="padding:11px 16px;font-size:12px;color:#9aa0aa;border-bottom:2px solid transparent;background:none;border-left:none;border-right:none;border-top:none;cursor:default;font-family:inherit;">Diff</button>
          <button data-tab="activity" style="padding:11px 16px;font-size:12px;color:#fff;border-bottom:2px solid #58a6ff;background:none;border-left:none;border-right:none;border-top:none;cursor:default;font-family:inherit;font-weight:600;">Activity</button>
          <button data-tab="tokens" style="padding:11px 16px;font-size:12px;color:#9aa0aa;border-bottom:2px solid transparent;background:none;border-left:none;border-right:none;border-top:none;cursor:default;font-family:inherit;">Tokens</button>
          <button data-tab="worktree" style="padding:11px 16px;font-size:12px;color:#9aa0aa;border-bottom:2px solid transparent;background:none;border-left:none;border-right:none;border-top:none;cursor:default;font-family:inherit;">Worktree</button>
        </div>
        <button id="__cinema_review_trigger" aria-label="Start review" style="display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;margin-right:6px;border-radius:6px;border:none;background:none;color:#9aa0aa;cursor:default;">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none"><g stroke="currentColor" stroke-width="1.8" opacity="0.85"><circle cx="10" cy="10" r="6"/><line x1="14.5" y1="14.5" x2="20" y2="20" stroke-linecap="round"/></g><polyline points="7.5 10.5 9.5 12.5 12.5 8.5" stroke="#58a6ff" stroke-width="2.3" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
        <div style="display:inline-flex;align-items:center;gap:8px;margin-right:12px;padding:4px 10px;border-radius:999px;background:#15161b;border:1px solid #21222a;">
          <svg width="36" height="14" viewBox="0 0 36 14" fill="none"><polyline points="0,8 6,7 12,9 18,6 24,9 30,5 36,7" stroke="#fbbf24" stroke-width="1.5" fill="none" /></svg>
          <span style="font-size:10px;font-weight:700;color:#fbbf24;font-family:'SFMono-Regular',Menlo,monospace;">55</span>
        </div>
      </div>

      <div id="__cinema_focus_body" style="padding:22px 24px;overflow:hidden;">
        <div data-section="activity" style="display:block;">
          <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:18px;">
            <div>
              <div style="font-size:10px;letter-spacing:0.18em;color:#6b7280;font-weight:700;text-transform:uppercase;margin-bottom:4px;">Activity</div>
              <div style="font-size:18px;font-weight:700;letter-spacing:-0.01em;">${mock.lines.length} events · 6 tool calls</div>
            </div>
            <div style="display:flex;gap:14px;font-size:11px;color:#9aa0aa;">
              <div><span style="color:#5eead4;">●</span> Read</div>
              <div><span style="color:#a78bfa;">●</span> Edit</div>
              <div><span style="color:#fbbf24;">●</span> Bash</div>
            </div>
          </div>

          <div style="display:flex;flex-direction:column;gap:10px;">
            ${[
              { tool: 'Read', file: 'src/auth/index.ts', meta: '412 lines', accent: '#5eead4' },
              { tool: 'Grep', file: 'pattern: "rotate|refresh"', meta: '8 hits in src/auth', accent: '#5eead4' },
              { tool: 'Edit', file: 'src/auth/rotate.ts', meta: '+42 −18', accent: '#a78bfa' },
              { tool: 'Edit', file: 'src/auth/index.ts', meta: '+12 −9', accent: '#a78bfa' },
              { tool: 'Write', file: 'src/auth/__tests__/rotate.test.ts', meta: '+118', accent: '#a78bfa' },
              { tool: 'Bash', file: 'pnpm test src/auth', meta: '14 passed · 1.42s', accent: '#fbbf24' },
            ].map((row) => `
              <div style="display:flex;align-items:center;gap:12px;padding:10px 12px;border:1px solid rgba(255,255,255,0.05);border-radius:10px;background:rgba(13,13,16,0.6);">
                <span style="display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;border-radius:7px;background:${row.accent}22;color:${row.accent};font-size:10px;font-weight:700;letter-spacing:0.04em;">${row.tool}</span>
                <div style="flex:1;min-width:0;">
                  <div style="font-family:'SFMono-Regular',Menlo,monospace;font-size:12px;color:#e6edf3;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${row.file}</div>
                  <div style="font-size:11px;color:#7c7c87;margin-top:2px;">${row.meta}</div>
                </div>
                <span style="color:#34d399;font-size:13px;">✓</span>
              </div>
            `).join('')}
          </div>

          <div style="margin-top:22px;padding:14px 16px;border:1px solid rgba(88,166,255,0.18);border-radius:12px;background:linear-gradient(135deg, rgba(88,166,255,0.06), rgba(167,139,250,0.06));">
            <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px;">
              <span style="width:8px;height:8px;border-radius:50%;background:#58a6ff;box-shadow:0 0 12px #58a6ff88;"></span>
              <span style="font-size:11px;letter-spacing:0.14em;color:#9aa0aa;font-weight:700;text-transform:uppercase;">Final message</span>
            </div>
            <div style="font-size:13px;line-height:1.6;color:#cbd5e1;">All 14 tests pass. Tokens rotate on every request now and the suite covers expiry, replay, and revoke paths. Ready for review.</div>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
  }, mock);
}

export async function setFocusPanelSection(page: Page, section: 'agent' | 'diff' | 'activity' | 'tokens' | 'worktree'): Promise<void> {
  await page.evaluate((s) => {
    const panel = document.getElementById('__cinema_focus_panel');
    if (!panel) return;

    panel.querySelectorAll('button[data-tab]').forEach((b) => {
      const el = b as HTMLButtonElement;
      const active = el.dataset.tab === s;
      el.style.color = active ? '#fff' : '#9aa0aa';
      el.style.borderBottom = active ? '2px solid #58a6ff' : '2px solid transparent';
      el.style.fontWeight = active ? '600' : '400';
    });

    const body = panel.querySelector('#__cinema_focus_body') as HTMLElement | null;
    if (!body) return;

    const sections: Record<string, string> = {
      diff: `
        <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:18px;">
          <div>
            <div style="font-size:10px;letter-spacing:0.18em;color:#6b7280;font-weight:700;text-transform:uppercase;margin-bottom:4px;">Diff</div>
            <div style="font-size:18px;font-weight:700;letter-spacing:-0.01em;">3 files · <span style="color:#3fb950;">+172</span> <span style="color:#f85149;">−27</span></div>
          </div>
          <div style="display:flex;gap:8px;">
            <span style="padding:4px 10px;border-radius:999px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);font-size:11px;color:#9aa0aa;">Working</span>
            <span style="padding:4px 10px;border-radius:999px;background:rgba(63,185,80,0.10);border:1px solid rgba(63,185,80,0.32);font-size:11px;color:#3fb950;">Unified</span>
          </div>
        </div>
        <div style="display:flex;flex-direction:column;gap:6px;margin-bottom:18px;">
          ${[
            { f: 'src/auth/rotate.ts', plus: 42, minus: 18 },
            { f: 'src/auth/index.ts', plus: 12, minus: 9 },
            { f: 'src/auth/__tests__/rotate.test.ts', plus: 118, minus: 0 },
          ].map((r) => `
            <div style="display:flex;align-items:center;gap:12px;padding:8px 12px;border:1px solid rgba(255,255,255,0.05);border-radius:8px;background:#0d0d10;">
              <span style="display:inline-flex;width:18px;height:18px;align-items:center;justify-content:center;border-radius:5px;background:rgba(210,153,34,0.15);color:#d29922;font-size:10px;font-weight:700;">M</span>
              <span style="flex:1;font-family:'SFMono-Regular',Menlo,monospace;font-size:12px;color:#e6edf3;">${r.f}</span>
              <span style="font-family:'SFMono-Regular',Menlo,monospace;font-size:11px;color:#3fb950;font-variant-numeric:tabular-nums;">+${r.plus}</span>
              <span style="font-family:'SFMono-Regular',Menlo,monospace;font-size:11px;color:#f85149;font-variant-numeric:tabular-nums;">−${r.minus}</span>
            </div>
          `).join('')}
        </div>
        <div style="border:1px solid rgba(255,255,255,0.06);border-radius:10px;background:#0a0b0e;overflow:hidden;font-family:'SFMono-Regular',Menlo,monospace;font-size:12px;">
          <div style="padding:6px 14px;background:#11121a;border-bottom:1px solid rgba(255,255,255,0.05);color:#9aa0aa;font-size:11px;">src/auth/rotate.ts</div>
          <div style="padding:8px 0;">
            ${[
              { n: 18, color: '#52535a', text: 'export class TokenRotator {' },
              { n: 19, color: '#52535a', text: '  private interval: NodeJS.Timeout | null = null;' },
              { n: 20, color: '#f85149', bg: 'rgba(248,81,73,0.08)', sign: '−', text: '  rotate(): string {' },
              { n: 21, color: '#f85149', bg: 'rgba(248,81,73,0.08)', sign: '−', text: '    return crypto.randomUUID();' },
              { n: 22, color: '#f85149', bg: 'rgba(248,81,73,0.08)', sign: '−', text: '  }' },
              { n: 23, color: '#3fb950', bg: 'rgba(63,185,80,0.08)', sign: '+', text: '  async rotate(prev?: Token): Promise<Token> {' },
              { n: 24, color: '#3fb950', bg: 'rgba(63,185,80,0.08)', sign: '+', text: '    if (prev && !prev.isExpired()) return prev;' },
              { n: 25, color: '#3fb950', bg: 'rgba(63,185,80,0.08)', sign: '+', text: '    const next = await this.mint();' },
              { n: 26, color: '#3fb950', bg: 'rgba(63,185,80,0.08)', sign: '+', text: '    await this.store.replace(prev, next);' },
              { n: 27, color: '#3fb950', bg: 'rgba(63,185,80,0.08)', sign: '+', text: '    return next;' },
              { n: 28, color: '#3fb950', bg: 'rgba(63,185,80,0.08)', sign: '+', text: '  }' },
            ].map((l: any) => `
              <div style="display:flex;background:${l.bg ?? 'transparent'};padding:1px 14px;">
                <span style="display:inline-block;width:30px;color:#52535a;text-align:right;margin-right:14px;">${l.n}</span>
                <span style="display:inline-block;width:12px;color:${l.color};">${l.sign ?? ' '}</span>
                <span style="color:${l.bg ? l.color : '#cbd5e1'};">${l.text.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</span>
              </div>
            `).join('')}
          </div>
        </div>
      `,
      tokens: `
        <div style="margin-bottom:24px;">
          <div style="font-size:10px;letter-spacing:0.18em;color:#6b7280;font-weight:700;text-transform:uppercase;margin-bottom:4px;">Tokens</div>
          <div style="font-size:18px;font-weight:700;letter-spacing:-0.01em;">14.5k of 200k · $0.42</div>
        </div>
        <div style="margin-bottom:8px;display:flex;justify-content:space-between;font-size:11px;color:#9aa0aa;">
          <span>Context window</span><span>7.3%</span>
        </div>
        <div style="height:10px;border-radius:999px;background:#0d0d10;border:1px solid rgba(255,255,255,0.06);overflow:hidden;margin-bottom:24px;">
          <div style="width:7.3%;height:100%;background:linear-gradient(90deg, #58a6ff, #a78bfa);box-shadow:0 0 12px rgba(88,166,255,0.6);"></div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:24px;">
          ${[
            { label: 'Input tokens', value: '12,400', sub: '85.6%' },
            { label: 'Output tokens', value: '2,090', sub: '14.4%' },
            { label: 'Cache reads', value: '8,900', sub: '· 61% cached' },
            { label: 'Cost (USD)', value: '$0.42', sub: 'estimated' },
          ].map((stat) => `
            <div style="padding:12px 14px;border:1px solid rgba(255,255,255,0.05);border-radius:10px;background:#0a0b0e;">
              <div style="font-size:10px;letter-spacing:0.14em;color:#6b7280;font-weight:700;text-transform:uppercase;margin-bottom:6px;">${stat.label}</div>
              <div style="font-size:22px;font-weight:700;color:#e6edf3;font-family:'SFMono-Regular',Menlo,monospace;font-variant-numeric:tabular-nums;">${stat.value}</div>
              <div style="font-size:11px;color:#9aa0aa;margin-top:2px;">${stat.sub}</div>
            </div>
          `).join('')}
        </div>
        <div style="padding:14px 16px;border:1px solid rgba(94,234,212,0.2);border-radius:12px;background:linear-gradient(135deg, rgba(94,234,212,0.06), rgba(88,166,255,0.04));">
          <div style="display:flex;align-items:center;gap:10px;margin-bottom:6px;">
            <span style="width:7px;height:7px;border-radius:50%;background:#5eead4;box-shadow:0 0 10px #5eead488;"></span>
            <span style="font-size:11px;letter-spacing:0.14em;color:#9aa0aa;font-weight:700;text-transform:uppercase;">Provider</span>
          </div>
          <div style="font-size:13px;color:#cbd5e1;">Anthropic · claude-opus-4-8 · <span style="color:#fbbf24;">benchmark 55/100</span></div>
        </div>
      `,
    };

    body.innerHTML = sections[s as keyof typeof sections] ?? body.innerHTML;
  }, section);
}
