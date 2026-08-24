import { IPC } from '../../shared/ipc-channels';
import type {
  KanbanGetRequest,
  KanbanGetResponse,
  BacklogAddRequest,
  BacklogAddResponse,
  BacklogRemoveRequest,
  BacklogRemoveResponse,
  BacklogUpdateRequest,
  BacklogUpdateResponse,
  BacklogReorderRequest,
  BacklogReorderResponse,
  DoneAddRequest,
  DoneAddResponse,
  DoneClearRequest,
  DoneClearResponse,
  BatchLaunchRequest,
  BatchLaunchResponse,
} from '../../shared/kanban-types';
import { invoke } from './ipc';

export function getKanban(req: KanbanGetRequest): Promise<KanbanGetResponse> {
  return invoke<KanbanGetResponse>(IPC.KANBAN_GET, req);
}

export function addBacklogItems(req: BacklogAddRequest): Promise<BacklogAddResponse> {
  return invoke<BacklogAddResponse>(IPC.KANBAN_BACKLOG_ADD, req);
}

export function removeBacklogItems(req: BacklogRemoveRequest): Promise<BacklogRemoveResponse> {
  return invoke<BacklogRemoveResponse>(IPC.KANBAN_BACKLOG_REMOVE, req);
}

export function updateBacklogItem(req: BacklogUpdateRequest): Promise<BacklogUpdateResponse> {
  return invoke<BacklogUpdateResponse>(IPC.KANBAN_BACKLOG_UPDATE, req);
}

export function reorderBacklog(req: BacklogReorderRequest): Promise<BacklogReorderResponse> {
  return invoke<BacklogReorderResponse>(IPC.KANBAN_BACKLOG_REORDER, req);
}

export function addDoneItem(req: DoneAddRequest): Promise<DoneAddResponse> {
  return invoke<DoneAddResponse>(IPC.KANBAN_DONE_ADD, req);
}

export function clearDone(req: DoneClearRequest): Promise<DoneClearResponse> {
  return invoke<DoneClearResponse>(IPC.KANBAN_DONE_CLEAR, req);
}

export function batchLaunch(req: BatchLaunchRequest): Promise<BatchLaunchResponse> {
  return invoke<BatchLaunchResponse>(IPC.KANBAN_BATCH_LAUNCH, req);
}
