import { useEffect, useRef, useCallback } from 'react';
import type { MuxBasePane } from 'muxbase/core';
import { invoke } from '../api/ipc';
import { IPC } from '../../shared/ipc-channels';
import type { GitStatusResponse } from '../../shared/ipc-types';
import { useWorktreeStatusStore } from '../stores/worktree-status.store';
import { useVisiblePolling } from './useVisiblePolling';

const MAX_CONCURRENT = 3;
const POLL_INTERVAL_MS = 10_000;

type PanesByPath = Map<string, MuxBasePane[]>;

function groupPanesByGitPath(panes: MuxBasePane[]): PanesByPath {
  const grouped: PanesByPath = new Map();
  for (const pane of panes) {
    const gitPath = pane.worktreePath || pane.projectRoot;
    if (!gitPath) continue;
    const bucket = grouped.get(gitPath);
    if (bucket) bucket.push(pane);
    else grouped.set(gitPath, [pane]);
  }
  return grouped;
}

/**
 * Polls worktree status once per distinct working tree. Panes that share a
 * worktree read the same result instead of each issuing its own git scan.
 */
export function useWorktreeStatus(panes: MuxBasePane[]): void {
  const setStatus = useWorktreeStatusStore((s) => s.set);
  const pruneStatuses = useWorktreeStatusStore((s) => s.prune);
  const pendingRef = useRef(new Set<string>());
  const nextPathIndexRef = useRef(0);
  const scannedPathsRef = useRef('');
  const panesRef = useRef(panes);
  panesRef.current = panes;

  const refresh = useCallback(() => {
    const now = Date.now();
    const groupedEntries = [...groupPanesByGitPath(panesRef.current)];
    const availableSlots = MAX_CONCURRENT - pendingRef.current.size;
    if (groupedEntries.length === 0 || availableSlots <= 0) return;

    let inspected = 0;
    let launched = 0;
    let index = nextPathIndexRef.current % groupedEntries.length;

    while (inspected < groupedEntries.length && launched < availableSlots) {
      const [gitPath, grouped] = groupedEntries[index];
      index = (index + 1) % groupedEntries.length;
      inspected++;
      if (pendingRef.current.has(gitPath)) continue;

      pendingRef.current.add(gitPath);
      launched++;

      fetchWorktreeStatus(gitPath)
        .then((result) => {
          if (!result) return;
          for (const pane of grouped) {
            setStatus(pane.id, {
              commitsAhead: result.commitsAhead ?? null,
              filesChanged: result.filesChanged ?? 0,
              insertions: result.insertions ?? 0,
              deletions: result.deletions ?? 0,
              isDirty: result.hasChanges === true,
              lastFetched: now,
            });
          }
        })
        .finally(() => {
          pendingRef.current.delete(gitPath);
        });
    }
    nextPathIndexRef.current = index;
  }, [setStatus]);

  useEffect(() => {
    pruneStatuses(panesRef.current.map((pane) => pane.id));

    const gitPaths = [...groupPanesByGitPath(panesRef.current).keys()].sort().join('\n');
    if (gitPaths === scannedPathsRef.current) return;
    scannedPathsRef.current = gitPaths;
    nextPathIndexRef.current = 0;
    refresh();
  }, [panes, refresh, pruneStatuses]);

  useVisiblePolling(refresh, POLL_INTERVAL_MS);
}

async function fetchWorktreeStatus(gitPath: string): Promise<GitStatusResponse | null> {
  const result = await invoke<GitStatusResponse>(IPC.GIT_STATUS, { worktreePath: gitPath });
  if (result.error) return null;
  return result;
}
