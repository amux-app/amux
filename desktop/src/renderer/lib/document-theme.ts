import type { Theme } from '../stores/ui.store';

export type ResolvedTheme = Exclude<Theme, 'system'>;

export function resolveDocumentTheme(theme: Theme): ResolvedTheme {
  if (theme !== 'system') return theme;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function applyDocumentTheme(theme: Theme): void {
  document.documentElement.setAttribute('data-theme', resolveDocumentTheme(theme));
}
