// Brand-card overlays (title / outro / poster lockup) built on the cinema
// system's shared layer + keyframes (injected once by setupCinema()).
import type { Page } from 'playwright';
import { sleep } from './cinema';

// Full-screen title/outro cards sit over a dimmed (never opaque-black) live
// fleet so they satisfy "no frame is >80% black" while staying branded.
export async function showTitleCard(
  page: Page,
  opts: { brand: string; tagline: string; sub?: string },
): Promise<void> {
  const wordmark = brandWordmarkHtml(opts.brand, 108);
  const inner = `
    ${BRAND_ORBS}
    <div style="position:relative;text-align:center;animation:cinema-card-in 700ms cubic-bezier(0.16,1,0.3,1) both;">
      ${wordmark}
      <div style="font-size:20px;font-weight:300;letter-spacing:0.14em;text-transform:uppercase;color:rgba(255,255,255,0.62);margin-top:14px;">${opts.tagline}</div>
      ${opts.sub ? `<div style="margin-top:8px;font-size:14px;color:rgba(255,255,255,0.42);max-width:560px;margin-left:auto;margin-right:auto;">${opts.sub}</div>` : ''}
    </div>
  `;
  await page.evaluate((inner) => {
    const layer = document.getElementById('__cinema_layer');
    if (!layer) return;
    document.getElementById('__cinema_title')?.remove();
    const wrap = document.createElement('div');
    wrap.id = '__cinema_title';
    wrap.style.cssText = `
      position:fixed;inset:0;z-index:99999;pointer-events:none;
      display:flex;align-items:center;justify-content:center;
      background:rgba(5,6,10,0.82);
      -webkit-backdrop-filter:blur(3px);backdrop-filter:blur(3px);
      animation:cinema-fade-in 500ms ease both;
    `;
    wrap.innerHTML = inner;
    layer.appendChild(wrap);
  }, inner);
}

export async function hideTitleCard(page: Page): Promise<void> {
  await page.evaluate(() => {
    const t = document.getElementById('__cinema_title');
    if (!t) return;
    t.style.animation = 'cinema-fade-out 400ms ease both';
    window.setTimeout(() => t.remove(), 420);
  });
  await sleep(440);
}

export async function showOutroCard(page: Page, opts: { pills: string[]; github: string }): Promise<void> {
  const wordmark = brandWordmarkHtml('Amux', 100);
  const pillsHtml = opts.pills
    .map((t) => `<span style="padding:7px 16px;border-radius:999px;border:1px solid rgba(255,255,255,0.10);background:rgba(255,255,255,0.04);color:rgba(255,255,255,0.65);font-size:13px;font-weight:500;">${t}</span>`)
    .join('');
  const inner = `
    ${BRAND_ORBS}
    ${wordmark}
    <div style="font-size:16px;font-weight:300;letter-spacing:0.2em;text-transform:uppercase;color:rgba(255,255,255,0.55);margin:12px 0 36px;animation:cinema-card-in 800ms 120ms cubic-bezier(0.16,1,0.3,1) both;">The control plane for your AI agents</div>
    <div style="display:flex;gap:10px;flex-wrap:wrap;justify-content:center;max-width:640px;margin-bottom:40px;animation:cinema-card-in 700ms 260ms cubic-bezier(0.16,1,0.3,1) both;">
      ${pillsHtml}
    </div>
    <div style="display:inline-flex;align-items:center;gap:10px;padding:12px 24px;border-radius:14px;background:rgba(88,166,255,0.10);border:1px solid rgba(88,166,255,0.30);box-shadow:0 0 40px -10px rgba(88,166,255,0.4);animation:cinema-card-in 700ms 400ms cubic-bezier(0.16,1,0.3,1) both;">
      <span style="font-family:'SFMono-Regular',Menlo,monospace;font-size:13px;font-weight:600;color:rgba(255,255,255,0.88);">${opts.github}</span>
    </div>
  `;
  await page.evaluate((inner) => {
    const layer = document.getElementById('__cinema_layer');
    if (!layer) return;
    document.getElementById('__cinema_outro')?.remove();
    const wrap = document.createElement('div');
    wrap.id = '__cinema_outro';
    wrap.style.cssText = `
      position:fixed;inset:0;z-index:99999;pointer-events:none;
      background:rgba(5,6,10,0.88);
      -webkit-backdrop-filter:blur(4px);backdrop-filter:blur(4px);
      display:flex;flex-direction:column;align-items:center;justify-content:center;
      animation:cinema-fade-in 700ms ease both;
    `;
    wrap.innerHTML = inner;
    layer.appendChild(wrap);
  }, inner);
}

export async function hideOutroCard(page: Page): Promise<void> {
  await page.evaluate(() => {
    const o = document.getElementById('__cinema_outro');
    if (!o) return;
    o.style.animation = 'cinema-fade-out 500ms ease both';
    window.setTimeout(() => o.remove(), 520);
  });
  await sleep(540);
}

// Non-fullscreen bottom-center lockup used as the hero cut's poster frame —
// sits over the LIVE fleet on a translucent scrim, never an opaque cover.
// Two layers keep the wordmark legible without reading as text-on-text:
// a full-viewport dim (the fleet stays recognizably alive underneath) plus
// a wide, soft radial scrim scoped tightly to the wordmark/tagline/pill zone.
export async function showPosterLockup(
  page: Page,
  opts: { brand: string; tagline: string; github?: string },
): Promise<void> {
  const wordmark = brandWordmarkHtml(opts.brand, 56);
  const inner = `
    <div style="text-align:center;animation:cinema-card-in 700ms cubic-bezier(0.16,1,0.3,1) both;">
      <div style="position:relative;display:inline-block;min-width:820px;padding:48px 40px 40px;background:radial-gradient(560px 240px at 50% 50%, rgba(3,4,7,0.97) 0%, rgba(3,4,7,0.9) 40%, rgba(3,4,7,0.66) 68%, rgba(3,4,7,0.24) 90%, transparent 100%);">
        ${wordmark}
        <div style="font-size:13px;font-weight:400;letter-spacing:0.08em;color:rgba(255,255,255,0.62);margin-top:8px;">${opts.tagline}</div>
        ${opts.github ? `<div style="margin-top:16px;display:inline-flex;align-items:center;gap:8px;padding:7px 16px;border-radius:999px;background:rgba(88,166,255,0.12);border:1px solid rgba(88,166,255,0.32);color:rgba(255,255,255,0.85);font-family:'SFMono-Regular',Menlo,monospace;font-size:11px;font-weight:600;animation:cinema-fade-in 500ms 200ms ease both;">${opts.github}</div>` : ''}
      </div>
    </div>
  `;
  await page.evaluate((inner) => {
    const layer = document.getElementById('__cinema_layer');
    if (!layer) return;
    document.getElementById('__cinema_poster')?.remove();
    document.getElementById('__cinema_poster_dim')?.remove();

    const dim = document.createElement('div');
    dim.id = '__cinema_poster_dim';
    dim.style.cssText = `
      position:fixed;inset:0;z-index:1;pointer-events:none;
      background:rgba(2,3,6,0.44);
      animation:cinema-fade-in 300ms ease both;
    `;
    layer.appendChild(dim);

    const wrap = document.createElement('div');
    wrap.id = '__cinema_poster';
    wrap.style.cssText = `
      position:fixed;left:0;right:0;bottom:0;height:34%;z-index:2;pointer-events:none;
      display:flex;flex-direction:column;align-items:center;justify-content:flex-end;padding-bottom:44px;
      animation:cinema-fade-in 500ms ease both;
    `;
    wrap.innerHTML = inner;
    layer.appendChild(wrap);
  }, inner);
}

export async function hidePosterLockup(page: Page): Promise<void> {
  await page.evaluate(() => {
    const p = document.getElementById('__cinema_poster');
    const d = document.getElementById('__cinema_poster_dim');
    if (p) {
      p.style.animation = 'cinema-fade-out 380ms ease both';
      window.setTimeout(() => p.remove(), 400);
    }
    if (d) {
      d.style.animation = 'cinema-fade-out 300ms ease both';
      window.setTimeout(() => d.remove(), 320);
    }
  });
  await sleep(420);
}

function brandWordmarkHtml(brand: string, sizePx: number): string {
  return `<div style="
    font-size:${sizePx}px;font-weight:800;letter-spacing:-0.05em;line-height:1;
    background:linear-gradient(135deg,#ffffff 0%,#c0c4cc 50%,#58a6ff 100%);
    -webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;color:transparent;
    text-shadow:0 4px 60px rgba(88,166,255,0.3);
    font-family:'Inter',-apple-system,BlinkMacSystemFont,sans-serif;
  ">${brand}</div>`;
}

const BRAND_ORBS = `
  <div style="position:absolute;width:520px;height:520px;border-radius:50%;background:radial-gradient(circle, rgba(88,166,255,0.4) 0%, transparent 70%);filter:blur(60px);left:18%;top:22%;animation:cinema-orb-pulse 6s ease-in-out infinite;"></div>
  <div style="position:absolute;width:420px;height:420px;border-radius:50%;background:radial-gradient(circle, rgba(167,139,250,0.4) 0%, transparent 70%);filter:blur(70px);right:14%;bottom:18%;animation:cinema-orb-pulse 7s ease-in-out infinite reverse;"></div>
`;
