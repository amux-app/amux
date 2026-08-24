export interface PaneProjectSource {
  projectName?: string;
  projectRoot?: string;
}

export interface ActiveProjectSource {
  name?: string;
  root?: string;
}

export interface PaneProjectDisplay {
  initial: string;
  name: string;
  root: string;
}

export function resolvePaneProjectDisplay(
  pane: PaneProjectSource,
  activeProject?: ActiveProjectSource | null,
): PaneProjectDisplay | null {
  const paneRoot = normalizeProjectRoot(pane.projectRoot);
  const activeRoot = normalizeProjectRoot(activeProject?.root);
  const root = paneRoot || activeRoot;
  const name = pane.projectName?.trim()
    || projectNameFromRoot(paneRoot)
    || activeProject?.name?.trim()
    || projectNameFromRoot(activeRoot);

  if (!name || !root) return null;

  return {
    initial: name.charAt(0).toUpperCase(),
    name,
    root,
  };
}

function normalizeProjectRoot(root?: string): string {
  const trimmed = root?.trim() ?? '';
  if (trimmed === '/') return trimmed;
  return trimmed.replace(/\/+$/, '');
}

function projectNameFromRoot(root: string): string {
  return root.split('/').filter(Boolean).at(-1) ?? '';
}
