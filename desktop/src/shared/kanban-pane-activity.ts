import type { AumxPane } from 'aumx/core';
import { isBusyForKanban, type PaneActivity } from './pane-activity';

export interface PaneKanbanActivityState {
  isBusy: boolean;
  holdInProgressOnIdle: boolean;
  holdReason: null | 'activity-unavailable';
}

/** Kanban consumes the same runtime activity state as every other surface. */
export function getPaneKanbanActivityState(
  _pane: AumxPane,
  _session: unknown,
  _now = Date.now(),
  activity?: PaneActivity,
): PaneKanbanActivityState {
  if (!activity) return { isBusy: false, holdInProgressOnIdle: false, holdReason: 'activity-unavailable' };
  return {
    holdInProgressOnIdle: false,
    holdReason: null,
    isBusy: isBusyForKanban(activity),
  };
}

/** Activity transitions are event-driven; there is no legacy grace timeout. */
export function getPaneKanbanNextTransitionTime(
  _pane: AumxPane,
  _session?: unknown,
  _now = Date.now(),
  _activity?: PaneActivity,
): number | null {
  return null;
}
