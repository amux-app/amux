import type { Page } from 'playwright';

const SIDEBAR_SELECTOR = '[data-testid="app-shell-sidebar"]';

export interface IdentityRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

// Overlays are position:fixed children of the cinema-transformed <body>, so
// they are laid out in that body's *untransformed* coordinate space. Any rect
// they are positioned from must therefore be read with the transform stripped
// — the same technique camera() and measureUnionRect() use — or the overlay
// lands offset by the current camera move.
export async function measureIdentityRect(page: Page, selector: string): Promise<IdentityRect | null> {
  return page.evaluate((sel) => {
    const body = document.body;
    const prevTransition = body.style.transition;
    const prevTransform = body.style.transform;
    body.style.transition = 'none';
    body.style.transform = 'none';
    const el = document.querySelector(sel);
    const rect = el?.getBoundingClientRect();
    const identity = rect
      ? { x: rect.left, y: rect.top, width: rect.width, height: rect.height }
      : null;
    body.style.transform = prevTransform;
    body.style.transition = prevTransition;
    return identity;
  }, selector);
}

// Full-bleed overlays (marketplace, review pane) must start exactly where the
// real sidebar ends, or they slice it mid-word. A hardcoded rail width can't
// do that — the sidebar is resizable and collapsible — so it is measured live.
export async function measureContentLeft(page: Page): Promise<number> {
  const rect = await measureIdentityRect(page, SIDEBAR_SELECTOR);
  return rect ? Math.round(rect.x + rect.width) : 0;
}
