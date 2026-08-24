import { useCallback, useEffect, useId, useRef, useState, type FocusEvent, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

interface HoverTooltipProps {
  label: ReactNode;
  children: ReactNode;
  className?: string;
  enabled?: boolean;
  /** Hover dwell before the tooltip opens. 0 opens on contact; list rows use a delay so a scan across them stays quiet. */
  openDelayMs?: number;
  /** Force-closes the tooltip and keeps it closed — for when the trigger owns a popup that the tooltip would cover. */
  suppressed?: boolean;
  align?: 'start' | 'center' | 'end';
}

const CLOSE_DELAY_MS = 120;
const FOCUSABLE_SELECTOR = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';
const TOOLTIP_MAX_WIDTH = 280;
const TOOLTIP_MARGIN = 8;
const TOOLTIP_OFFSET = 6;

type Activity = { dismissed: boolean; focus: boolean; pointer: boolean; tooltip: boolean };
type ActivitySource = 'focus' | 'pointer' | 'tooltip';
type TooltipCoords = { top: number; left: number };

function shouldShow(activity: Activity): boolean {
  return !activity.dismissed && (activity.focus || activity.pointer || activity.tooltip);
}

function describedTarget(anchor: HTMLElement): HTMLElement {
  return anchor.querySelector<HTMLElement>(FOCUSABLE_SELECTOR) ?? anchor;
}

function describedIds(target: HTMLElement): string[] {
  return (target.getAttribute('aria-describedby') ?? '').split(' ').filter(Boolean);
}

export function HoverTooltip({ label, children, className, enabled = true, openDelayMs = 0, suppressed = false, align = 'start' }: HoverTooltipProps) {
  const anchorRef = useRef<HTMLSpanElement>(null);
  const activityRef = useRef<Activity>({ dismissed: false, focus: false, pointer: false, tooltip: false });
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const openTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [coords, setCoords] = useState<TooltipCoords | null>(null);
  const tooltipId = useId();
  const visible = coords !== null;

  const cancelClose = useCallback(() => {
    if (closeTimerRef.current === null) return;
    clearTimeout(closeTimerRef.current);
    closeTimerRef.current = null;
  }, []);

  const cancelOpen = useCallback(() => {
    if (openTimerRef.current === null) return;
    clearTimeout(openTimerRef.current);
    openTimerRef.current = null;
  }, []);

  const closeNow = useCallback(() => {
    cancelOpen();
    cancelClose();
    setCoords(null);
  }, [cancelClose, cancelOpen]);

  // Closing is deferred so the pointer can cross the gap between the trigger
  // and the tooltip without the tooltip vanishing mid-travel (WCAG 1.4.13).
  const scheduleClose = useCallback(() => {
    if (closeTimerRef.current !== null) return;
    closeTimerRef.current = setTimeout(() => {
      closeTimerRef.current = null;
      setCoords(null);
    }, CLOSE_DELAY_MS);
  }, []);

  const openNow = useCallback(() => {
    const el = anchorRef.current;
    if (!el || !shouldShow(activityRef.current)) return;
    if (!enabled && el.scrollWidth <= el.clientWidth) return;
    cancelClose();
    const rect = el.getBoundingClientRect();

    // Provisional placement. For align='start' this is final. For center/end,
    // we correct once the tooltip node actually mounts (see tooltipRefCallback).
    const next = {
      top: rect.bottom + TOOLTIP_OFFSET,
      left: Math.max(TOOLTIP_MARGIN, Math.min(rect.left, window.innerWidth - TOOLTIP_MAX_WIDTH - TOOLTIP_MARGIN)),
    };
    setCoords((prev) => prev ?? next);
  }, [cancelClose, enabled]);

  const sync = useCallback(() => {
    if (suppressed) {
      closeNow();
      return;
    }
    if (!shouldShow(activityRef.current)) {
      cancelOpen();
      // Leaving mid-dwell cancels the pending open; only an on-screen tooltip
      // needs the grace delay that lets the pointer travel onto it.
      if (visible) scheduleClose();
      return;
    }
    // Keyboard focus must announce the tooltip immediately — a sighted mouse
    // user can wait out a dwell, but a keyboard user has no other cue.
    if (activityRef.current.focus) {
      cancelOpen();
      openNow();
      return;
    }
    // Already on screen: the pointer came back during the close grace, so hold
    // it up instead of making the user serve the dwell delay again.
    if (openDelayMs <= 0 || visible) {
      openNow();
      return;
    }
    if (openTimerRef.current !== null) return;
    openTimerRef.current = setTimeout(() => {
      openTimerRef.current = null;
      openNow();
    }, openDelayMs);
  }, [cancelOpen, closeNow, openDelayMs, openNow, scheduleClose, suppressed, visible]);

  useEffect(() => {
    if (suppressed) closeNow();
  }, [closeNow, suppressed]);

  const setActivity = useCallback((source: ActivitySource, active: boolean) => {
    const activity = activityRef.current;
    activity[source] = active;
    if (!activity.focus && !activity.pointer && !activity.tooltip) activity.dismissed = false;
    sync();
  }, [sync]);

  // Pointer-driven focus (a click focuses the trigger) must not pin the tooltip
  // open after the pointer leaves — only keyboard-arriving focus does.
  const handleFocus = useCallback(() => {
    if (!activityRef.current.pointer) setActivity('focus', true);
  }, [setActivity]);

  const handleBlur = useCallback((event: FocusEvent<HTMLSpanElement>) => {
    const next = event.relatedTarget;
    if (next instanceof Node && anchorRef.current?.contains(next)) return;
    setActivity('focus', false);
  }, [setActivity]);

  // The surface is hit-testable so the pointer can reach it, which also lets it
  // swallow a press aimed at whatever sits in the band below the trigger. That
  // first press dismisses the tooltip instead, clearing the way for the next one.
  const handleTooltipPointerDown = useCallback(() => {
    activityRef.current.tooltip = false;
    closeNow();
  }, [closeNow]);

  const handleKeyDownCapture = useCallback((event: KeyboardEvent<HTMLSpanElement>) => {
    if (event.key !== 'Escape' || !visible) return;
    event.stopPropagation();
    activityRef.current.dismissed = true;
    closeNow();
  }, [closeNow, visible]);

  useEffect(() => () => {
    cancelClose();
    cancelOpen();
  }, [cancelClose, cancelOpen]);

  // Ref callback: fires with the tooltip element the moment it's attached to
  // the DOM. Using a callback (instead of a useRef + rAF) guarantees the node
  // is present when we measure it, no matter React's commit timing.
  const tooltipRefCallback = useCallback((node: HTMLSpanElement | null) => {
    if (!node || align === 'start') return;
    const anchor = anchorRef.current;
    if (!anchor) return;
    const anchorRect = anchor.getBoundingClientRect();
    const tipRect = node.getBoundingClientRect();
    const targetLeft = align === 'center'
      ? anchorRect.left + anchorRect.width / 2 - tipRect.width / 2
      : anchorRect.right - tipRect.width;
    const clamped = Math.max(
      TOOLTIP_MARGIN,
      Math.min(targetLeft, window.innerWidth - tipRect.width - TOOLTIP_MARGIN),
    );
    const nextTop = anchorRect.bottom + TOOLTIP_OFFSET;
    // Only re-render if measurement actually differs — avoids an update loop.
    setCoords((prev) => (
      prev && Math.abs(prev.left - clamped) < 0.5 && Math.abs(prev.top - nextTop) < 0.5
        ? prev
        : { top: nextTop, left: clamped }
    ));
  }, [align]);

  // The description is advertised only while the tooltip is on screen, and our
  // id is composed with (never replaces) whatever the caller already set.
  useEffect(() => {
    const anchor = anchorRef.current;
    if (!visible || !anchor) return;
    const target = describedTarget(anchor);
    const ids = describedIds(target);
    if (!ids.includes(tooltipId)) target.setAttribute('aria-describedby', [...ids, tooltipId].join(' '));
    return () => {
      const remaining = describedIds(target).filter((id) => id !== tooltipId);
      if (remaining.length > 0) target.setAttribute('aria-describedby', remaining.join(' '));
      else target.removeAttribute('aria-describedby');
    };
  }, [tooltipId, visible]);

  return (
    <span
      ref={anchorRef}
      className={className ?? 'inline-flex'}
      onBlur={handleBlur}
      onFocus={handleFocus}
      onKeyDownCapture={handleKeyDownCapture}
      onMouseEnter={() => setActivity('pointer', true)}
      onMouseLeave={() => setActivity('pointer', false)}
    >
      {children}
      {coords &&
        createPortal(
          <span
            ref={tooltipRefCallback}
            id={tooltipId}
            role="tooltip"
            className="fixed z-50 rounded-md border border-[var(--border)] bg-[var(--surface-raised)] px-2 py-1 text-[11px] font-medium text-[var(--text)] shadow-xl"
            style={{ top: coords.top, left: coords.left, maxWidth: TOOLTIP_MAX_WIDTH }}
            onMouseEnter={() => setActivity('tooltip', true)}
            onMouseLeave={() => setActivity('tooltip', false)}
            onPointerDown={handleTooltipPointerDown}
          >
            {label}
          </span>,
          document.body,
        )}
    </span>
  );
}
