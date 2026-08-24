import { useEffect } from 'react';
import { applyDocumentTheme, resolveDocumentTheme, type ResolvedTheme } from '../lib/document-theme';
import { useUiStore } from '../stores';
import type { Theme } from '../stores';

export function useTheme(): { theme: Theme; resolved: ResolvedTheme; setTheme: (t: Theme) => void } {
  const theme = useUiStore((s) => s.theme);
  const setTheme = useUiStore((s) => s.setTheme);

  useEffect(() => {
    applyDocumentTheme(theme);

    if (theme === 'system') {
      const mq = window.matchMedia('(prefers-color-scheme: dark)');
      const handler = () => applyDocumentTheme('system');
      mq.addEventListener('change', handler);
      return () => mq.removeEventListener('change', handler);
    }
  }, [theme]);

  return { theme, resolved: resolveDocumentTheme(theme), setTheme };
}
