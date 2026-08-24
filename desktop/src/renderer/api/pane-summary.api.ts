import { invoke } from './ipc';
import { IPC } from '../../shared/ipc-channels';
import type {
  PaneSummary,
  PaneSummaryGenerateRecapManyRequest,
  PaneSummaryGenerateRecapOneRequest,
  PaneSummaryLoadAllResponse,
  PaneSummaryRefreshManyRequest,
  PaneSummaryRefreshOneRequest,
  PaneSummaryRefreshResponse,
  PaneSummaryRemoveRequest,
} from '../../shared/pane-summary-types';

export async function loadAllPaneSummaries(): Promise<PaneSummary[]> {
  const res = await invoke<PaneSummaryLoadAllResponse>(IPC.PANE_SUMMARY_LOAD_ALL);
  return res.summaries;
}

export function refreshPaneSummary(paneId: string, force: boolean): Promise<PaneSummaryRefreshResponse> {
  const req: PaneSummaryRefreshOneRequest = { paneId, force };
  return invoke<PaneSummaryRefreshResponse>(IPC.PANE_SUMMARY_REFRESH_ONE, req);
}

export function refreshPaneSummariesMany(
  paneIds: string[],
  force: boolean,
): Promise<{ summaries: PaneSummary[] } | { error: string }> {
  const req: PaneSummaryRefreshManyRequest = { paneIds, force };
  return invoke(IPC.PANE_SUMMARY_REFRESH_MANY, req);
}

export function generatePaneSummaryRecap(
  paneId: string,
  force: boolean,
): Promise<PaneSummaryRefreshResponse> {
  const req: PaneSummaryGenerateRecapOneRequest = { paneId, force };
  return invoke<PaneSummaryRefreshResponse>(IPC.PANE_SUMMARY_GENERATE_RECAP_ONE, req);
}

export function generatePaneSummaryRecapMany(
  paneIds: string[],
  force: boolean,
): Promise<{ summaries: PaneSummary[] } | { error: string }> {
  const req: PaneSummaryGenerateRecapManyRequest = { paneIds, force };
  return invoke(IPC.PANE_SUMMARY_GENERATE_RECAP_MANY, req);
}

/** @public Renderer API contract for the PANE_SUMMARY_REMOVE IPC channel. */
export function removePaneSummary(paneId: string): Promise<{ ok: boolean }> {
  const req: PaneSummaryRemoveRequest = { paneId };
  return invoke(IPC.PANE_SUMMARY_REMOVE, req);
}
