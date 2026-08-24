import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';

interface HoverCardProps {
  trigger: ReactNode;
  children: ReactNode | ((state: { pinned: boolean }) => ReactNode);
  width?: number;
  align?: 'left' | 'right';
  triggerClassName?: string;
  cardClassName?: string;
  ariaLabel?: string;
  openDelayMs?: number;
  closeDelayMs?: number;
}

const DEFAULT_WIDTH = 320;
const DEFAULT_OPEN_DELAY = 80;
const DEFAULT_CLOSE_DELAY = 180;
const VIEWPORT_MARGIN = 8;
const HOVER_BRIDGE = 10;

export function HoverCard({
  trigger,
  children,
  width = DEFAULT_WIDTH,
  align = 'right',
  triggerClassName,
  cardClassName,
  ariaLabel,
  openDelayMs = DEFAULT_OPEN_DELAY,
  closeDelayMs = DEFAULT_CLOSE_DELAY,
}: HoverCardProps) {
  const anchorRef = useRef<HTMLButtonElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const openTimerRef = useRef<number | null>(null);
  const closeTimerRef = useRef<number | null>(null);
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [coords, setCoords] = useState<{ top: number; left: number } | null>(null);
  const cardId = useId();

  const clearTimers = useCallback(() => {
    if (openTimerRef.current !== null) {
      window.clearTimeout(openTimerRef.current);
      openTimerRef.current = null;
    }
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  }, []);

  const scheduleOpen = useCallback(() => {
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
    if (open) return;
    openTimerRef.current = window.setTimeout(() => setOpen(true), openDelayMs);
  }, [open, openDelayMs]);

  const scheduleClose = useCallback(() => {
    if (pinned) return;
    if (openTimerRef.current !== null) {
      window.clearTimeout(openTimerRef.current);
      openTimerRef.current = null;
    }
    closeTimerRef.current = window.setTimeout(() => setOpen(false), closeDelayMs);
  }, [pinned, closeDelayMs]);

  useEffect(() => clearTimers, [clearTimers]);

  useLayoutEffect(() => {
    if (!open) return;
    const anchor = anchorRef.current;
    if (!anchor) return;
    const rect = anchor.getBoundingClientRect();
    const desiredLeft = align === 'right' ? rect.right - width : rect.left;
    const left = Math.max(
      VIEWPORT_MARGIN,
      Math.min(desiredLeft, window.innerWidth - width - VIEWPORT_MARGIN),
    );
    setCoords({ top: rect.bottom + HOVER_BRIDGE, left });
  }, [open, align, width]);

  useEffect(() => {
    if (!open || !pinned) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (anchorRef.current?.contains(target)) return;
      if (cardRef.current?.contains(target)) return;
      setPinned(false);
      setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open, pinned]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent | globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (pinned) event.stopPropagation();
        setPinned(false);
        setOpen(false);
        anchorRef.current?.focus();
      }
    };
    document.addEventListener('keydown', onKey as (event: globalThis.KeyboardEvent) => void);
    return () =>
      document.removeEventListener('keydown', onKey as (event: globalThis.KeyboardEvent) => void);
  }, [open, pinned]);

  const togglePinned = () => {
    setPinned((prev) => {
      const next = !prev;
      if (next) setOpen(true);
      return next;
    });
  };

  const cardStyle: CSSProperties | undefined = coords
    ? { top: coords.top, left: coords.left, width }
    : undefined;

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        className={triggerClassName}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? cardId : undefined}
        aria-label={ariaLabel}
        onMouseEnter={scheduleOpen}
        onMouseLeave={scheduleClose}
        onFocus={scheduleOpen}
        onBlur={scheduleClose}
        onClick={togglePinned}
      >
        {trigger}
      </button>
      {open && coords &&
        createPortal(
          <div
            ref={cardRef}
            id={cardId}
            role={pinned ? 'dialog' : 'tooltip'}
            aria-label={ariaLabel}
            className={cardClassName}
            style={cardStyle}
            onMouseEnter={scheduleOpen}
            onMouseLeave={scheduleClose}
          >
            {typeof children === 'function' ? children({ pinned }) : children}
          </div>,
          document.body,
        )}
    </>
  );
}
