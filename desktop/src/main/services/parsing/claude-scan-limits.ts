/**
 * Byte budgets for resolving a Claude session title without reading whole files.
 * Both are measured against 388 real ~/.claude/projects logs.
 */

/**
 * Claude rewrites `ai-title` / `last-prompt` near the end of a session file: the
 * last one sat at most 31 KiB from EOF, so this tail covers every observed file.
 */
export const CLAUDE_TITLE_TAIL_SCAN_BYTES = 64 * 1024;

/**
 * Head fallback for the 1.5% of files whose tail carries no title record at all.
 * Their first user message can sit up to 703 KiB in (injected harness entries and
 * large pastes come first), so the window is far wider than the tail — a read is
 * capped by the file size, and every file that needed this fallback was under 12 KiB.
 */
export const CLAUDE_TITLE_HEAD_SCAN_BYTES = 1024 * 1024;
