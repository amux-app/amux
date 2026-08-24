import { useCallback, useEffect, useRef, useState } from 'react';
import { motion } from 'motion/react';
import { cn } from '../../lib/cn';
import { useNotificationStore } from '../../stores';
import type { Toast as ToastType } from '../../stores';

const SEVERITY_COLORS: Record<ToastType['severity'], string> = {
  success: 'bg-[var(--success)]',
  error: 'bg-[var(--error)]',
  info: 'bg-[var(--accent)]',
  warning: 'bg-[var(--warning)]',
};

interface ToastProps {
  toast: ToastType;
  onDismiss: (id: string) => void;
}

export function Toast({ toast, onDismiss }: ToastProps) {
  const [paused, setPaused] = useState(false);
  const remainingRef = useRef(toast.dismissMs);
  const startRef = useRef(Date.now());
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const removeToast = useNotificationStore((s) => s.removeToast);
  const hasTitle = Boolean(toast.title);

  const scheduleDismiss = useCallback(() => {
    timerRef.current = setTimeout(() => {
      removeToast(toast.id);
    }, remainingRef.current);
    startRef.current = Date.now();
  }, [removeToast, toast.id]);

  useEffect(() => {
    scheduleDismiss();
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [scheduleDismiss]);

  const handleMouseEnter = () => {
    setPaused(true);
    if (timerRef.current) clearTimeout(timerRef.current);
    const elapsed = Date.now() - startRef.current;
    remainingRef.current = Math.max(remainingRef.current - elapsed, 1000);
  };

  const handleMouseLeave = () => {
    setPaused(false);
    scheduleDismiss();
  };

  return (
    <motion.div
      layout
      initial={{ opacity: 0, x: 40 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: 40 }}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      className={cn(
        'group relative flex items-center gap-2 px-3 py-2 rounded-md overflow-hidden',
        'bg-[var(--surface-raised)]/90 backdrop-blur-md',
        'border border-[var(--border)]/60',
        'shadow-sm min-w-[240px] max-w-[380px]',
      )}
    >
      <span
        className={cn(
          'h-1.5 w-1.5 rounded-full shrink-0',
          SEVERITY_COLORS[toast.severity],
        )}
      />

      <div className="flex-1 min-w-0">
        {hasTitle ? (
          <>
            <p className="text-xs font-medium text-[var(--text)] leading-tight">
              {toast.title}
            </p>
            <p className="text-[11px] text-[var(--text-muted)] mt-px leading-snug">
              {toast.detail ?? toast.message}
            </p>
          </>
        ) : (
          <p className="text-xs text-[var(--text)]">{toast.message}</p>
        )}
      </div>

      <button
        onClick={() => onDismiss(toast.id)}
        className="min-w-4 min-h-4 flex items-center justify-center text-[var(--text-muted)] hover:text-[var(--text)] text-[10px] shrink-0"
        aria-label="Dismiss"
      >
        &times;
      </button>

      <div className="absolute bottom-0 left-0 right-0 h-px bg-[var(--border)]/20">
        <motion.div
          className={cn('h-full origin-left', SEVERITY_COLORS[toast.severity])}
          initial={{ scaleX: 1 }}
          animate={{ scaleX: paused ? undefined : 0 }}
          transition={paused ? undefined : {
            duration: remainingRef.current / 1000,
            ease: 'linear',
          }}
          style={paused ? { animationPlayState: 'paused' } : undefined}
        />
      </div>
    </motion.div>
  );
}
