import { useUiStore } from '../stores';
import { useCompactSidebarViewport } from './useCompactSidebarViewport';

/** Single source of truth for the collapsed sidebar column, shared by the sidebar and the titlebar strip. */
export function useSidebarCollapsed(): boolean {
  const collapsedPreference = useUiStore((s) => s.sidebarCollapsed);
  const compactViewport = useCompactSidebarViewport();
  return collapsedPreference || compactViewport;
}
