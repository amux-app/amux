import { useEffect, useRef } from 'react';

const VISIBILITY_CHANGE_EVENT = 'visibilitychange';
const VISIBLE_STATE = 'visible';

/**
 * Runs `onPoll` on an interval only while the document is visible. A hidden or
 * minimised window costs nothing, and returning to the window refreshes
 * immediately so the caller never renders data collected before it was hidden.
 */
export function useVisiblePolling(onPoll: () => void, intervalMs: number, enabled = true): void {
  const onPollRef = useRef(onPoll);
  onPollRef.current = onPoll;

  useEffect(() => {
    if (!enabled) return;

    let timer: number | undefined;

    const stop = () => {
      if (timer !== undefined) window.clearInterval(timer);
      timer = undefined;
    };

    const sync = () => {
      stop();
      if (document.visibilityState !== VISIBLE_STATE) return;
      timer = window.setInterval(() => onPollRef.current(), intervalMs);
    };

    const handleVisibilityChange = () => {
      const becameVisible = document.visibilityState === VISIBLE_STATE;
      sync();
      if (becameVisible) onPollRef.current();
    };

    sync();
    document.addEventListener(VISIBILITY_CHANGE_EVENT, handleVisibilityChange);

    return () => {
      document.removeEventListener(VISIBILITY_CHANGE_EVENT, handleVisibilityChange);
      stop();
    };
  }, [enabled, intervalMs]);
}
