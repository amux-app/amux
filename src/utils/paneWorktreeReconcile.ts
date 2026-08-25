import { execFile } from 'child_process';
import * as fs from 'fs';
import { promisify } from 'util';
import type { MuxBasePane } from '../types.js';
import { LogService } from '../services/LogService.js';
import { getManagedWorktreePath, getManagedWorktreesDir } from './worktreePaths.js';

const execFileAsync = promisify(execFile);

interface GitWorktreeEntry {
  path: string;
  branch?: string;
  detached: boolean;
}

export interface ReconcileResult {
  panes: MuxBasePane[];
  attached: number;
}

/**
 * Re-attach panes that have lost their `worktreePath` to managed worktrees on
 * disk by matching the pane slug. Without this, panes whose state was saved
 * before worktree paths were introduced (or where the field was lost) fall
 * back to the project root and incorrectly share branch/diff state.
 */
export async function reconcilePaneWorktrees(
  panes: MuxBasePane[],
  projectRoot: string,
): Promise<ReconcileResult> {
  if (!projectRoot || !panes.some((p) => !p.worktreePath && p.slug)) {
    return { panes, attached: 0 };
  }
  const log = LogService.getInstance();
  const worktreesDir = getManagedWorktreesDir(projectRoot);
  let registered: Map<string, GitWorktreeEntry>;
  try {
    registered = await loadRegisteredWorktrees(projectRoot);
  } catch (err) {
    log.warn(
      `[reconcilePaneWorktrees] git worktree list failed: ${err}`,
      'paneWorktreeReconcile',
    );
    return { panes, attached: 0 };
  }
  let attached = 0;
  const reconciled = panes.map((pane) => {
    if (pane.worktreePath || !pane.slug) return pane;
    const candidate = getManagedWorktreePath(projectRoot, pane.slug);
    if (!fs.existsSync(candidate)) return pane;
    if (!candidate.startsWith(worktreesDir)) return pane;
    const entry = registered.get(candidate);
    if (!entry) return pane;
    attached += 1;
    const next: MuxBasePane = { ...pane, worktreePath: candidate };
    if (!pane.branchName && entry.branch) next.branchName = entry.branch;
    log.info(
      `[reconcilePaneWorktrees] Re-attached pane "${pane.slug}" to ${candidate}`,
      'paneWorktreeReconcile',
    );
    return next;
  });
  return { panes: reconciled, attached };
}

async function loadRegisteredWorktrees(
  projectRoot: string,
): Promise<Map<string, GitWorktreeEntry>> {
  const { stdout } = await execFileAsync('git', ['worktree', 'list', '--porcelain'], {
    cwd: projectRoot,
    encoding: 'utf-8',
  });
  const entries = new Map<string, GitWorktreeEntry>();
  let current: Partial<GitWorktreeEntry> & { path?: string } = {};
  const flush = () => {
    if (current.path) {
      entries.set(current.path, {
        path: current.path,
        branch: current.branch,
        detached: current.detached === true,
      });
    }
    current = {};
  };
  for (const line of stdout.split('\n')) {
    if (line.startsWith('worktree ')) {
      flush();
      current.path = line.slice('worktree '.length).trim();
    } else if (line.startsWith('branch ')) {
      const ref = line.slice('branch '.length).trim();
      current.branch = ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref;
    } else if (line === 'detached') {
      current.detached = true;
    } else if (line === '') {
      flush();
    }
  }
  flush();
  return entries;
}
