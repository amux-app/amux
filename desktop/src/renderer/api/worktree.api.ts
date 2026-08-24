import { IPC } from '../../shared/ipc-channels';
import type {
  PaneCreateResponse,
  WorktreeInspectRequest,
  WorktreeInspectResponse,
  WorktreeOrphansListResponse,
  WorktreeRemoveRequest,
  WorktreeRemoveResponse,
  WorktreeReopenRequest,
} from '../../shared/ipc-types';
import { invoke } from './ipc';

export function listOrphanedWorktrees(): Promise<WorktreeOrphansListResponse> {
  return invoke<WorktreeOrphansListResponse>(IPC.WORKTREE_ORPHANS_LIST);
}

export function inspectPreservedWorktree(
  req: WorktreeInspectRequest,
): Promise<WorktreeInspectResponse> {
  return invoke<WorktreeInspectResponse>(IPC.WORKTREE_ORPHAN_INSPECT, req);
}

export function removePreservedWorktree(
  req: WorktreeRemoveRequest,
): Promise<WorktreeRemoveResponse> {
  return invoke<WorktreeRemoveResponse>(IPC.WORKTREE_REMOVE, req);
}

export function reopenWorktree(req: WorktreeReopenRequest): Promise<PaneCreateResponse> {
  return invoke<PaneCreateResponse>(IPC.WORKTREE_REOPEN, req);
}
