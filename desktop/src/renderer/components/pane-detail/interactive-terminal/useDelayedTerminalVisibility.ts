import { useEffect, useState } from 'react';

export function useDelayedTerminalVisibility(visible: boolean, delayMs: number): boolean {
  const [effectiveVisible, setEffectiveVisible] = useState(visible);

  useEffect(() => {
    if (visible) {
      setEffectiveVisible(true);
      return;
    }
    const timer = setTimeout(() => setEffectiveVisible(false), delayMs);
    return () => clearTimeout(timer);
  }, [delayMs, visible]);

  return effectiveVisible;
}
