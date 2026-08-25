import type { MuxBasePane } from 'muxbase/core';

export type DuelPair = readonly [paneA: MuxBasePane, paneB: MuxBasePane];

export function resolveDuelPair(panes: MuxBasePane[], groupId: string | null): DuelPair | null {
  if (!groupId) return null;

  const members = panes.filter((pane) => pane.duel?.groupId === groupId);
  if (members.length !== 2) return null;

  const paneA = members.find((pane) => pane.duel?.role === 'a');
  const paneB = members.find((pane) => pane.duel?.role === 'b');
  if (!paneA || !paneB) return null;

  if (paneA.duel?.siblingPaneId && paneA.duel.siblingPaneId !== paneB.id) return null;
  if (paneB.duel?.siblingPaneId && paneB.duel.siblingPaneId !== paneA.id) return null;

  return [paneA, paneB];
}
