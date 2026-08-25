import { IPC } from '../../shared/ipc-channels.js';
import type {
  PaneSummary,
  PaneSummaryGenerateRecapManyRequest,
  PaneSummaryGenerateRecapOneRequest,
  PaneSummaryLoadAllResponse,
  PaneSummaryRefreshManyRequest,
  PaneSummaryRefreshOneRequest,
  PaneSummaryRefreshResponse,
  PaneSummaryRemoveRequest,
} from '../../shared/pane-summary-types.js';
import type { MuxBaseBridge } from '../services/MuxBaseBridge.js';
import { log } from '../services/Logger.js';
import { secureHandle } from './ipc-security.js';

/**
 * Pane IDs we generate look like `muxbase-1781535332253` (slug + millis). Any
 * other shape is suspicious — refuse before forwarding to the service so a
 * compromised renderer can't smuggle path traversal through to the fs.
 */
const SAFE_PANE_ID_RE = /^[A-Za-z0-9_-]+$/;

function isSafePaneId(paneId: unknown): paneId is string {
  return (
    typeof paneId === 'string' &&
    paneId.length > 0 &&
    paneId.length <= 128 &&
    SAFE_PANE_ID_RE.test(paneId)
  );
}

function sanitizePaneIds(ids: string[]): string[] {
  return ids.filter((id) => {
    if (isSafePaneId(id)) return true;
    log.warn('ipc:pane-summary', 'rejecting unsafe pane id', { paneId: id });
    return false;
  });
}

export function registerPaneSummaryHandlers(bridge: MuxBaseBridge): void {
  secureHandle(IPC.PANE_SUMMARY_LOAD_ALL, async (): Promise<PaneSummaryLoadAllResponse> => {
    const svc = bridge.getPaneSummaryService();
    if (!svc) return { summaries: [] };
    const summaries = await svc.loadAll();
    return { summaries };
  });

  secureHandle(IPC.PANE_SUMMARY_REFRESH_ONE, async (
    _event,
    req: PaneSummaryRefreshOneRequest,
  ): Promise<PaneSummaryRefreshResponse> => {
    const svc = bridge.getPaneSummaryService();
    if (!svc) return { error: 'No active project' };
    if (!isSafePaneId(req.paneId)) return { error: 'Invalid pane id' };
    log.debug('ipc:pane-summary', 'REFRESH_ONE', req);
    const summary = await svc.refreshOne(req.paneId, req.force);
    return summary ? { summary } : { error: 'Pane not found' };
  });

  secureHandle(IPC.PANE_SUMMARY_REFRESH_MANY, async (
    _event,
    req: PaneSummaryRefreshManyRequest,
  ): Promise<{ summaries: PaneSummary[] } | { error: string }> => {
    const svc = bridge.getPaneSummaryService();
    if (!svc) return { error: 'No active project' };
    const safeIds = sanitizePaneIds(req.paneIds);
    log.info('ipc:pane-summary', 'REFRESH_MANY', { count: safeIds.length, force: req.force });
    const summaries = await svc.refreshMany(safeIds, req.force);
    return { summaries };
  });

  secureHandle(IPC.PANE_SUMMARY_GENERATE_RECAP_ONE, async (
    _event,
    req: PaneSummaryGenerateRecapOneRequest,
  ): Promise<PaneSummaryRefreshResponse> => {
    const svc = bridge.getPaneSummaryService();
    if (!svc) return { error: 'No active project' };
    if (!isSafePaneId(req.paneId)) return { error: 'Invalid pane id' };
    log.debug('ipc:pane-summary', 'GENERATE_RECAP_ONE', req);
    const summary = await svc.generateRecapOne(req.paneId, req.force);
    return summary ? { summary } : { error: 'Pane not found' };
  });

  secureHandle(IPC.PANE_SUMMARY_GENERATE_RECAP_MANY, async (
    _event,
    req: PaneSummaryGenerateRecapManyRequest,
  ): Promise<{ summaries: PaneSummary[] } | { error: string }> => {
    const svc = bridge.getPaneSummaryService();
    if (!svc) return { error: 'No active project' };
    const safeIds = sanitizePaneIds(req.paneIds);
    log.info('ipc:pane-summary', 'GENERATE_RECAP_MANY', { count: safeIds.length, force: req.force });
    const summaries = await svc.generateRecapMany(safeIds, req.force);
    return { summaries };
  });

  secureHandle(IPC.PANE_SUMMARY_REMOVE, async (_event, req: PaneSummaryRemoveRequest) => {
    const svc = bridge.getPaneSummaryService();
    if (!svc) return { ok: false };
    if (!isSafePaneId(req.paneId)) return { ok: false };
    await svc.removeForPane(req.paneId);
    return { ok: true };
  });
}
