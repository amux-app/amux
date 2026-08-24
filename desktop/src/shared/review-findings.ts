import type { NormalizedSession } from './agent-session-types.js';
import { REVIEW_FINDINGS_MAX_CHARS, REVIEW_SKILL_ACK_PREFIX } from './review-constants.js';

export const REVIEW_NO_ISSUES_SENTINEL = 'NO_ISSUES_FOUND';

const LGTM_FALLBACK_REGEX = /^(?:lgtm|looks good(?: to me)?|no issues(?: found)?|no actionable findings|nothing to fix)\.?$/i;
const FINDING_LINE_REGEX = /^(?:[-*+]\s+|#{1,6}\s+)?(?:\*\*)?(?:critical|important|minor)(?:\*\*)?\b\s*[—:-]/i;

type ReviewFindingsKind = 'no-issues' | 'findings';

export interface ReviewFindingsResult {
  kind: ReviewFindingsKind;
  text: string;
}

/** The last substantive assistant message in a session, capped to `maxChars`. */
export function lastAssistantText(session: NormalizedSession | null, maxChars: number): string | undefined {
  if (!session) return undefined;
  for (let i = session.messages.length - 1; i >= 0; i -= 1) {
    const message = session.messages[i];
    if (message.type === 'assistant' && message.content.trim().length > 0) {
      return message.content.trim().slice(0, maxChars);
    }
  }
  return undefined;
}

const TRUNCATION_MARKER = '\n\n[Review truncated — the reviewer output exceeded the transfer limit. Ask the reviewer to continue if a finding looks cut off.]';

export function extractReviewFindings(session: NormalizedSession | null): ReviewFindingsResult | undefined {
  if (session?.awaitingUserInput || session?.isOngoing) return undefined;

  const raw = lastAssistantText(session, REVIEW_FINDINGS_MAX_CHARS + 1);
  if (!raw) return undefined;

  const truncated = raw.length > REVIEW_FINDINGS_MAX_CHARS;
  const text = truncated ? raw.slice(0, REVIEW_FINDINGS_MAX_CHARS) + TRUNCATION_MARKER : raw;

  if (isNoIssuesReview(text)) return { kind: 'no-issues', text };
  return { kind: 'findings', text };
}

function isNoIssuesReview(text: string): boolean {
  const lines = text.trim().split('\n').map((l) => l.trim()).filter(Boolean);
  const reviewLines = lines.filter((line) => !line.startsWith(REVIEW_SKILL_ACK_PREFIX));
  const firstLine = reviewLines[0];
  if (!firstLine) return false;
  if (reviewLines.some((line) => FINDING_LINE_REGEX.test(line))) return false;

  if (firstLine === REVIEW_NO_ISSUES_SENTINEL) return true;
  if (reviewLines.length <= 2 && LGTM_FALLBACK_REGEX.test(firstLine)) return true;

  return false;
}
