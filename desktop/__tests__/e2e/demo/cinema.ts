// Deterministic, DOM-injected cinema system shared by both cuts: a scaled
// "floating window" backdrop, a camera that punches in/out on real elements,
// a synthetic cursor, two transition primitives (cut/dissolve), and a
// uniform callout card. Everything here is presentation-only — no staged
// content, no scene sequencing.
import type { Page } from 'playwright';

export const VIEWPORT = { width: 1600, height: 900 } as const;

const BASE_SCALE = 0.955;
const PUNCH_CEILING = 1.3;
const CALLOUT_WIDTH = 300;
const CALLOUT_MARGIN = 48;

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const TRACE = process.env.MUXBASE_DEMO_TRACE === '1';
export const trace = (label: string): void => { if (TRACE) console.log(`[trace] ${label} @ ${Date.now()}`); };

export async function setupCinema(page: Page): Promise<void> {
  await page.addStyleTag({ content: CINEMA_CSS });
  await page.evaluate(
    ({ baseScale }) => {
      const html = document.documentElement;
      html.style.cssText += `
        background: radial-gradient(120% 120% at 50% 50%, #0b0e14 0%, #05060a 100%);
        overflow: hidden;
      `;
      document.body.style.cssText += `
        transform-origin: 50% 50%;
        transform: scale(${baseScale});
        border-radius: 14px;
        overflow: hidden;
        border: 1px solid rgba(255,255,255,0.08);
        box-shadow: 0 30px 80px rgba(0,0,0,0.55);
      `;

      const layer = document.createElement('div');
      layer.id = '__cinema_layer';
      layer.style.cssText = 'position:fixed;inset:0;z-index:99998;pointer-events:none;font-family:"Inter",-apple-system,sans-serif;';
      html.appendChild(layer);

      const cursor = document.createElement('div');
      cursor.id = '__cinema_cursor';
      cursor.dataset.x = String(window.innerWidth / 2);
      cursor.dataset.y = String(window.innerHeight / 2);
      cursor.style.cssText = `
        position:fixed;top:0;left:0;z-index:1000000;pointer-events:none;
        opacity:0;transform:translate(${window.innerWidth / 2}px, ${window.innerHeight / 2}px);
        filter:drop-shadow(0 3px 6px rgba(0,0,0,0.45));
      `;
      cursor.innerHTML = `
        <svg width="22" height="22" viewBox="0 0 22 22">
          <path d="M2 1 L2 17 L6.5 13.5 L9.5 20 L12 18.7 L9 12.3 L15 12.3 Z"
            fill="#ffffff" stroke="#0b0e14" stroke-width="1.1" stroke-linejoin="round" />
        </svg>
      `;
      html.appendChild(cursor);
    },
    { baseScale: BASE_SCALE },
  );
}

// ── Camera ──────────────────────────────────────────────────────────────
// target = a CSS selector (measured live, in identity/untransformed space)
// or an explicit {x,y,width,height} rect already in identity space, or null
// for the wide shot. Punch-in scale is an absolute body-scale value, capped
// at PUNCH_CEILING so moves stay tasteful.
export type CameraTarget = string | { x: number; y: number; width: number; height: number } | null;

export async function camera(
  page: Page,
  target: CameraTarget,
  opts: { scale?: number; durationMs?: number } = {},
): Promise<void> {
  const durationMs = opts.durationMs ?? 900;
  const scale = target === null
    ? BASE_SCALE
    : Math.min(PUNCH_CEILING, Math.max(BASE_SCALE, opts.scale ?? 1.15));

  await page.evaluate(
    ({ target, scale, durationMs }) => {
      const body = document.body;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      let center = { x: vw / 2, y: vh / 2 };

      if (target) {
        const prevTransition = body.style.transition;
        const prevTransform = body.style.transform;
        body.style.transition = 'none';
        body.style.transform = 'none';
        let rect: { left: number; top: number; width: number; height: number } | null = null;
        if (typeof target === 'string') {
          const el = document.querySelector(target);
          if (el) rect = el.getBoundingClientRect();
        } else {
          rect = { left: target.x, top: target.y, width: target.width, height: target.height };
        }
        body.style.transform = prevTransform;
        body.style.transition = prevTransition;
        if (rect) center = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      }

      // Centring on a target near a frame edge demands more translation than
      // the punched-in body can absorb, which slides the window off-screen and
      // leaves a dead black void. The body spans `scale * viewport` about the
      // centre, so it only keeps covering the frame while
      // |t| <= (scale - 1) * viewport / 2. Clamp to exactly that: edge targets
      // land as close to centre as the shot allows, and the wide shot
      // (scale < 1, limit 0) stays centred as before.
      const clamp = (value: number, limit: number) => Math.min(limit, Math.max(-limit, value));
      const tx = target ? clamp(scale * (vw / 2 - center.x), Math.max(0, (scale - 1) * vw / 2)) : 0;
      const ty = target ? clamp(scale * (vh / 2 - center.y), Math.max(0, (scale - 1) * vh / 2)) : 0;

      body.style.transition = `transform ${durationMs}ms cubic-bezier(0.22,1,0.36,1)`;
      requestAnimationFrame(() => {
        body.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
      });
    },
    { target, scale, durationMs },
  );
  await sleep(durationMs + 40);
}

export const resetCamera = (page: Page, opts: { durationMs?: number } = {}): Promise<void> =>
  camera(page, null, opts);

// ── Cursor ──────────────────────────────────────────────────────────────
export async function showCursor(page: Page): Promise<void> {
  await page.evaluate(() => {
    const c = document.getElementById('__cinema_cursor');
    if (c) c.style.opacity = '1';
  });
}

export async function hideCursor(page: Page): Promise<void> {
  await page.evaluate(() => {
    const c = document.getElementById('__cinema_cursor');
    if (c) c.style.opacity = '0';
  });
}

export async function moveCursorTo(page: Page, x: number, y: number): Promise<void> {
  const durationMs = await page.evaluate(
    ({ x, y }) => {
      const c = document.getElementById('__cinema_cursor') as HTMLElement | null;
      if (!c) return 0;
      const fromX = Number(c.dataset.x ?? x);
      const fromY = Number(c.dataset.y ?? y);
      const dist = Math.hypot(x - fromX, y - fromY);
      const duration = Math.min(900, Math.max(220, dist * 0.55));
      c.style.transition = `transform ${duration}ms cubic-bezier(0.3,0.9,0.3,1)`;
      c.style.transform = `translate(${x}px, ${y}px)`;
      c.dataset.x = String(x);
      c.dataset.y = String(y);
      return duration;
    },
    { x, y },
  );
  await sleep(durationMs + 20);
}

export async function moveCursorToSelector(
  page: Page,
  selector: string,
  opts: { offsetX?: number; offsetY?: number } = {},
): Promise<void> {
  const box = await page.locator(selector).boundingBox().catch(() => null);
  if (!box) return;
  await moveCursorTo(
    page,
    box.x + (opts.offsetX ?? box.width / 2),
    box.y + (opts.offsetY ?? box.height / 2),
  );
}

export async function clickRipple(page: Page, x: number, y: number): Promise<void> {
  await page.evaluate(
    ({ x, y }) => {
      const layer = document.getElementById('__cinema_layer');
      if (!layer) return;
      const ring = document.createElement('div');
      ring.style.cssText = `
        position:fixed;left:${x}px;top:${y}px;transform:translate(-50%,-50%);
        width:34px;height:34px;border-radius:50%;
        border:2px solid rgba(255,255,255,0.85);
        box-shadow:0 0 16px rgba(88,166,255,0.5);
        animation:cinema-ring 480ms ease-out both;pointer-events:none;
      `;
      layer.appendChild(ring);
      window.setTimeout(() => ring.remove(), 520);
    },
    { x, y },
  );
  await sleep(160);
}

// Moves the synthetic cursor onto a real element, ripples, and (unless
// opts.real === false) performs the actual click so interactive app chrome
// (tabs, real buttons) responds — painted mockup buttons should pass
// real:false since they are pointer-events:none by design.
export async function clickSelector(
  page: Page,
  selector: string,
  opts: { real?: boolean; offsetX?: number; offsetY?: number } = {},
): Promise<void> {
  const box = await page.locator(selector).boundingBox().catch(() => null);
  if (!box) return;
  const x = box.x + (opts.offsetX ?? box.width / 2);
  const y = box.y + (opts.offsetY ?? box.height / 2);
  await moveCursorTo(page, x, y);
  await clickRipple(page, x, y);
  if (opts.real !== false) {
    await page.locator(selector).click({ force: true }).catch(() => undefined);
  }
}

// dissolve(): a true cross-dissolve, never a brightness flash. Screenshots
// the current frame, pins it as a full-viewport overlay (exact 1:1 CSS-pixel
// size, so no scaling artifacts), lets the caller swap DOM state underneath
// while it's hidden, then fades the snapshot's opacity 1→0 to reveal the new
// scene. If the screenshot round-trip can't be trusted (no viewport, capture
// failure), it falls back to an instant hard cut — never a partial/half-drawn
// overlay, which would be worse than no transition at all.
export async function dissolve(
  page: Page,
  onCovered?: () => Promise<void> | void,
): Promise<void> {
  const fadeMs = 240;
  const overlayInstalled = await installDissolveSnapshot(page);

  if (onCovered) await onCovered();

  if (!overlayInstalled) return;

  await page.evaluate((fadeMs) => {
    const img = document.getElementById('__cinema_dissolve') as HTMLElement | null;
    if (!img) return;
    img.style.transition = `opacity ${fadeMs}ms cubic-bezier(0.33,0,0.2,1)`;
    void img.offsetWidth;
    img.style.opacity = '0';
  }, fadeMs);
  await sleep(fadeMs + 20);
  await page.evaluate(() => {
    document.getElementById('__cinema_dissolve')?.remove();
  });
}

async function installDissolveSnapshot(page: Page): Promise<boolean> {
  const viewport = page.viewportSize();
  if (!viewport) return false;
  try {
    const png = await page.screenshot({ type: 'png' });
    const dataUrl = `data:image/png;base64,${png.toString('base64')}`;
    await page.evaluate(
      ({ dataUrl, width, height }) => new Promise<void>((resolve) => {
        document.getElementById('__cinema_dissolve')?.remove();
        const img = document.createElement('img');
        img.id = '__cinema_dissolve';
        img.style.cssText = `
          position:fixed;top:0;left:0;width:${width}px;height:${height}px;
          z-index:999999;pointer-events:none;opacity:1;
        `;
        img.onload = () => resolve();
        img.onerror = () => resolve();
        img.src = dataUrl;
        document.documentElement.appendChild(img);
      }),
      { dataUrl, width: viewport.width, height: viewport.height },
    );
    return true;
  } catch {
    return false;
  }
}

// ── Callout card ───────────────────────────────────────────────────────
type CalloutCorner = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';

export interface CalloutOptions {
  n: string;
  title: string;
  body?: string;
  corner: CalloutCorner;
}

export async function callout(page: Page, opts: CalloutOptions): Promise<void> {
  await page.evaluate(
    ({ opts, cardW, margin }) => {
      const layer = document.getElementById('__cinema_layer');
      if (!layer) return;
      document.getElementById('__cinema_callout')?.remove();

      const posStyle = (() => {
        switch (opts.corner) {
          case 'top-left': return `top:${margin}px;left:${margin}px;`;
          case 'top-right': return `top:${margin}px;right:${margin}px;`;
          case 'bottom-right': return `bottom:${margin}px;right:${margin}px;`;
          case 'bottom-left':
          default: return `bottom:${margin}px;left:${margin}px;`;
        }
      })();

      const card = document.createElement('div');
      card.id = '__cinema_callout';
      card.style.cssText = `
        position:fixed;${posStyle}
        z-index:99999;pointer-events:none;
        width:${cardW}px;padding:18px 20px 20px;border-radius:16px;
        background:rgba(10,12,18,0.78);
        -webkit-backdrop-filter:blur(14px);backdrop-filter:blur(14px);
        border:1px solid rgba(255,255,255,0.10);
        box-shadow:0 24px 60px -16px rgba(0,0,0,0.55);
        font-family:'Inter',-apple-system,sans-serif;color:#e6edf3;
        animation:cinema-callout-in 260ms cubic-bezier(0.22,1,0.36,1) both;
      `;
      card.innerHTML = `
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px;">
          <span style="display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;border-radius:7px;background:linear-gradient(135deg,#7BB5FF 0%,#58a6ff 45%,#B388FF 100%);color:#0a0a0c;font-size:11px;font-weight:700;">${opts.n}</span>
          <span style="width:28px;height:2px;border-radius:1px;background:linear-gradient(90deg,#58a6ff,transparent);"></span>
        </div>
        <div style="font-size:18px;font-weight:600;line-height:1.3;letter-spacing:-0.01em;margin-bottom:${opts.body ? '8px' : '0'};">${opts.title}</div>
        ${opts.body ? `<div style="font-size:13px;line-height:1.55;color:rgba(230,237,243,0.7);">${opts.body}</div>` : ''}
      `;
      layer.appendChild(card);
    },
    { opts, cardW: CALLOUT_WIDTH, margin: CALLOUT_MARGIN },
  );
  await sleep(280);
}

export async function hideCallout(page: Page): Promise<void> {
  await page.evaluate(() => {
    const el = document.getElementById('__cinema_callout');
    if (!el) return;
    el.style.animation = 'cinema-callout-out 180ms ease both';
    window.setTimeout(() => el.remove(), 190);
  });
  await sleep(200);
}

// ── Vignette (secondary emphasis tool — lighter than a full camera move) ──
export async function vignetteSpotlight(
  page: Page,
  opts: { x: number; y: number; radius?: number; falloff?: number; intensity?: number },
): Promise<void> {
  await page.evaluate(({ x, y, radius, falloff, intensity }) => {
    const layer = document.getElementById('__cinema_layer');
    if (!layer) return;
    document.getElementById('__cinema_vignette_spot')?.remove();
    // Tuned to read as emphasis, not a blackout: a tight hole plus a steep
    // 0.55 scrim buried ~60% of the fleet shot in near-black, so the frame
    // looked broken rather than focused. A wider hole, a longer falloff and a
    // lighter floor keep the surrounding panes legible.
    const r = radius ?? 240;
    const f = falloff ?? 620;
    const i = intensity ?? 0.32;
    const v = document.createElement('div');
    v.id = '__cinema_vignette_spot';
    v.style.cssText = `
      position:fixed;inset:0;z-index:99996;pointer-events:none;
      background: radial-gradient(circle ${f}px at ${x}px ${y}px,
        transparent 0, transparent ${r}px,
        rgba(0,0,0,${i}) ${f}px, rgba(0,0,0,${Math.min(0.85, i + 0.2)}) 100%);
      opacity:0;transition:opacity 380ms cubic-bezier(0.22,1,0.36,1);
    `;
    layer.appendChild(v);
    void v.offsetWidth;
    v.style.opacity = '1';
  }, opts);
}

export async function vignetteSpotlightOff(page: Page): Promise<void> {
  await page.evaluate(() => {
    const v = document.getElementById('__cinema_vignette_spot');
    if (!v) return;
    v.style.opacity = '0';
    window.setTimeout(() => v.remove(), 400);
  });
  await sleep(420);
}

// ── Animation utilities ───────────────────────────────────────────────
export async function tickCounter(
  page: Page,
  selector: string,
  opts: { from?: number; to: number; duration?: number; format?: 'plain' | 'k' | 'comma' },
): Promise<void> {
  await page.evaluate(
    ({ sel, from, to, duration, format }) => {
      const el = document.querySelector(sel) as HTMLElement | null;
      if (!el) return;
      const start = performance.now();
      const fmt = (v: number) => {
        if (format === 'k') return `${(v / 1000).toFixed(1)}k`;
        if (format === 'comma') return Math.round(v).toLocaleString('en-US');
        return String(Math.round(v));
      };
      const ease = (p: number) => 1 - Math.pow(1 - p, 5);
      const step = (now: number) => {
        const p = Math.min(1, (now - start) / duration);
        el.textContent = fmt(from + (to - from) * ease(p));
        if (p < 1) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    },
    { sel: selector, from: opts.from ?? 0, to: opts.to, duration: opts.duration ?? 720, format: opts.format ?? 'plain' },
  );
  await sleep((opts.duration ?? 720) + 40);
}

export async function staggerChildren(
  page: Page,
  selector: string,
  opts: { offsetMs?: number; durationMs?: number } = {},
): Promise<void> {
  await page.evaluate(
    ({ sel, offset, dur }) => {
      const host = document.querySelector(sel) as HTMLElement | null;
      if (!host) return;
      Array.from(host.children).forEach((k, i) => {
        const el = k as HTMLElement;
        el.style.opacity = '0';
        el.style.transform = 'translateY(12px)';
        el.style.animation = `cinema-stagger-row ${dur}ms cubic-bezier(0.22,1,0.36,1) ${i * offset}ms both`;
      });
    },
    { sel: selector, offset: opts.offsetMs ?? 55, dur: opts.durationMs ?? 300 },
  );
}

export async function typeIntoElement(
  page: Page,
  selector: string,
  text: string,
  opts: { msPerChar?: number; caret?: boolean } = {},
): Promise<void> {
  const msPerChar = opts.msPerChar ?? 34;
  const total = msPerChar * text.length + 200;
  await page.evaluate(
    ({ sel, txt, ms, caret }) => {
      const el = document.querySelector(sel) as HTMLElement | null;
      if (!el) return;
      el.textContent = '';
      const caretEl = document.createElement('span');
      if (caret) {
        caretEl.textContent = '▎';
        caretEl.style.cssText = 'color:#58a6ff;margin-left:2px;animation:cinema-caret-blink 980ms steps(1,end) infinite;';
        el.appendChild(caretEl);
      }
      const chars = Array.from(txt);
      let i = 0;
      const tick = () => {
        if (i >= chars.length) return;
        el.insertBefore(document.createTextNode(chars[i]), caretEl);
        i++;
        window.setTimeout(tick, ms);
      };
      tick();
    },
    { sel: selector, txt: text, ms: msPerChar, caret: opts.caret ?? true },
  );
  await sleep(total);
}

const CINEMA_CSS = `
  @keyframes cinema-fade-in { from { opacity: 0; } to { opacity: 1; } }
  @keyframes cinema-fade-out { from { opacity: 1; } to { opacity: 0; } }
  @keyframes cinema-card-in {
    0% { opacity: 0; transform: translateY(18px) scale(0.98); }
    100% { opacity: 1; transform: translateY(0) scale(1); }
  }
  @keyframes cinema-callout-in {
    0% { opacity: 0; transform: translateY(12px); }
    100% { opacity: 1; transform: translateY(0); }
  }
  @keyframes cinema-callout-out { from { opacity: 1; } to { opacity: 0; } }
  @keyframes cinema-rise-in {
    0% { opacity: 0; transform: translateY(8px); }
    100% { opacity: 1; transform: translateY(0); }
  }
  @keyframes cinema-stagger-row {
    0% { opacity: 0; transform: translateY(12px); }
    100% { opacity: 1; transform: translateY(0); }
  }
  @keyframes cinema-orb-pulse {
    0%, 100% { transform: scale(1); opacity: 0.18; }
    50% { transform: scale(1.12); opacity: 0.28; }
  }
  @keyframes cinema-ring {
    0% { transform: translate(-50%,-50%) scale(0.5); opacity: 0.7; }
    100% { transform: translate(-50%,-50%) scale(1.8); opacity: 0; }
  }
  @keyframes cinema-cursor-pulse {
    0%, 100% { opacity: 1; } 50% { opacity: 0.85; }
  }
  @keyframes cinema-caret-blink {
    0%, 49% { opacity: 1; } 50%, 100% { opacity: 0; }
  }
`;
