import type { AgentType } from './agent-session-types.js';

type PaneSummaryStatus = 'fresh' | 'stale' | 'refreshing' | 'error';
export type PaneSummaryRecapStatus = 'idle' | 'generating' | 'ready' | 'error';

export interface PaneSummaryGitActivity {
  commitsAhead: number;
  additions: number;
  deletions: number;
  dirtyFileCount: number;
}

export interface PaneSummary {
  paneId: string;
  paneName: string;
  agent: AgentType | 'shell';
  startedAt: number;
  branch: string;
  worktreePath: string | null;
  gitActivity: PaneSummaryGitActivity | null;
  /** Optional LLM-generated recap. Empty until the user explicitly requests it. */
  recap: string;
  recapStatus: PaneSummaryRecapStatus;
  /** Set when recap was last successfully generated; undefined until first run. */
  recapGeneratedAt?: number;
  recapErrorMessage?: string;
  generatedAt: number;
  status: PaneSummaryStatus;
  errorMessage?: string;
}

export interface PaneSummaryRefreshOneRequest {
  paneId: string;
  force: boolean;
}

export interface PaneSummaryRefreshManyRequest {
  paneIds: string[];
  force: boolean;
}

export interface PaneSummaryRefreshResponse {
  summary?: PaneSummary;
  error?: string;
}

export interface PaneSummaryLoadAllResponse {
  summaries: PaneSummary[];
}

export interface PaneSummaryRemoveRequest {
  paneId: string;
}

export interface PaneSummaryGenerateRecapOneRequest {
  paneId: string;
  force: boolean;
}

export interface PaneSummaryGenerateRecapManyRequest {
  paneIds: string[];
  force: boolean;
}

export interface PaneSummaryUpdatedEvent {
  summary: PaneSummary;
}

export interface PaneSummaryRemovedEvent {
  paneId: string;
}
