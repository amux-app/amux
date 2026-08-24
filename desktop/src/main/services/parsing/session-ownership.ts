/**
 * Governs HEURISTIC session discovery only — title match, launch window, mtime
 * fallback, legacy fallback. A heuristic may only auto-bind a session born at or
 * after the pane itself; without this, any external agent session running in the
 * same directory wins every recency heuristic and steals the pane's title.
 *
 * Explicit binds — a registered transcript, or a persisted `agentSessionId` from a
 * deliberate resume — are always trusted and never consult this gate. Resuming a
 * session from last week is a normal request, and the session it continues is
 * arbitrarily older than the pane that resumed it.
 */

/** Panes created outside the timestamped-id path (`aumx-<uuid>`, `aumx-<n>`) have no known age. */
const PANE_ID_EPOCH_PATTERN = /^aumx-(\d{13,})$/;

const DEFAULT_OWNERSHIP_SLACK_MS = 30_000;

/** Creation time embedded in a pane id, or null when the id carries no epoch. */
export function paneCreatedMsFromId(paneId: string): number | null {
  const match = PANE_ID_EPOCH_PATTERN.exec(paneId);
  return match ? parseInt(match[1], 10) : null;
}

/** Birth time of a candidate, falling back to mtime when the filesystem reports none. */
function candidateBirthMs(candidate: { birthtimeMs?: number; mtimeMs: number }): number {
  return candidate.birthtimeMs && candidate.birthtimeMs > 0 ? candidate.birthtimeMs : candidate.mtimeMs;
}

/**
 * No upper bound on purpose: an agent that rotates to a new session file hours into a
 * long-lived pane must stay bindable. Callers that need a launch window keep their own.
 */
export function isOwnedByPane(
  candidate: { birthtimeMs?: number; mtimeMs: number },
  paneCreatedMs: number | null,
  slackMs: number = DEFAULT_OWNERSHIP_SLACK_MS,
): boolean {
  if (paneCreatedMs === null) return true;
  return candidateBirthMs(candidate) >= paneCreatedMs - slackMs;
}

export function filterOwnedByPane<T extends { birthtimeMs?: number; mtimeMs: number }>(
  candidates: T[],
  paneCreatedMs: number | null,
  slackMs: number = DEFAULT_OWNERSHIP_SLACK_MS,
): T[] {
  if (paneCreatedMs === null) return candidates;
  return candidates.filter((candidate) => isOwnedByPane(candidate, paneCreatedMs, slackMs));
}
