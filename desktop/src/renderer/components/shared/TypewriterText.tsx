import { useEffect, useRef, useState } from 'react';

const CARET_CLASS = 'ml-[1px] inline-block h-[0.85em] w-[1px] translate-y-[0.12em] bg-current opacity-60';
const MAX_DURATION_MS = 800;
const MIN_DURATION_MS = 400;
const PER_CHAR_MS = 22;

const prefersReducedMotion = () =>
  typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function commonPrefixLength(previous: string, next: string): number {
  const limit = Math.min(previous.length, next.length);
  let index = 0;
  while (index < limit && previous[index] === next[index]) index++;
  return index;
}

/** Pace per character so any length still lands inside the same perceived window. */
function typingDuration(charCount: number): number {
  return Math.min(MAX_DURATION_MS, Math.max(MIN_DURATION_MS, charCount * PER_CHAR_MS));
}

/**
 * Renders `text` instantly on mount and types out only the changed suffix when it
 * later changes, so a resolved agent title arrives without a boot-time animation storm.
 */
export function TypewriterText({ text }: Readonly<{ text: string }>) {
  const [displayed, setDisplayed] = useState(text);
  const [typing, setTyping] = useState(false);
  const previousRef = useRef(text);

  useEffect(() => {
    const previous = previousRef.current;
    previousRef.current = text;
    if (previous === text) return;

    const prefix = commonPrefixLength(previous, text);
    const remaining = text.length - prefix;
    if (remaining <= 0 || prefersReducedMotion()) {
      setDisplayed(text);
      setTyping(false);
      return;
    }

    const duration = typingDuration(remaining);
    const startedAt = performance.now();
    let frame = 0;

    const tick = (now: number) => {
      const progress = Math.min((now - startedAt) / duration, 1);
      setDisplayed(text.slice(0, prefix + Math.ceil(progress * remaining)));
      if (progress < 1) {
        frame = requestAnimationFrame(tick);
        return;
      }
      setTyping(false);
    };

    setTyping(true);
    setDisplayed(text.slice(0, prefix));
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [text]);

  return (
    <span aria-label={text}>
      {displayed}
      {typing && <span aria-hidden="true" className={CARET_CLASS} />}
    </span>
  );
}
