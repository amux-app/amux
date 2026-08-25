import type { Page } from 'playwright';

const SIDEBAR_SELECTOR = '[data-testid="app-shell-sidebar"]';

export interface IdentityRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

// Overlays are position:fixed children of the cinema-transformed <body>, so they
// lay out in its untransformed space — read rects with the transform stripped.
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

// Full-bleed overlays start where the sidebar ends. Measured, not hardcoded:
// the sidebar is resizable and collapsible.
export async function measureContentLeft(page: Page): Promise<number> {
  const rect = await measureIdentityRect(page, SIDEBAR_SELECTOR);
  return rect ? Math.round(rect.x + rect.width) : 0;
}
