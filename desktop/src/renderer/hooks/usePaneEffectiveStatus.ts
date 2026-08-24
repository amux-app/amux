import type { AumxPane } from 'aumx/core';
import type { PaneActivityState } from '../../shared/pane-activity';
import { getEffectivePaneStatus } from '../lib/pane-attention';
import { useAgentSessionStore } from '../stores/agent-session.store';
import { usePaneActivityStore } from '../stores/pane-activity.store';

/**
 * The same session-aware status the sidebar and PaneCell already show: a
 * session's awaitingUserInput overlays 'waiting' onto PaneActivity (falling
 * Activity is authoritative; missing activity remains unknown until the main
 * process publishes a snapshot for this project epoch.
 */
export function usePaneEffectiveStatus(pane: AumxPane | null | undefined): PaneActivityState {
  const activity = usePaneActivityStore((s) => (pane ? s.activityByPaneId[pane.id] : undefined));
  return useAgentSessionStore((s) => (pane ? getEffectivePaneStatus(pane, s.sessions[pane.id], activity) : 'unknown'));
}
