import type { MuxBasePane } from 'muxbase/core';
import type {
  PaneCreateRequest,
  PaneCreateResponse,
  PaneCloseRequest,
  PaneMergeRequest,
  PaneRenameRequest,
  PaneResumeFullscreenRequest,
  PaneJumpRequest,
  PaneSendKeysRequest,
  PaneGetContentRequest,
  PaneCreateWorktreeRequest,
  PaneCreateWorktreeResponse,
  PaneAttachWorktreeRequest,
  PaneAttachWorktreeResponse,
  PaneDuplicateRequest,
  PaneStartReviewRequest,
  PaneStartReviewResponse,
  PaneSendFixRequest,
  PaneSendFixResponse,
  PaneDuelCreateRequest,
  PaneDuelCreateResponse,
  PaneDuelResolveRequest,
  PaneDuelResolveResponse,
  PaneSessionListRequest,
  PaneSessionListResponse,
  ActionCallbackRequest,
  SerializableActionResult,
} from '../../shared/ipc-types';
import { IPC } from '../../shared/ipc-channels';
import type { ActivitySnapshot } from '../../shared/pane-activity';
import { invoke } from './ipc';
import { sanitizePaneList, warnDroppedItems, warnInvalidPayload } from '../lib/runtimeValidation';

export async function listPanes(): Promise<MuxBasePane[]> {
  const payload = await invoke<unknown>(IPC.PANE_LIST);
  const panes = sanitizePaneList(payload);

  if (!panes) {
    warnInvalidPayload('pane-list', payload);
    return [];
  }

  if (Array.isArray(payload) && panes.length !== payload.length) {
    warnDroppedItems('pane-list', payload.length, panes.length);
  }

  return panes;
}

export function getPaneActivitySnapshot(): Promise<ActivitySnapshot> {
  return invoke<ActivitySnapshot>(IPC.PANE_ACTIVITY_SNAPSHOT_GET);
}

export function createPane(req: PaneCreateRequest): Promise<PaneCreateResponse> {
  return invoke<PaneCreateResponse>(IPC.PANE_CREATE, req);
}

export function closePane(req: PaneCloseRequest): Promise<SerializableActionResult> {
  return invoke<SerializableActionResult>(IPC.PANE_CLOSE, req);
}

export function mergePane(req: PaneMergeRequest): Promise<SerializableActionResult> {
  return invoke<SerializableActionResult>(IPC.PANE_MERGE, req);
}

export function renamePane(req: PaneRenameRequest): Promise<SerializableActionResult> {
  return invoke<SerializableActionResult>(IPC.PANE_RENAME, req);
}

export function resumeInFullscreen(req: PaneResumeFullscreenRequest): Promise<SerializableActionResult> {
  return invoke<SerializableActionResult>(IPC.PANE_RESUME_FULLSCREEN, req);
}

export async function jumpToPane(req: PaneJumpRequest): Promise<void> {
  const response = await invoke<{ error?: string; success: boolean }>(IPC.PANE_JUMP, req);
  if (!response.success) {
    throw new Error(response.error ?? 'Failed to jump to pane');
  }
}

export async function sendKeys(req: PaneSendKeysRequest): Promise<void> {
  const response = await invoke<{ error?: string; success: boolean }>(IPC.PANE_SEND_KEYS, req);
  if (!response.success) {
    throw new Error(response.error ?? 'Failed to submit terminal command');
  }
}

/** @public Renderer API contract for the PANE_GET_CONTENT IPC channel. */
export function getContent(req: PaneGetContentRequest): Promise<string> {
  return invoke<string>(IPC.PANE_GET_CONTENT, req);
}

export function createWorktree(req: PaneCreateWorktreeRequest): Promise<PaneCreateWorktreeResponse> {
  return invoke<PaneCreateWorktreeResponse>(IPC.PANE_CREATE_WORKTREE, req);
}

export function attachWorktree(req: PaneAttachWorktreeRequest): Promise<PaneAttachWorktreeResponse> {
  return invoke<PaneAttachWorktreeResponse>(IPC.PANE_ATTACH_WORKTREE, req);
}

export function createDuelPanes(req: PaneDuelCreateRequest): Promise<PaneDuelCreateResponse> {
  return invoke<PaneDuelCreateResponse>(IPC.PANE_DUEL_CREATE, req);
}

export function resolveDuel(req: PaneDuelResolveRequest): Promise<PaneDuelResolveResponse> {
  return invoke<PaneDuelResolveResponse>(IPC.PANE_DUEL_RESOLVE, req);
}

export function duplicatePane(req: PaneDuplicateRequest): Promise<PaneCreateResponse> {
  return invoke<PaneCreateResponse>(IPC.PANE_DUPLICATE, req);
}

export function startReview(req: PaneStartReviewRequest): Promise<PaneStartReviewResponse> {
  return invoke<PaneStartReviewResponse>(IPC.PANE_START_REVIEW, req);
}

export function sendFix(req: PaneSendFixRequest): Promise<PaneSendFixResponse> {
  return invoke<PaneSendFixResponse>(IPC.PANE_SEND_FIX, req);
}

export function executeCallback(req: ActionCallbackRequest): Promise<SerializableActionResult> {
  return invoke<SerializableActionResult>(IPC.ACTION_CALLBACK, req);
}

export function listPaneSessions(req: PaneSessionListRequest): Promise<PaneSessionListResponse> {
  return invoke<PaneSessionListResponse>(IPC.PANE_SESSION_LIST, req);
}
