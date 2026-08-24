import { useEffect, useState } from 'react';

const COMPACT_SIDEBAR_MEDIA_QUERY = '(max-width: 680px)';

/** Below this effective width the sidebar hides itself so the content keeps every control reachable. */
export function useCompactSidebarViewport(): boolean {
  const [compact, setCompact] = useState(() => (
    typeof window.matchMedia === 'function'
      ? window.matchMedia(COMPACT_SIDEBAR_MEDIA_QUERY).matches
      : false
  ));

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia(COMPACT_SIDEBAR_MEDIA_QUERY);
    const update = () => setCompact(query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);

  return compact;
}
