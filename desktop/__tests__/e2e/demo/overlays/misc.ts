import type { Page } from 'playwright';

// Focus view renders this empty state only when the staged pane it was
// asked to show doesn't exist in the store — a real staging bug, not a
// transient render race, so this must fail the recording loudly rather than
// hide the evidence and let a broken frame through.
export async function paintFleetTopBar(page: Page): Promise<void> {
  const paneNotFound = await page.evaluate(() => {
    const empty = document.querySelector('.flex.items-center.justify-center.h-full') as HTMLElement | null;
    return !!empty && !!empty.textContent?.includes('Pane not found');
  });
  if (paneNotFound) {
    throw new Error('paintFleetTopBar: Focus view rendered "Pane not found" — the staged pane was rejected.');
  }
}

export async function showProviderHealthMockup(page: Page, anchor: { x: number; y: number }): Promise<void> {
  await page.evaluate(({ x, y }) => {
    const layer = document.getElementById('__cinema_layer');
    if (!layer) return;
    const old = document.getElementById('__cinema_provider');
    if (old) old.remove();

    const card = document.createElement('div');
    card.id = '__cinema_provider';
    card.style.cssText = `
      position:fixed;left:${x}px;top:${y}px;z-index:99999;pointer-events:none;
      width:320px;border-radius:14px;overflow:hidden;
      background:#0f1014;border:1px solid #21222a;
      box-shadow:0 20px 50px rgba(0,0,0,0.6), 0 0 40px rgba(251,191,36,0.18);
      font-family:'Inter',-apple-system,sans-serif;color:#e6edf3;
      animation:cinema-card-in 360ms cubic-bezier(0.16,1,0.3,1) both;
    `;

    card.innerHTML = `
      <div style="padding:14px 16px;border-bottom:1px solid #1c1d24;display:flex;align-items:center;justify-content:space-between;gap:10px;">
        <div style="display:flex;align-items:baseline;gap:8px;min-width:0;">
          <span style="font-weight:700;font-size:14px;">Anthropic</span>
          <span style="color:#9aa0aa;font-size:12px;font-family:'SFMono-Regular',Menlo,monospace;">claude-opus-4-8</span>
        </div>
        <span style="display:inline-flex;align-items:center;gap:6px;padding:3px 9px;border-radius:999px;background:rgba(251,191,36,0.12);border:1px solid rgba(251,191,36,0.32);color:#fbbf24;font-size:11px;font-weight:600;">
          <span style="width:6px;height:6px;border-radius:50%;background:#fbbf24;"></span>Degraded
        </span>
      </div>
      <div style="padding:14px 16px;border-bottom:1px solid #1c1d24;">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">
          <span style="width:6px;height:6px;border-radius:50%;background:#fbbf24;"></span>
          <span style="font-size:10px;font-weight:700;letter-spacing:0.14em;color:#9aa0aa;">BENCHMARK</span>
        </div>
        <div style="display:flex;align-items:baseline;gap:10px;">
          <span id="__cinema_bench_score" style="font-size:30px;font-weight:700;color:#fbbf24;letter-spacing:-0.02em;font-variant-numeric:tabular-nums;">0</span>
          <span style="font-size:12px;color:#6b7280;">/100 —</span>
        </div>
      </div>
      <div style="padding:12px 16px 6px;">
        <div style="display:flex;justify-content:space-between;font-size:10px;font-weight:700;letter-spacing:0.14em;color:#6b7280;margin-bottom:8px;">
          <span>MODEL</span><span>BENCH</span>
        </div>
        <div style="display:flex;flex-direction:column;gap:7px;">
          <div style="position:relative;display:flex;align-items:center;justify-content:space-between;gap:8px;padding-left:14px;">
            <div style="position:absolute;left:0;top:0;bottom:0;width:3px;background:#fbbf24;border-radius:2px;"></div>
            <div style="display:flex;align-items:center;gap:8px;min-width:0;">
              <span style="width:6px;height:6px;border-radius:50%;background:#fbbf24;flex-shrink:0;"></span>
              <span style="font-weight:600;font-size:12px;font-family:'SFMono-Regular',Menlo,monospace;color:#fff;">claude-opus-4-8</span>
              <span style="padding:2px 7px;border-radius:999px;background:rgba(251,191,36,0.16);color:#fbbf24;font-size:9px;font-weight:700;letter-spacing:0.08em;">ACTIVE</span>
            </div>
            <span style="font-size:13px;font-weight:700;color:#fff;font-variant-numeric:tabular-nums;">55</span>
          </div>
          <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;padding-left:14px;">
            <div style="display:flex;align-items:center;gap:8px;min-width:0;">
              <span style="width:6px;height:6px;border-radius:50%;background:#fbbf24;flex-shrink:0;"></span>
              <span style="font-size:12px;font-family:'SFMono-Regular',Menlo,monospace;color:#cbd5e1;">claude-sonnet-4-5-20250929</span>
            </div>
            <span style="font-size:13px;font-weight:700;color:#cbd5e1;">63</span>
          </div>
          <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;padding-left:14px;">
            <div style="display:flex;align-items:center;gap:8px;min-width:0;">
              <span style="width:6px;height:6px;border-radius:50%;background:#fbbf24;flex-shrink:0;"></span>
              <span style="font-size:12px;font-family:'SFMono-Regular',Menlo,monospace;color:#cbd5e1;">claude-opus-4-5-20251101</span>
            </div>
            <span style="font-size:13px;font-weight:700;color:#cbd5e1;">62</span>
          </div>
          <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;padding-left:14px;">
            <div style="display:flex;align-items:center;gap:8px;min-width:0;">
              <span style="width:6px;height:6px;border-radius:50%;background:#fbbf24;flex-shrink:0;"></span>
              <span style="font-size:12px;font-family:'SFMono-Regular',Menlo,monospace;color:#cbd5e1;">claude-opus-4-6</span>
            </div>
            <span style="font-size:13px;font-weight:700;color:#cbd5e1;">62</span>
          </div>
        </div>
      </div>
      <div style="padding:12px 16px;border-top:1px solid #1c1d24;display:flex;align-items:center;justify-content:space-between;gap:8px;">
        <div style="display:flex;align-items:center;gap:8px;font-size:12px;color:#cbd5e1;">
          <span style="width:7px;height:7px;border-radius:50%;background:#34d399;box-shadow:0 0 8px #34d39988;"></span>
          API all systems operational
        </div>
        <span style="font-size:11px;color:#6b7280;">aistupidlevel ↗</span>
      </div>
    `;
    layer.appendChild(card);
  }, anchor);
}

export async function hideProviderHealthMockup(page: Page): Promise<void> {
  await page.evaluate(() => {
    const card = document.getElementById('__cinema_provider');
    if (!card) return;
    card.style.animation = 'cinema-callout-out 280ms ease both';
    window.setTimeout(() => card.remove(), 300);
  });
  await new Promise((r) => setTimeout(r, 320));
}

export async function showCreateDialogMockup(page: Page): Promise<void> {
  await page.evaluate(() => {
    const layer = document.getElementById('__cinema_layer');
    if (!layer) return;
    const old = document.getElementById('__cinema_create');
    if (old) old.remove();

    const wrap = document.createElement('div');
    wrap.id = '__cinema_create';
    wrap.style.cssText = `
      position:fixed;inset:0;z-index:99999;pointer-events:none;
      display:flex;align-items:flex-start;justify-content:center;padding-top:10vh;
      background:rgba(0,0,0,0.72);
      animation:cinema-fade-in 360ms ease both;
    `;

    wrap.innerHTML = `
      <div style="position:absolute;width:520px;height:520px;border-radius:50%;
        background:radial-gradient(closest-side, rgba(88,166,255,0.14), transparent 100%);
        filter:blur(60px);left:18%;top:14%;animation:cinema-orb-pulse 11s ease-in-out infinite;"></div>
      <div style="position:absolute;width:420px;height:420px;border-radius:50%;
        background:radial-gradient(closest-side, rgba(251,191,36,0.07), transparent 100%);
        filter:blur(70px);right:14%;bottom:14%;animation:cinema-orb-pulse 14s ease-in-out infinite reverse;"></div>

      <div style="position:relative;width:580px;padding:1.5px;border-radius:24px;
        background:linear-gradient(152deg, rgba(88,166,255,0.55) 0%, rgba(139,92,246,0.32) 28%, rgba(255,255,255,0.09) 52%, rgba(251,191,36,0.28) 78%, rgba(45,212,191,0.22) 100%);
        box-shadow:0 32px 64px -24px rgba(0,0,0,0.65), 0 0 120px -40px rgba(88,166,255,0.35);
        animation:cinema-card-in 540ms cubic-bezier(0.16,1,0.3,1) both;
      ">
        <div style="position:relative;border-radius:22.5px;overflow:hidden;
          background: linear-gradient(168deg, #181a22 0%, #0c0d12 45%, #08090c 100%);
          box-shadow:inset 0 1px 0 0 rgba(255,255,255,0.09), inset 0 0 0 1px rgba(255,255,255,0.04);
          font-family:'Inter',-apple-system,sans-serif;color:#f4f5fb;
        ">

          <div style="display:flex;align-items:center;justify-content:space-between;padding:20px 20px 4px;">
            <div style="display:flex;flex-direction:column;">
              <span style="font-size:11px;font-weight:500;letter-spacing:0.14em;color:#5c6178;text-transform:uppercase;">Launch</span>
              <span style="font-size:18px;font-weight:600;letter-spacing:-0.03em;color:#f4f5fb;margin-top:2px;">New Pane</span>
            </div>
            <div style="display:flex;align-items:center;gap:6px;padding:6px 10px;border-radius:8px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.06);">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#484b60" stroke-width="2" stroke-linecap="round"><path d="M17 3l4 4L7 21H3v-4L17 3z"/></svg>
              <span style="font-size:12px;color:#8b8fa3;">refactor-auth</span>
            </div>
          </div>

          <div style="padding:16px 16px 10px;">
            <div id="__cinema_prompt_field" style="
              display:flex;align-items:flex-start;gap:10px;
              padding:14px 14px;min-height:64px;margin-bottom:12px;
              border-radius:12px;
              border:1px solid rgba(88,166,255,0.28);
              background:linear-gradient(180deg, rgba(88,166,255,0.05), rgba(88,166,255,0.02));
              box-shadow:0 0 24px -10px rgba(88,166,255,0.35);
            ">
              <span style="
                display:inline-flex;align-items:center;justify-content:center;
                width:22px;height:22px;border-radius:6px;flex-shrink:0;
                background:rgba(88,166,255,0.12);color:#58a6ff;
              ">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><polyline points="9 18 15 12 9 6"/></svg>
              </span>
              <div style="flex:1;min-width:0;">
                <div style="font-size:10px;font-weight:600;letter-spacing:0.14em;color:#5c6178;text-transform:uppercase;margin-bottom:4px;">Prompt</div>
                <div id="__cinema_prompt_text" style="
                  font-size:13px;line-height:1.45;color:#e9edf8;font-weight:500;
                  min-height:19px;letter-spacing:-0.005em;
                "></div>
              </div>
            </div>

            <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;">

              <div style="position:relative;border-radius:14px;overflow:hidden;border:1px solid #4a6cf7;background:rgba(74,108,247,0.10);box-shadow:0 0 24px -8px rgba(74,108,247,0.45);">
                <div style="height:2px;background:linear-gradient(90deg, #f59e0b, #fbbf24);opacity:0.6;"></div>
                <div style="padding:12px 14px;">
                  <div style="width:32px;height:32px;border-radius:10px;background:rgba(245,158,11,0.15);display:flex;align-items:center;justify-content:center;color:#f59e0b;margin-bottom:10px;">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l8 18-8-6-8 6 8-18z"/></svg>
                  </div>
                  <div style="font-size:13px;font-weight:600;color:#f0f0f8;">Claude Code</div>
                  <div style="font-size:10px;color:#484b60;margin-top:4px;">Anthropic</div>
                </div>
                <div style="position:absolute;top:12px;right:12px;width:16px;height:16px;border-radius:50%;border:1px solid #5d7cff;background:rgba(74,108,247,0.14);display:flex;align-items:center;justify-content:center;">
                  <span style="width:8px;height:8px;border-radius:50%;background:#5d7cff;"></span>
                </div>
              </div>

              <div style="position:relative;border-radius:14px;overflow:hidden;border:1px solid rgba(255,255,255,0.06);background:rgba(255,255,255,0.025);">
                <div style="height:2px;background:linear-gradient(90deg, #10b981, #34d399);opacity:0.6;"></div>
                <div style="padding:12px 14px;">
                  <div style="width:32px;height:32px;border-radius:10px;background:rgba(16,185,129,0.15);display:flex;align-items:center;justify-content:center;color:#10b981;margin-bottom:10px;">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="9" ry="3.5"/></svg>
                  </div>
                  <div style="font-size:13px;font-weight:600;color:#f0f0f8;">Codex</div>
                  <div style="font-size:10px;color:#484b60;margin-top:4px;">OpenAI</div>
                </div>
                <div style="position:absolute;top:12px;right:12px;width:16px;height:16px;border-radius:50%;border:1px solid rgba(255,255,255,0.14);"></div>
              </div>

              <div style="position:relative;border-radius:14px;overflow:hidden;border:1px solid rgba(255,255,255,0.06);background:rgba(255,255,255,0.025);">
                <div style="height:2px;background:linear-gradient(90deg, #6366f1, #818cf8);opacity:0.6;"></div>
                <div style="padding:12px 14px;">
                  <div style="width:32px;height:32px;border-radius:10px;background:rgba(99,102,241,0.15);display:flex;align-items:center;justify-content:center;color:#6366f1;margin-bottom:10px;">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="8 6 2 12 8 18"/><polyline points="16 6 22 12 16 18"/></svg>
                  </div>
                  <div style="font-size:13px;font-weight:600;color:#f0f0f8;">OpenCode</div>
                  <div style="font-size:10px;color:#484b60;margin-top:4px;">Open-source</div>
                </div>
                <div style="position:absolute;top:12px;right:12px;width:16px;height:16px;border-radius:50%;border:1px solid rgba(255,255,255,0.14);"></div>
              </div>
            </div>
          </div>

          <div style="padding:0 16px 12px;display:grid;grid-template-columns:1fr 1fr;gap:8px;">
            <div style="display:flex;align-items:center;gap:10px;min-height:58px;padding:10px 12px;border-radius:12px;border:1px solid rgba(255,255,255,0.06);background:rgba(255,255,255,0.025);">
              <div style="width:32px;height:32px;border-radius:10px;border:1px solid rgba(255,255,255,0.06);background:rgba(255,255,255,0.04);display:flex;align-items:center;justify-content:center;color:#8b8fa3;flex-shrink:0;">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 1v3M15 1v3M9 20v3M15 20v3M1 9h3M1 15h3M20 9h3M20 15h3"/></svg>
              </div>
              <div style="flex:1;min-width:0;">
                <div style="font-size:10px;font-weight:500;text-transform:uppercase;letter-spacing:0.125em;color:#5c6178;line-height:1;">Model</div>
                <div style="font-size:11px;font-weight:600;color:#e9edf8;line-height:1.3;margin-top:4px;">opus-4-8</div>
              </div>
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#5c6178" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
            </div>
            <div style="display:flex;align-items:center;gap:10px;min-height:58px;padding:10px 12px;border-radius:12px;border:1px solid rgba(255,255,255,0.06);background:rgba(255,255,255,0.025);">
              <div style="width:32px;height:32px;border-radius:10px;border:1px solid rgba(255,255,255,0.06);background:rgba(255,255,255,0.04);display:flex;align-items:center;justify-content:center;color:#8b8fa3;flex-shrink:0;">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="14" r="6"/><polyline points="12 14 16 10"/><path d="M9 2h6"/></svg>
              </div>
              <div style="flex:1;min-width:0;">
                <div style="font-size:10px;font-weight:500;text-transform:uppercase;letter-spacing:0.125em;color:#5c6178;line-height:1;">Effort</div>
                <div style="font-size:11px;font-weight:600;color:#e9edf8;line-height:1.3;margin-top:4px;">High</div>
              </div>
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#5c6178" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
            </div>
          </div>

          <div style="padding:0 16px 12px;display:grid;grid-template-columns:1.08fr 0.92fr;gap:8px;">
            <div style="min-height:58px;padding:10px 12px;border-radius:12px;border:1px solid rgba(88,166,255,0.14);background:rgba(88,166,255,0.055);">
              <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">
                <span style="width:6px;height:6px;border-radius:50%;background:#58a6ff;box-shadow:0 0 12px rgba(88,166,255,0.65);"></span>
                <span style="font-size:11px;font-weight:600;color:#e9edf8;">Claude Auto Mode</span>
              </div>
              <p style="font-size:10px;font-weight:500;line-height:1.4;color:#6f7489;margin:0;">Starts Claude Code in auto mode for safe workspace edits.</p>
            </div>
            <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;min-height:58px;padding:10px 12px;border-radius:12px;border:1px solid rgba(255,255,255,0.06);background:rgba(255,255,255,0.025);">
              <div style="display:flex;align-items:center;gap:10px;min-width:0;">
                <div style="width:32px;height:32px;border-radius:10px;border:1px solid rgba(255,255,255,0.06);background:rgba(255,255,255,0.04);display:flex;align-items:center;justify-content:center;color:#8b8fa3;flex-shrink:0;">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/></svg>
                </div>
                <div style="min-width:0;">
                  <div style="font-size:11px;font-weight:600;color:#e9edf8;line-height:1;">Git Worktree</div>
                  <div style="font-size:9.5px;font-weight:500;color:#5c6178;line-height:1;margin-top:4px;">Isolated branch and folder</div>
                </div>
              </div>
              <div style="width:30px;height:18px;border-radius:999px;background:#58a6ff;position:relative;flex-shrink:0;">
                <span style="position:absolute;right:2px;top:2px;width:14px;height:14px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,0.4);"></span>
              </div>
            </div>
          </div>

          <div style="padding:0 16px 14px;">
            <div style="display:flex;align-items:center;gap:6px;font-size:10px;font-weight:500;color:#484b60;">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 6 15 12 9 18"/></svg>
              <span style="letter-spacing:0.02em;">More options</span>
            </div>
          </div>

          <div style="display:flex;align-items:center;justify-content:space-between;padding:16px;border-top:1px solid rgba(255,255,255,0.06);background:linear-gradient(to top, transparent, rgba(255,255,255,0.02));">
            <div style="display:flex;align-items:center;gap:10px;">
              <span style="font-size:10px;color:#484b60;display:inline-flex;align-items:center;gap:4px;">
                <kbd style="padding:2px 6px;border-radius:4px;background:#0d0d10;border:1px solid #1c1c20;font-size:11px;font-family:monospace;color:#8b949e;line-height:1;">Esc</kbd>
                close
              </span>
              <span style="font-size:10px;color:#484b60;display:inline-flex;align-items:center;gap:4px;">
                <kbd style="padding:2px 6px;border-radius:4px;background:#0d0d10;border:1px solid #1c1c20;font-size:11px;font-family:monospace;color:#8b949e;line-height:1;">↵</kbd>
                launch
              </span>
            </div>
            <div style="display:flex;align-items:center;gap:8px;">
              <div style="display:flex;align-items:center;gap:6px;padding:8px 14px;border-radius:10px;border:1px solid rgba(255,255,255,0.08);background:transparent;color:#8b8fa3;font-size:11px;font-weight:500;">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>
                Terminal
              </div>
              <div id="__cinema_launch_btn" style="padding:8px 20px;border-radius:10px;background:linear-gradient(135deg, #3b82f6 0%, #6366f1 48%, #2563eb 100%);color:#fff;font-size:12px;font-weight:600;box-shadow:0 0 24px -6px rgba(74,108,247,0.45);">
                Launch Pane
              </div>
            </div>
          </div>
        </div>
      </div>
    `;
    layer.appendChild(wrap);
  });
}

export async function hideCreateDialogMockup(page: Page): Promise<void> {
  await page.evaluate(() => {
    const c = document.getElementById('__cinema_create');
    if (!c) return;
    c.style.animation = 'cinema-fade-out 400ms ease both';
    window.setTimeout(() => c.remove(), 420);
  });
  await new Promise((r) => setTimeout(r, 440));
}
