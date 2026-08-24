// Matches OpenCode's `isDefaultTitle` (packages/opencode/src/session/session.ts):
// titles assigned at creation when the AI title-generator hasn't run yet.
const OPENCODE_DEFAULT_TITLE_REGEX = /^(New session - |Child session - )\d{4}-\d{2}-\d{2}T.+Z$/;

/** True when an OpenCode session still carries its creation-time placeholder title. */
export function isOpencodeDefaultTitle(title: string | undefined): boolean {
  const trimmed = title?.trim();
  return !trimmed || OPENCODE_DEFAULT_TITLE_REGEX.test(trimmed);
}
