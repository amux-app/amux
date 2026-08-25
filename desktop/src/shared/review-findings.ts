import type { NormalizedSession } from './agent-session-types.js';
import { REVIEW_FINDINGS_MAX_CHARS, REVIEW_SKILL_ACK_PREFIX } from './review-constants.js';

export const REVIEW_NO_ISSUES_SENTINEL = 'NO_ISSUES_FOUND';

const LGTM_FALLBACK_REGEX = /^(?:lgtm|looks good(?: to me)?|no issues(?: found)?|no actionable findings|nothing to fix)\.?$/i;
const FINDING_LINE_REGEX = /^(?:[-*+]\s+|#{1,6}\s+)?(?:\*\*)?(?:critical|important|minor)(?:\*\*)?\b\s*[—:-]/i;
const PURE_FENCE_LINE = /^(?:```|~~~)\w*$/;
const SENTINEL_WRAPPERS = ['**', '__', '*', '_', '`'] as const;
const SENTINEL_NORMALIZATION_MAX_ITERATIONS = 8;

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
  const reviewLines = lines.filter((line) => (
    !line.startsWith(REVIEW_SKILL_ACK_PREFIX) && !PURE_FENCE_LINE.test(line)
  ));
  const firstLine = reviewLines[0];
  if (!firstLine) return false;
  if (reviewLines.some((line) => FINDING_LINE_REGEX.test(line))) return false;

  if (normalizeSentinelLine(firstLine) === REVIEW_NO_ISSUES_SENTINEL) return true;
  if (reviewLines.length <= 2 && LGTM_FALLBACK_REGEX.test(firstLine)) return true;

  return false;
}

function normalizeSentinelLine(line: string): string {
  let normalized = line;

  for (let iteration = 0; iteration < SENTINEL_NORMALIZATION_MAX_ITERATIONS; iteration += 1) {
    const trimmed = normalized.trim();
    if (trimmed !== normalized) {
      normalized = trimmed;
      continue;
    }

    const heading = normalized.match(/^#{1,6}\s+/);
    if (heading) {
      normalized = normalized.slice(heading[0].length);
      continue;
    }

    const list = normalized.match(/^[-*+]\s+/);
    if (list) {
      normalized = normalized.slice(list[0].length);
      continue;
    }

    const wrapper = SENTINEL_WRAPPERS.find((candidate) => (
      normalized.length > candidate.length * 2
      && normalized.startsWith(candidate)
      && normalized.endsWith(candidate)
    ));
    if (wrapper) {
      normalized = normalized.slice(wrapper.length, -wrapper.length);
      continue;
    }

    if (/[.!:]$/.test(normalized)) {
      normalized = normalized.slice(0, -1);
      continue;
    }

    break;
  }

  return normalized;
}
