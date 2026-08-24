const REVIEW_BRANCH_TOKEN_MAX_CHARS = 255;
export const REVIEW_CHANGED_FILES_VISIBLE_LIMIT = 12;
export const REVIEW_FINDINGS_MAX_CHARS = 16000;
export const REVIEW_FINDINGS_PREVIEW_MAX_CHARS = 8000;
export const REVIEW_FIX_ATTEMPTS_MAX = 3;
export const REVIEW_LAUNCH_DIGEST_MAX_CHARS = 520;
export const REVIEW_SESSION_DIGEST_MAX_CHARS = 1200;
export const REVIEW_SKILL_ACK_PREFIX = 'Review skill loaded:';

export function sanitizeReviewIdToken(reviewId: string, replacement: string, maxLen: number): string {
  return reviewId.replace(/[^a-zA-Z0-9_-]/g, replacement).slice(0, maxLen) || 'review';
}

export function sanitizeBranchToken(branch: string): string {
  return branch.replace(/[^\w./+-]/g, '').slice(0, REVIEW_BRANCH_TOKEN_MAX_CHARS) || '(unnamed)';
}
