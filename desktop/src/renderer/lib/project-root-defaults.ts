interface ResolveDefaultProjectRootArgs {
  activeProjectRoot?: string;
  sessionProjectRoot?: string;
  lastTaskProjectRoot?: string;
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/+$/, '');
}

/**
 * Keep pane creation deterministic: default to the current active/session project,
 * unless the persisted value already points at that same root.
 */
export function resolveDefaultTaskProjectRoot({
  activeProjectRoot,
  sessionProjectRoot,
  lastTaskProjectRoot,
}: ResolveDefaultProjectRootArgs): string | undefined {
  if (!lastTaskProjectRoot) return undefined;

  const currentProjectRoot = activeProjectRoot || sessionProjectRoot;
  if (!currentProjectRoot) return lastTaskProjectRoot;

  return normalizePath(lastTaskProjectRoot) === normalizePath(currentProjectRoot)
    ? lastTaskProjectRoot
    : undefined;
}
