import type { PastSession } from '../../../shared/ipc-types.js';

export const SESSION_UNTITLED = 'Untitled session';
const TITLE_MAX_LENGTH = 80;

export interface SessionListing {
  sessions: PastSession[];
  /** Sessions the agent has for this project; `sessions.length` is smaller when `limit` truncated the read. */
  total: number;
}

/** Newest-first listings are already sorted, so a limit is the leading slice. */
export function applySessionLimit<T>(items: T[], limit?: number): T[] {
  return limit !== undefined && limit > 0 ? items.slice(0, limit) : items;
}

const INJECTED_PREFIXES = [
  '<local-command-caveat>',
  '<command-name>',
  '<local-command-stdout>',
  '<system-reminder>',
];

export function isInjectedHarnessText(text: string): boolean {
  return INJECTED_PREFIXES.some((p) => text.startsWith(p));
}

export function truncateTitle(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return SESSION_UNTITLED;
  return trimmed.length > TITLE_MAX_LENGTH ? `${trimmed.slice(0, TITLE_MAX_LENGTH)}…` : trimmed;
}
