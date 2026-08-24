import type {
  WorkspaceHistoryEntry,
  WorkspaceHistoryTouchRequest,
  WorkspaceHistoryRemoveRequest,
  WorkspaceOpenFolderResponse,
  WorkspaceNewProjectResponse,
  WorkspaceCreateSessionRequest,
  WorkspaceCreateSessionResponse,
} from '../../shared/ipc-types';
import { IPC } from '../../shared/ipc-channels';
import { invoke } from './ipc';

export function listHistory(): Promise<WorkspaceHistoryEntry[]> {
  return invoke<WorkspaceHistoryEntry[]>(IPC.WORKSPACE_HISTORY_LIST);
}

export function touchHistory(req: WorkspaceHistoryTouchRequest): Promise<WorkspaceHistoryEntry[]> {
  return invoke<WorkspaceHistoryEntry[]>(IPC.WORKSPACE_HISTORY_TOUCH, req);
}

export function removeHistory(req: WorkspaceHistoryRemoveRequest): Promise<WorkspaceHistoryEntry[]> {
  return invoke<WorkspaceHistoryEntry[]>(IPC.WORKSPACE_HISTORY_REMOVE, req);
}

export function openFolderDialog(): Promise<WorkspaceOpenFolderResponse> {
  return invoke<WorkspaceOpenFolderResponse>(IPC.WORKSPACE_OPEN_FOLDER);
}

export function createProjectDialog(): Promise<WorkspaceNewProjectResponse> {
  return invoke<WorkspaceNewProjectResponse>(IPC.WORKSPACE_NEW_PROJECT);
}

export function createSession(req: WorkspaceCreateSessionRequest): Promise<WorkspaceCreateSessionResponse> {
  return invoke<WorkspaceCreateSessionResponse>(IPC.WORKSPACE_CREATE_SESSION, req);
}
