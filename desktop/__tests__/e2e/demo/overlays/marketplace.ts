import type { Page } from 'playwright';

export async function paintMarketplaceMockup(page: Page): Promise<void> {
  await page.evaluate(() => {
    const old = document.getElementById('__cinema_marketplace');
    if (old) old.remove();

    const overlay = document.createElement('div');
    overlay.id = '__cinema_marketplace';
    overlay.style.cssText = `
      position:fixed;left:48px;right:0;top:0;bottom:0;z-index:40;pointer-events:none;
      background:#000;
      padding:28px 32px 28px;overflow:hidden;
      font-family:'Inter',-apple-system,sans-serif;color:#e6edf3;
      animation:cinema-fade-in 360ms ease both;
    `;

    overlay.innerHTML = `
      <div style="display:flex;flex-direction:column;height:100%;gap:18px;">

        <div>
          <div style="font-size:11px;letter-spacing:0.18em;color:#6b7280;font-weight:700;text-transform:uppercase;margin-bottom:4px;">Marketplace</div>
          <div style="display:flex;align-items:baseline;justify-content:space-between;">
            <div style="font-size:22px;font-weight:700;letter-spacing:-0.02em;">Skills · MCP servers · Hooks · Agents</div>
            <div style="display:flex;gap:6px;">
              <div style="display:flex;align-items:center;gap:6px;padding:6px 11px;border-radius:999px;border:1px solid #1c1c20;font-size:11px;color:#e6edf3;background:#050507;">
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 19l-7-7 7-7M2 12h22"/></svg>
                Awesome Claude Agents
                <span style="font-size:9px;padding:2px 6px;border-radius:4px;background:rgba(88,166,255,0.12);color:#58a6ff;font-weight:600;">Community</span>
              </div>
              <div style="display:flex;align-items:center;gap:6px;padding:6px 11px;border-radius:8px;background:#58a6ff;color:#000;font-size:11px;font-weight:600;">
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                Add source
              </div>
            </div>
          </div>
        </div>

        <div style="display:flex;gap:10px;align-items:center;">
          <div style="flex:1;display:flex;align-items:center;gap:8px;padding:8px 14px;border-radius:10px;background:#050507;border:1px solid #1c1c20;">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#6b7280" stroke-width="2"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.5" y2="16.5"/></svg>
            <span style="font-size:12px;color:#6b7280;">Search plugins, skills, MCP servers…</span>
          </div>
          <div style="display:flex;gap:6px;">
            ${['All', 'MCP Servers', 'Skills', 'Hooks', 'Agents'].map((label, i) => `
              <span style="padding:5px 11px;border-radius:999px;font-size:10px;font-weight:600;
                ${i === 0 ? 'background:#58a6ff;color:#000;' : 'background:#050507;color:#8b949e;border:1px solid #1c1c20;'}">
                ${label}
              </span>
            `).join('')}
          </div>
        </div>

        <div style="font-size:10px;letter-spacing:0.12em;color:#6b7280;font-weight:700;text-transform:uppercase;">Available · 8</div>

        <div id="__cinema_marketplace_grid" style="flex:1;display:grid;grid-template-columns:1fr 1fr;gap:12px;overflow:hidden;">

          ${[
            { name: 'pr-reviewer', version: '0.9.7', desc: 'Inline PR comments with severity, fix suggestions, and a final go/no-go verdict.', skills: 2, mcps: 0, hooks: 1, agents: 1, featured: true },
            { name: 'spec-driven-dev', version: '2.0.1', desc: 'Plan from a spec, implement in slices, write tests at each gate, never skip review.', skills: 4, mcps: 1, hooks: 0, agents: 2 },
            { name: 'security-auditor', version: '1.4.2', desc: 'Comprehensive security review across OWASP, secrets, supply-chain, and dependency CVEs.', skills: 3, mcps: 0, hooks: 1, agents: 1 },
            { name: 'figma-mcp', version: '1.0.3', desc: 'Read Figma frames as a tool — design tokens, components, layouts surfaced to your agent.', skills: 0, mcps: 1, hooks: 0, agents: 0, tag: 'MCP' },
            { name: 'refactor-pro', version: '1.2.0', desc: 'Find code smells, extract pure functions, dedupe across files. Idiomatic for TS, Python, Go.', skills: 5, mcps: 0, hooks: 0, agents: 2 },
            { name: 'test-author', version: '0.8.5', desc: 'Generate AAA-style tests from a function or class. Targets vitest, jest, pytest.', skills: 2, mcps: 0, hooks: 0, agents: 1 },
          ].map((p) => `
            <div style="border:1px solid ${p.featured ? '#58a6ff44' : '#1c1c20'};border-radius:12px;background:${p.featured ? 'linear-gradient(135deg, rgba(88,166,255,0.04), transparent 70%), #050507' : '#050507'};padding:14px 16px;display:flex;flex-direction:column;gap:8px;${p.featured ? 'box-shadow:0 0 28px -8px rgba(88,166,255,0.32);' : ''}">
              <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;">
                <div style="display:flex;align-items:center;gap:8px;min-width:0;">
                  <span style="font-size:13px;font-weight:600;color:#e6edf3;font-family:'SFMono-Regular',Menlo,monospace;">${p.name}</span>
                  <span style="font-size:10px;font-family:'SFMono-Regular',Menlo,monospace;padding:1px 6px;border-radius:4px;background:#0d0d10;border:1px solid #1c1c20;color:#8b949e;">v${p.version}</span>
                  ${p.featured ? `<span style="font-size:9px;font-weight:700;letter-spacing:0.08em;padding:2px 7px;border-radius:999px;background:rgba(88,166,255,0.14);color:#58a6ff;text-transform:uppercase;">Featured</span>` : ''}
                </div>
                <div style="display:flex;align-items:center;gap:5px;padding:5px 10px;border-radius:7px;background:#0d0d10;border:1px solid #1c1c20;color:#8b949e;font-size:11px;font-weight:500;">
                  Install
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
                </div>
              </div>
              <div style="font-size:11px;color:#8b949e;line-height:1.5;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;">${p.desc}</div>
              <div style="display:flex;gap:6px;flex-wrap:wrap;">
                ${p.skills > 0 ? `<span style="display:inline-flex;align-items:center;gap:4px;padding:3px 9px;border-radius:999px;background:#0d0d10;border:1px solid #1c1c20;font-size:10px;color:#8b949e;font-weight:500;">${p.skills} skills</span>` : ''}
                ${p.mcps > 0 ? `<span style="display:inline-flex;align-items:center;gap:4px;padding:3px 9px;border-radius:999px;background:rgba(94,234,212,0.06);border:1px solid rgba(94,234,212,0.18);font-size:10px;color:#5eead4;font-weight:500;">${p.mcps} MCP${p.mcps > 1 ? 's' : ''}</span>` : ''}
                ${p.hooks > 0 ? `<span style="display:inline-flex;align-items:center;gap:4px;padding:3px 9px;border-radius:999px;background:#0d0d10;border:1px solid #1c1c20;font-size:10px;color:#8b949e;font-weight:500;">${p.hooks} hook${p.hooks > 1 ? 's' : ''}</span>` : ''}
                ${p.agents > 0 ? `<span style="display:inline-flex;align-items:center;gap:4px;padding:3px 9px;border-radius:999px;background:rgba(167,139,250,0.08);border:1px solid rgba(167,139,250,0.20);font-size:10px;color:#a78bfa;font-weight:500;">${p.agents} agent${p.agents > 1 ? 's' : ''}</span>` : ''}
              </div>
            </div>
          `).join('')}
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
  });
}

export async function hideMarketplaceMockup(page: Page): Promise<void> {
  await page.evaluate(() => {
    const el = document.getElementById('__cinema_marketplace');
    if (el) el.remove();
  });
}
