import type { AumxPane } from 'aumx/core';

export interface CommandPaletteSearchScope {
  label: string;
  rootPath: string;
  scopeId: string;
}

export function getCommandPaletteSearchScope(
  panes: readonly AumxPane[],
  selectedPaneId: string | null,
  sessionProjectRoot: string,
): CommandPaletteSearchScope | null {
  const activePane = panes.find((pane) => pane.id === selectedPaneId) ?? panes[0];
  const rootPath = activePane?.worktreePath ?? activePane?.projectRoot ?? sessionProjectRoot;
  if (!rootPath) {
    return null;
  }

  return {
    label: activePane?.slug ?? activePane?.id ?? 'project',
    rootPath,
    scopeId: activePane?.id ?? rootPath,
  };
}
