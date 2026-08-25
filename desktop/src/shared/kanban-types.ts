import type { AgentName } from 'muxbase/core';

// Kanban board types — shared between main and renderer

export interface BacklogItem {
  id: string;
  title: string;
  prompt: string;
  complexity: 'S' | 'M' | 'L';
  createdAt: number;
  sourceSlug?: string;
  sourcePaneId?: string;
  dependencies?: string[];
  parallelGroup?: string;
  agent?: AgentName;
  useWorktree?: boolean;
  projectRoot?: string;
  variants?: number;
  order: number;
}

export interface DoneItem {
  id: string;
  slug: string;
  prompt: string;
  mergedAt: number;
  sourceSlug?: string;
  branchName?: string;
  agent?: AgentName;
  cleanupFailed?: boolean;
}

export interface DecomposeTask {
  title: string;
  prompt: string;
  complexity: 'S' | 'M' | 'L';
  definitionOfDone: string;
  dependencies: number[];
  parallelGroup?: string;
}

export interface KanbanData {
  backlog: BacklogItem[];
  done: DoneItem[];
}

// IPC request/response types

export interface KanbanGetRequest {
  projectRoot: string;
}

export interface KanbanGetResponse {
  backlog: BacklogItem[];
  done: DoneItem[];
}

export interface BacklogAddRequest {
  projectRoot: string;
  items: Omit<BacklogItem, 'id' | 'createdAt' | 'order'>[];
}

export interface BacklogAddResponse {
  success: boolean;
  items: BacklogItem[];
}

export interface BacklogRemoveRequest {
  projectRoot: string;
  itemIds: string[];
}

export interface BacklogRemoveResponse {
  success: boolean;
  error?: string;
}

export interface BacklogUpdateRequest {
  projectRoot: string;
  itemId: string;
  updates: Partial<Pick<BacklogItem, 'title' | 'prompt' | 'complexity' | 'agent' | 'useWorktree' | 'projectRoot' | 'order'>>;
}

export interface BacklogUpdateResponse {
  success: boolean;
  error?: string;
}

export interface BacklogReorderRequest {
  projectRoot: string;
  orderedIds: string[];
}

export interface BacklogReorderResponse {
  success: boolean;
  error?: string;
}

export interface DoneAddRequest {
  projectRoot: string;
  item: Omit<DoneItem, 'id' | 'mergedAt'>;
}

export interface DoneAddResponse {
  success: boolean;
  error?: string;
}

export interface DoneClearRequest {
  projectRoot: string;
}

export interface DoneClearResponse {
  success: boolean;
  error?: string;
}

export interface BatchLaunchRequest {
  projectRoot: string;
  itemIds: string[];
}

export interface BatchLaunchResponse {
  success: boolean;
  launched: number;
  errors: string[];
  launchedPaneIds?: string[];
}

export interface DecomposeGenerateRequest {
  projectRoot: string;
  paneId: string;
  prompt: string;
  contextHint?: string;
  includeDiff?: boolean;
}

export interface DecomposeGenerateResponse {
  success: boolean;
  tasks: DecomposeTask[];
  error?: string;
}
