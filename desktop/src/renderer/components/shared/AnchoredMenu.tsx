import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FocusEvent, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '../../lib/cn';
import { restoreFocusTo } from './focus-restore';

export type AnchoredMenuAlign = 'end' | 'start';
export type AnchoredMenuRole = 'dialog' | 'menu';

export interface AnchoredMenuProps {
  /** Horizontal edge aligned to the trigger before clamping. */
  align?: AnchoredMenuAlign;
  children: ReactNode;
  /** Surface styling — size, border, background. Positioning is owned by this component. */
  className?: string;
  label?: string;
  onClose: () => void;
  open: boolean;
  role?: AnchoredMenuRole;
  triggerRef: RefObject<HTMLElement | null>;
}

interface Coords {
  left: number;
  top: number;
}

const ENABLED_ITEM_FILTER = ':not([disabled]):not([aria-disabled="true"])';
const ENABLED_ITEM_SELECTOR =
  `[role="menuitem"]${ENABLED_ITEM_FILTER},[role="menuitemradio"]${ENABLED_ITEM_FILTER}`;
const NAV_DELTA: Record<string, number> = { ArrowDown: 1, ArrowUp: -1 };
const SURFACE_CLASS = 'fixed z-50';
const TABBABLE_SELECTOR = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';
const TRIGGER_GAP = 4;
const VIEWPORT_MARGIN = 8;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

function horizontalOffset(anchor: DOMRect, width: number, align: AnchoredMenuAlign): number {
  const preferred = align === 'start' ? anchor.left : anchor.right - width;
  return clamp(preferred, VIEWPORT_MARGIN, window.innerWidth - width - VIEWPORT_MARGIN);
}

// Below the trigger by default; flips above only when the surface does not fit
// below and there is room above. Either way the result stays inside the margin.
function verticalOffset(anchor: DOMRect, height: number): number {
  const below = anchor.bottom + TRIGGER_GAP;
  const above = anchor.top - TRIGGER_GAP - height;
  const fitsBelow = below + height <= window.innerHeight - VIEWPORT_MARGIN;
  const preferred = fitsBelow || above < VIEWPORT_MARGIN ? below : above;
  return clamp(preferred, VIEWPORT_MARGIN, window.innerHeight - height - VIEWPORT_MARGIN);
}

function enabledItems(surface: HTMLElement | null): HTMLElement[] {
  return Array.from(surface?.querySelectorAll<HTMLElement>(ENABLED_ITEM_SELECTOR) ?? []);
}

function focusInitialTarget(surface: HTMLElement | null, role: AnchoredMenuRole): void {
  if (!surface) return;
  const first = role === 'menu'
    ? enabledItems(surface)[0]
    : surface.querySelector<HTMLElement>(TABBABLE_SELECTOR);
  (first ?? surface).focus();
}

// Focus goes back to the trigger only when the surface still owned it, so a
// close caused by clicking elsewhere never steals focus from that target.
function shouldRestoreFocus(focusInside: boolean): boolean {
  const active = document.activeElement;
  return focusInside || active === null || active === document.body;
}

function nextIndex(current: number, delta: number, count: number): number {
  if (current === -1) return delta > 0 ? 0 : count - 1;
  return (current + delta + count) % count;
}

function navTargetIndex(key: string, items: HTMLElement[]): number | null {
  if (key === 'Home') return 0;
  if (key === 'End') return items.length - 1;
  const delta = NAV_DELTA[key];
  if (delta === undefined) return null;
  return nextIndex(items.indexOf(document.activeElement as HTMLElement), delta, items.length);
}

function handleMenuNavigation(event: KeyboardEvent<HTMLDivElement>, surface: HTMLElement | null): void {
  const items = enabledItems(surface);
  if (items.length === 0) return;
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    items.find((item) => item === document.activeElement)?.click();
    return;
  }
  const target = navTargetIndex(event.key, items);
  if (target === null) return;
  event.preventDefault();
  items[target].focus();
}

/**
 * Body-level popup anchored to a trigger. Panel layouts wrap pane content in
 * `overflow:hidden` wrappers, so an in-tree popup is clipped no matter its
 * z-index — everything here exists so the surface escapes that subtree while
 * still tracking the trigger it belongs to.
 */
export function AnchoredMenu({
  align = 'end',
  children,
  className,
  label,
  onClose,
  open,
  role = 'menu',
  triggerRef,
}: Readonly<AnchoredMenuProps>) {
  const closeRef = useRef(onClose);
  const focusInsideRef = useRef(false);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const [coords, setCoords] = useState<Coords>({ left: 0, top: 0 });

  useEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);

  const reposition = useCallback(() => {
    const trigger = triggerRef.current;
    const surface = surfaceRef.current;
    if (!trigger || !surface) return;
    const anchor = trigger.getBoundingClientRect();
    const { height, width } = surface.getBoundingClientRect();
    const next = { left: horizontalOffset(anchor, width, align), top: verticalOffset(anchor, height) };
    setCoords((prev) => (prev.left === next.left && prev.top === next.top ? prev : next));
  }, [align, triggerRef]);

  useLayoutEffect(() => {
    if (!open) return;
    reposition();
    // Capture phase so a scroll on any ancestor — not just the viewport — re-anchors.
    document.addEventListener('scroll', reposition, true);
    window.addEventListener('resize', reposition);
    return () => {
      document.removeEventListener('scroll', reposition, true);
      window.removeEventListener('resize', reposition);
    };
  }, [open, reposition]);

  useEffect(() => {
    if (!open) return;
    const trigger = triggerRef.current;
    focusInitialTarget(surfaceRef.current, role);
    focusInsideRef.current = true;
    // A press on the trigger is left to the trigger's own toggle, otherwise the
    // menu would close here and reopen on the following click.
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target || surfaceRef.current?.contains(target) || trigger?.contains(target)) return;
      closeRef.current();
    };
    document.addEventListener('pointerdown', handlePointerDown, true);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown, true);
      if (shouldRestoreFocus(focusInsideRef.current)) restoreFocusTo(trigger);
      focusInsideRef.current = false;
    };
  }, [open, role, triggerRef]);

  const handleBlur = (event: FocusEvent<HTMLDivElement>) => {
    const next = event.relatedTarget;
    if (next instanceof Node && surfaceRef.current?.contains(next)) return;
    focusInsideRef.current = false;
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (role === 'menu' && event.key === 'Tab') {
      closeRef.current();
      return;
    }
    if (event.key === 'Escape') {
      event.stopPropagation();
      closeRef.current();
      return;
    }
    if (role === 'menu') handleMenuNavigation(event, surfaceRef.current);
  };

  if (!open) return null;

  return createPortal(
    <div
      ref={surfaceRef}
      role={role}
      aria-label={label}
      tabIndex={-1}
      className={cn(SURFACE_CLASS, className)}
      style={{ left: coords.left, top: coords.top }}
      onBlur={handleBlur}
      onFocus={() => { focusInsideRef.current = true; }}
      onKeyDown={handleKeyDown}
    >
      {children}
    </div>,
    document.body,
  );
}
