import type {
  GitBranchesRequest,
  GitDiffRequest,
  GitDiffResponse,
  GitFileDiffRequest,
  GitFileDiffResponse,
  GitStatusRequest,
  GitStatusResponse,
} from '../../shared/ipc-types';
import { IPC } from '../../shared/ipc-channels';
import { invoke } from './ipc';

export function getDiff(req: GitDiffRequest): Promise<GitDiffResponse> {
  return invoke<GitDiffResponse>(IPC.GIT_DIFF, req);
}

export function getFileDiff(req: GitFileDiffRequest): Promise<GitFileDiffResponse> {
  return invoke<GitFileDiffResponse>(IPC.GIT_FILE_DIFF, req);
}

export function getStatus(req: GitStatusRequest): Promise<GitStatusResponse> {
  return invoke<GitStatusResponse>(IPC.GIT_STATUS, req);
}

/** @public Renderer API contract for the GIT_BRANCHES IPC channel. */
export function getBranches(req: GitBranchesRequest): Promise<{ branches: string[]; error?: string }> {
  return invoke<{ branches: string[]; error?: string }>(IPC.GIT_BRANCHES, req);
}
