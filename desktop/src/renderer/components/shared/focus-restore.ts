/**
 * Focus returns to whichever element opened the surface. When that element is gone by close time,
 * focus falls back to the AppShell root — the only always-mounted container in the renderer — which
 * is made programmatically focusable so keyboard users resume at the top of the app. `document.body`
 * is the last resort when no shell is mounted (isolated renders and tests).
 */
const FOCUS_FALLBACK_SELECTOR = '[data-testid="app-shell"]';

export function restoreFocusTo(trigger: HTMLElement | null): void {
  if (trigger?.isConnected) {
    trigger.focus();
    return;
  }
  const fallback = document.querySelector<HTMLElement>(FOCUS_FALLBACK_SELECTOR);
  if (!fallback) {
    document.body.focus();
    return;
  }
  if (!fallback.hasAttribute('tabindex')) fallback.setAttribute('tabindex', '-1');
  fallback.focus();
}
