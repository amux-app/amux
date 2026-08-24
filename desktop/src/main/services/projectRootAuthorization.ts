import { normalizeRootPath } from '../utils/file-root-authorization.js';
import { discoverProjects } from './ProjectDiscovery.js';
import { WorkspaceHistoryService } from './WorkspaceHistoryService.js';

export const UNAUTHORIZED_PROJECT_ROOT_ERROR = 'Unauthorized project root';

/**
 * Roots the user picked in a main-process native dialog. Only main can add to
 * this set, so a renderer can never widen it with a path of its own choosing.
 */
const dialogApprovedRoots = new Set<string>();

export function approveProjectRoot(rootPath: string): void {
  dialogApprovedRoots.add(normalizeRootPath(rootPath));
}

export async function isApprovedProjectRoot(rootPath: string): Promise<boolean> {
  const requested = normalizeRootPath(rootPath);
  try {
    if (dialogApprovedRoots.has(requested)) return true;
    if (containsRoot(WorkspaceHistoryService.getInstance().getAll(), requested)) return true;
    return containsRoot(await discoverProjects(), requested);
  } catch {
    return false;
  }
}

export async function authorizeProjectRoot(
  requestedRoot: string | undefined,
  activeProjectRoot: string,
  panes: readonly { projectRoot?: string; worktreePath?: string }[],
): Promise<string | undefined> {
  if (requestedRoot === undefined || requestedRoot === '') return undefined;
  const normalizedRequested = normalizeRootPath(requestedRoot);
  const allowed = [
    activeProjectRoot,
    ...panes.flatMap((pane) => [pane.projectRoot, pane.worktreePath]),
  ].some((root) => root !== undefined && normalizeRootPath(root) === normalizedRequested);
  if (allowed || await isApprovedProjectRoot(requestedRoot)) return normalizedRequested;
  throw new Error(UNAUTHORIZED_PROJECT_ROOT_ERROR);
}

function containsRoot(entries: readonly { root: string }[], requested: string): boolean {
  return entries.some((entry) => normalizeRootPath(entry.root) === requested);
}
