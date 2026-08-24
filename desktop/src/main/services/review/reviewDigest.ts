import type { NormalizedSession } from '../../../shared/agent-session-types.js';
import { lastAssistantText } from '../../../shared/review-findings.js';
import { REVIEW_SESSION_DIGEST_MAX_CHARS } from '../../../shared/review-constants.js';

export function buildReviewSessionDigest(session: NormalizedSession | null): string | undefined {
  if (!session) return undefined;

  const lines: string[] = [];
  const title = session.aiTitle?.trim() || session.title?.trim();
  if (title) {
    lines.push(`Title: ${title}`);
  }

  lines.push(`Tool calls: ${session.metrics.toolCallCount}, messages: ${session.metrics.messageCount}`);

  const summary = lastAssistantText(session, REVIEW_SESSION_DIGEST_MAX_CHARS);
  if (summary) {
    lines.push(`Final agent message:\n${summary}`);
  }

  return lines.length ? lines.join('\n') : undefined;
}
