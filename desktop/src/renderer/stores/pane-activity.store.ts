import { create } from 'zustand';
import {
  clonePaneActivity,
  type ActivitySnapshot,
  type PaneActivity,
  type PaneActivityChangedEvent,
} from '../../shared/pane-activity';

interface PaneActivityStore {
  activityByPaneId: Record<string, PaneActivity>;
  justFinishedPaneIds: Set<string>;
  epochId: string | null;
  revision: number;
  bufferedChanges: PaneActivityChangedEvent[];
  acceptChangedEvent: (event: PaneActivityChangedEvent) => 'applied' | 'buffered' | 'epoch-mismatch' | 'stale';
  replaceSnapshot: (snapshot: ActivitySnapshot) => void;
  acknowledgeFinished: (paneId: string) => void;
  reset: () => void;
}

function applyChangedEvent(
  activityByPaneId: Record<string, PaneActivity>,
  justFinishedPaneIds: Set<string>,
  event: PaneActivityChangedEvent,
): void {
  for (const change of event.changes) {
    const previous = activityByPaneId[change.paneId];
    activityByPaneId[change.paneId] = clonePaneActivity(change.activity);
    if (previous?.state === 'working' && change.activity.state === 'idle' && change.activity.certainty === 'confirmed') {
      justFinishedPaneIds.add(change.paneId);
    } else if (change.activity.state !== 'idle') {
      justFinishedPaneIds.delete(change.paneId);
    }
  }
  for (const paneId of event.removedPaneIds ?? []) delete activityByPaneId[paneId];
  for (const paneId of event.removedPaneIds ?? []) justFinishedPaneIds.delete(paneId);
}

/** Renderer replica of the main activity service. Snapshots replace, deltas only advance. */
export const usePaneActivityStore = create<PaneActivityStore>((set, get) => ({
  activityByPaneId: {},
  justFinishedPaneIds: new Set(),
  bufferedChanges: [],
  epochId: null,
  revision: -1,
  acceptChangedEvent: (event) => {
    const state = get();
    if (state.epochId === null) {
      set({ bufferedChanges: [...state.bufferedChanges, event] });
      return 'buffered';
    }
    if (event.epochId !== state.epochId) return 'epoch-mismatch';
    if (event.revision <= state.revision) return 'stale';
    const activityByPaneId = { ...state.activityByPaneId };
    const justFinishedPaneIds = new Set(state.justFinishedPaneIds);
    applyChangedEvent(activityByPaneId, justFinishedPaneIds, event);
    set({ activityByPaneId, justFinishedPaneIds, revision: event.revision });
    return 'applied';
  },
  replaceSnapshot: (snapshot) => {
    const current = get();
    const activityByPaneId = Object.fromEntries(
      Object.entries(snapshot.panes).map(([paneId, activity]) => [paneId, clonePaneActivity(activity)]),
    );
    const justFinishedPaneIds = new Set<string>();
    let revision = snapshot.revision;
    const bufferedChanges = current.bufferedChanges.filter((event) => event.epochId === snapshot.epochId);
    for (const event of bufferedChanges.sort((a, b) => a.revision - b.revision)) {
      if (event.revision <= revision) continue;
      applyChangedEvent(activityByPaneId, justFinishedPaneIds, event);
      revision = event.revision;
    }
    set({ activityByPaneId, bufferedChanges: [], epochId: snapshot.epochId, justFinishedPaneIds, revision });
  },
  acknowledgeFinished: (paneId) => set((state) => {
    if (!state.justFinishedPaneIds.has(paneId)) return state;
    const justFinishedPaneIds = new Set(state.justFinishedPaneIds);
    justFinishedPaneIds.delete(paneId);
    return { justFinishedPaneIds };
  }),
  reset: () => set({ activityByPaneId: {}, bufferedChanges: [], epochId: null, justFinishedPaneIds: new Set(), revision: -1 }),
}));

export function selectPaneActivity(paneId: string): PaneActivity | undefined {
  return usePaneActivityStore.getState().activityByPaneId[paneId];
}
