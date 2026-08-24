import { AnimatePresence, motion, type HTMLMotionProps } from 'motion/react';
import { useEffect, useRef, type ReactNode, type RefObject } from 'react';
import { MODAL_SURFACE_Z_CLASS } from '../../lib/constants';
import { restoreFocusTo } from './focus-restore';

export type ModalMotionPreset = Pick<HTMLMotionProps<'div'>, 'animate' | 'exit' | 'initial' | 'transition'>;

interface ModalSurfaceProps {
  children: ReactNode;
  /** Backdrop clicks close the surface. Opt in only where that is already the product behavior. */
  closeOnBackdropClick?: boolean;
  /** Focused when the surface opens; falls back to the first tabbable node, then the panel itself. */
  initialFocusRef?: RefObject<HTMLElement | null>;
  /** Accessible name for surfaces without a visible title. Ignored when `labelledBy` is set. */
  label?: string;
  /** Id of the visible title element that names the dialog. */
  labelledBy?: string;
  onClose: () => void;
  open: boolean;
  panelClassName: string;
  panelMotion?: ModalMotionPreset;
}

const BACKDROP_CLASS = `fixed inset-0 ${MODAL_SURFACE_Z_CLASS} flex items-start justify-center pt-[15vh] bg-black/50 backdrop-blur-sm`;
const BACKDROP_MOTION: ModalMotionPreset = {
  animate: { opacity: 1 },
  exit: { opacity: 0 },
  initial: { opacity: 0 },
  transition: { duration: 0.12 },
};
const DEFAULT_PANEL_MOTION: ModalMotionPreset = {
  animate: { opacity: 1, scale: 1, y: 0 },
  exit: { opacity: 0, scale: 0.96, y: -8 },
  initial: { opacity: 0, scale: 0.96, y: -8 },
  transition: { duration: 0.15, ease: [0.16, 1, 0.3, 1] },
};

const TABBABLE_SELECTOR = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';
const OPEN_MODAL_SELECTOR = '[role="dialog"][aria-modal="true"]';

type SurfaceToken = RefObject<HTMLDivElement | null>;

// Only the most recently opened surface handles Tab and Escape, so stacked
// surfaces can never run two focus traps against the same key press.
const openSurfaces: SurfaceToken[] = [];

/** Lets global key handling yield Escape to whichever surface is on top. */
export function hasOpenModalSurface(): boolean {
  // Legacy dialogs still own their own focus/Escape lifecycle. Recognising
  // their standard modal semantics here prevents one Escape from also reaching
  // global shortcuts while those dialogs are migrated to ModalSurface.
  return openSurfaces.length > 0 || document.querySelector(OPEN_MODAL_SELECTOR) !== null;
}

function tabbablesIn(panel: HTMLElement): HTMLElement[] {
  return Array.from(panel.querySelectorAll<HTMLElement>(TABBABLE_SELECTOR)).filter((el) => el.closest('[hidden]') === null);
}

function focusInitialTarget(panel: HTMLElement | null, preferred: HTMLElement | null): void {
  if (!panel) return;
  const target = (preferred?.isConnected ? preferred : null) ?? tabbablesIn(panel)[0] ?? panel;
  target.focus();
}

function wrapTabFocus(panel: HTMLElement, event: KeyboardEvent): void {
  const tabbables = tabbablesIn(panel);
  if (tabbables.length === 0) {
    event.preventDefault();
    panel.focus();
    return;
  }
  const active = document.activeElement;
  const inside = active instanceof HTMLElement && panel.contains(active);
  const edge = event.shiftKey ? tabbables[0] : tabbables[tabbables.length - 1];
  if (inside && active !== edge) return;
  event.preventDefault();
  (event.shiftKey ? tabbables[tabbables.length - 1] : tabbables[0]).focus();
}

function focusHeldByOpenSurface(): boolean {
  const top = openSurfaces[openSurfaces.length - 1];
  return top?.current?.contains(document.activeElement) ?? false;
}

function restoreFocus(trigger: HTMLElement | null): void {
  if (focusHeldByOpenSurface()) return;
  restoreFocusTo(trigger);
}

function createKeyHandler(token: SurfaceToken, close: () => void): (event: KeyboardEvent) => void {
  return (event: KeyboardEvent) => {
    if (openSurfaces[openSurfaces.length - 1] !== token) return;
    if (event.key === 'Escape') {
      close();
      return;
    }
    if (event.key === 'Tab' && token.current) wrapTabFocus(token.current, event);
  };
}

function triggerElement(): HTMLElement | null {
  const active = document.activeElement;
  return active instanceof HTMLElement && active !== document.body ? active : null;
}

export function ModalSurface({
  children,
  closeOnBackdropClick = false,
  initialFocusRef,
  label,
  labelledBy,
  onClose,
  open,
  panelClassName,
  panelMotion = DEFAULT_PANEL_MOTION,
}: ModalSurfaceProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);

  useEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!open) return;
    openSurfaces.push(panelRef);
    const trigger = triggerElement();
    const frame = requestAnimationFrame(() => focusInitialTarget(panelRef.current, initialFocusRef?.current ?? null));
    const handleKeyDown = createKeyHandler(panelRef, () => closeRef.current());
    document.addEventListener('keydown', handleKeyDown);

    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('keydown', handleKeyDown);
      const index = openSurfaces.lastIndexOf(panelRef);
      if (index !== -1) openSurfaces.splice(index, 1);
      restoreFocus(trigger);
    };
  }, [initialFocusRef, open]);

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          {...BACKDROP_MOTION}
          className={BACKDROP_CLASS}
          onClick={closeOnBackdropClick ? () => closeRef.current() : undefined}
        >
          <motion.div
            {...panelMotion}
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-label={labelledBy ? undefined : label}
            aria-labelledby={labelledBy}
            tabIndex={-1}
            onClick={(event) => event.stopPropagation()}
            className={panelClassName}
          >
            {children}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
