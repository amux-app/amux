import { useEffect, useRef } from 'react';
import type { NormalizedMessage } from '../../shared/agent-session-types';
import { useUiStore } from '../stores';

interface ScrollToMessageOptions {
  containerRef: React.RefObject<HTMLDivElement | null>;
  markProgrammaticScroll?: () => void;
  visibleMessages: NormalizedMessage[];
  setAutoScroll: (v: boolean) => void;
}

export function useScrollToMessage({
  containerRef,
  markProgrammaticScroll,
  visibleMessages,
  setAutoScroll,
}: ScrollToMessageOptions): void {
  const scrollToMessageId = useUiStore((s) => s.scrollToMessageId);
  const clearScrollTarget = useUiStore((s) => s.clearScrollTarget);
  const timersRef = useRef<{ flash: ReturnType<typeof setTimeout>; cleanup: ReturnType<typeof setTimeout> } | null>(null);

  useEffect(() => {
    return () => clearTimers(timersRef);
  }, []);

  useEffect(() => {
    if (!scrollToMessageId) return;

    const raf = requestAnimationFrame(() => {
      clearTimers(timersRef);

      const el = containerRef.current?.querySelector<HTMLElement>(
        `[data-msg-id="${CSS.escape(scrollToMessageId)}"]`,
      );
      if (!el) {
        clearScrollTarget();
        return;
      }

      setAutoScroll(false);
      markProgrammaticScroll?.();
      el.scrollIntoView({ behavior: 'auto', block: 'start' });
      el.style.backgroundColor = 'color-mix(in srgb, var(--accent) 15%, transparent)';
      el.style.borderRadius = '8px';
      el.style.transition = 'background-color 2s ease-out 0.3s';

      const flash = setTimeout(() => { el.style.backgroundColor = 'transparent'; }, 50);
      const cleanup = setTimeout(() => {
        el.style.transition = '';
        el.style.borderRadius = '';
        clearScrollTarget();
      }, 2500);

      timersRef.current = { flash, cleanup };
    });

    return () => cancelAnimationFrame(raf);
  }, [scrollToMessageId, visibleMessages, clearScrollTarget, containerRef, markProgrammaticScroll, setAutoScroll]);
}

function clearTimers(ref: React.RefObject<{ flash: ReturnType<typeof setTimeout>; cleanup: ReturnType<typeof setTimeout> } | null>): void {
  if (ref.current) {
    clearTimeout(ref.current.flash);
    clearTimeout(ref.current.cleanup);
    ref.current = null;
  }
}
