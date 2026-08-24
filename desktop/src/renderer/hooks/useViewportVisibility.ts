import { useEffect, useState } from 'react';

const VIEWPORT_PREFETCH_MARGIN = '200px 0px';

export function useViewportVisibility(element: HTMLElement): boolean {
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return;

    const root = element.closest('[data-fleet-scroll-root="true"]');
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries.find((candidate) => candidate.target === element);
        if (entry) setVisible(entry.isIntersecting);
      },
      {
        root,
        rootMargin: VIEWPORT_PREFETCH_MARGIN,
        threshold: 0.01,
      },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);

  return visible;
}
