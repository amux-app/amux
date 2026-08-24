import { motion, AnimatePresence } from 'motion/react';
import { useEffect, useId, useRef } from 'react';
import { cn } from '../../lib/cn';
import { restoreFocusTo } from './focus-restore';

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
  danger?: boolean;
  initialFocus?: 'cancel' | 'confirm';
  pending?: boolean;
  restoreFocusTarget?: () => HTMLElement | null | undefined;
}

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  onConfirm,
  onCancel,
  danger = false,
  initialFocus = 'confirm',
  pending = false,
  restoreFocusTarget,
}: ConfirmDialogProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const restoreFocusTargetRef = useRef(restoreFocusTarget);
  const messageId = useId();
  const titleId = useId();
  restoreFocusTargetRef.current = restoreFocusTarget;

  useEffect(() => {
    if (!open) return;
    const active = document.activeElement;
    previousFocusRef.current = active instanceof HTMLElement ? active : null;
    return () => {
      const target = restoreFocusTargetRef.current?.();
      restoreFocusTo(target === undefined ? previousFocusRef.current : target);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const target = pending
      ? dialogRef.current
      : (initialFocus === 'cancel' ? cancelRef.current : confirmRef.current);
    target?.focus();
  }, [initialFocus, open, pending]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        if (!pending) onCancel();
        return;
      }
      if (e.key !== 'Tab') return;
      if (pending) {
        e.preventDefault();
        dialogRef.current?.focus();
        return;
      }
      const cancel = cancelRef.current;
      const confirm = confirmRef.current;
      if (!cancel || !confirm) return;
      const active = document.activeElement;
      if (e.shiftKey ? active === cancel : active === confirm) {
        e.preventDefault();
        (e.shiftKey ? confirm : cancel).focus();
      } else if (active !== cancel && active !== confirm) {
        e.preventDefault();
        cancel.focus();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, onCancel, pending]);

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
          onClick={pending ? undefined : onCancel}
        >
          <motion.div
            ref={dialogRef}
            role="dialog"
            aria-busy={pending || undefined}
            aria-modal="true"
            aria-describedby={messageId}
            aria-labelledby={titleId}
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.95 }}
            onClick={(e) => e.stopPropagation()}
            tabIndex={pending ? -1 : undefined}
            className="bg-[var(--surface-raised)] border border-[var(--border)] rounded-xl p-6 w-full max-w-[400px] shadow-2xl"
          >
            <h2 id={titleId} className="text-sm font-semibold text-[var(--text)]">{title}</h2>
            <p id={messageId} className="mt-2 text-xs text-[var(--text-secondary)] leading-relaxed">{message}</p>
            <div className="mt-5 flex justify-end gap-2">
              <button
                ref={cancelRef}
                type="button"
                disabled={pending}
                onClick={onCancel}
                className="px-3 py-1.5 rounded-md text-xs font-medium text-[var(--text-secondary)] hover:bg-[var(--surface)] transition-colors disabled:cursor-wait disabled:opacity-50"
              >
                {cancelLabel}
              </button>
              <button
                ref={confirmRef}
                type="button"
                disabled={pending}
                onClick={onConfirm}
                className={cn(
                  'px-3 py-1.5 rounded-md text-xs font-medium text-white transition-opacity hover:opacity-90 disabled:cursor-wait disabled:opacity-50',
                  danger ? 'bg-[var(--error)]' : 'bg-[var(--accent)]',
                )}
              >
                {confirmLabel}
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
