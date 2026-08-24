import { createReadStream, type Stats } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { BoundedCache } from '../boundedCache.js';
import { log } from '../Logger.js';
import { statFingerprint } from '../statFingerprint.js';
import { looksBinary, type ParsedStatusEntry } from './gitDiffParser.js';

const LOG_SCOPE = 'git-diff';
const LINE_FEED = 0x0a;
const MAX_INLINE_BYTES = 256 * 1024;
const MAX_COUNT_BYTES = 8 * 1024 * 1024;
export const MAX_UNTRACKED_SCAN_FILES = 2000;
export interface UntrackedFileContent {
  additions: number;
  isBinary: boolean;
  patch?: string;
  tooLarge?: boolean;
}

/** Stands in for a collection that never asked for untracked content, or could not read it. */
export const UNREAD_UNTRACKED_CONTENT: UntrackedFileContent = { additions: 0, isBinary: false };

/**
 * Stands in for an untracked file the scan cap left unread. `tooLarge` is what
 * the diff view already renders as an omitted preview, so a skipped file
 * reports itself instead of looking like an empty change.
 */
export const SKIPPED_UNTRACKED_CONTENT: UntrackedFileContent = {
  additions: 0,
  isBinary: false,
  tooLarge: true,
};

interface LineCount {
  additions: number;
  isBinary: boolean;
  truncated: boolean;
}

interface MemoizedContent {
  content: UntrackedFileContent;
  identity: string;
}

/**
 * Per-worktree state for the untracked scan, owned by the worktree's snapshot
 * entry so closing or evicting a worktree releases it.
 *
 * Counting a file's additions means reading all of it, and the status poll asks
 * for that count for every untracked file whenever anything in the tree moved.
 * A file whose stat fingerprint is unchanged cannot hold a different count, so
 * the memo answers those repeats without opening the file. The bound
 * is the scan cap: one collection's worth of files fits, so a refresh never
 * misses on capacity.
 */
export class UntrackedScanCache {
  private readonly contents = new BoundedCache<MemoizedContent>(MAX_UNTRACKED_SCAN_FILES);
  private capReported = false;

  /**
   * Patch collections are not memoized: their payload is the file content
   * itself, and the view that asks for them does not poll on the status cadence.
   * A read without a stat the caller already took has no identity to key on.
   */
  async read(
    worktreePath: string,
    relativePath: string,
    includePatch: boolean,
    knownStat?: Stats,
  ): Promise<UntrackedFileContent> {
    if (includePatch || !knownStat) {
      return readUntrackedFileContent(worktreePath, relativePath, includePatch, knownStat);
    }

    const identity = statFingerprint(knownStat);
    const memoized = this.contents.get(relativePath);
    if (memoized?.identity === identity) return memoized.content;

    const content = await readUntrackedFileContent(worktreePath, relativePath, false, knownStat);
    if (content !== UNREAD_UNTRACKED_CONTENT) this.contents.set(relativePath, { content, identity });
    return content;
  }

  /** Keeps the cap notice to the refresh that enters the capped state. */
  shouldReportCap(capped: boolean): boolean {
    const report = capped && !this.capReported;
    this.capReported = capped;
    return report;
  }
}

/**
 * Bounds how many untracked files a single collection may open. Repositories
 * that stopped ignoring a large directory would otherwise read tens of
 * thousands of files on every refresh. Files past the cap are reported as
 * skipped rather than as unchanged.
 */
export function selectScannableUntracked(
  parsedStatus: ParsedStatusEntry[],
  cache: UntrackedScanCache = new UntrackedScanCache(),
): Set<string> {
  const untracked = parsedStatus.filter((entry) => entry.status === 'untracked');
  if (cache.shouldReportCap(untracked.length > MAX_UNTRACKED_SCAN_FILES)) {
    log.warn(LOG_SCOPE, 'Untracked file scan capped; skipped files report an omitted preview', {
      limit: MAX_UNTRACKED_SCAN_FILES,
      skipped: untracked.length - MAX_UNTRACKED_SCAN_FILES,
      untrackedFiles: untracked.length,
    });
  }
  return new Set(untracked.slice(0, MAX_UNTRACKED_SCAN_FILES).map((entry) => entry.path));
}

/**
 * `knownStat` is the stat the working signature already took for this path, so a
 * refresh opens each untracked file once instead of stat-ing it twice.
 */
export async function readUntrackedFileContent(
  worktreePath: string,
  relativePath: string,
  includePatch: boolean,
  knownStat?: Stats,
): Promise<UntrackedFileContent> {
  try {
    const fullPath = resolve(worktreePath, relativePath);
    const fileStat = knownStat ?? await stat(fullPath);
    if (!fileStat.isFile()) return UNREAD_UNTRACKED_CONTENT;

    const inlineable = includePatch && fileStat.size <= MAX_INLINE_BYTES;
    return inlineable
      ? buildInlineContent(await readFile(fullPath), relativePath)
      : buildCountedContent(await countLines(fullPath), relativePath, includePatch, fileStat.size);
  } catch (err) {
    log.warn(LOG_SCOPE, 'Could not read untracked file for patch', { path: relativePath, error: String(err) });
    return UNREAD_UNTRACKED_CONTENT;
  }
}

function buildCountedContent(
  count: LineCount,
  relativePath: string,
  includePatch: boolean,
  size: number,
): UntrackedFileContent {
  if (count.isBinary) {
    return {
      additions: 0,
      isBinary: true,
      patch: includePatch ? binaryPatch(relativePath) : undefined,
    };
  }
  return {
    additions: count.additions,
    isBinary: false,
    tooLarge: size > MAX_INLINE_BYTES || count.truncated || undefined,
  };
}

function buildInlineContent(buffer: Buffer, relativePath: string): UntrackedFileContent {
  if (looksBinary(buffer)) {
    return { additions: 0, isBinary: true, patch: binaryPatch(relativePath) };
  }

  const content = buffer.toString('utf8').replace(/\r\n/g, '\n');
  const hasTrailingNewline = content.endsWith('\n');
  const lines = content.length === 0
    ? []
    : (hasTrailingNewline ? content.slice(0, -1) : content).split('\n');

  return {
    additions: lines.length,
    isBinary: false,
    patch: textPatch(relativePath, lines, hasTrailingNewline),
  };
}

/**
 * Counts additions without materialising the file. Matches the inline path
 * exactly: every line feed counts, plus one when the last line is unterminated.
 */
async function countLines(fullPath: string): Promise<LineCount> {
  let newlines = 0;
  let bytesRead = 0;
  let lastByte = LINE_FEED;
  let isBinary = false;
  let truncated = false;

  const stream = createReadStream(fullPath);
  for await (const chunk of stream) {
    const buffer = chunk as Buffer;
    if (bytesRead === 0 && looksBinary(buffer)) {
      isBinary = true;
      break;
    }
    newlines += countLineFeeds(buffer);
    bytesRead += buffer.length;
    lastByte = buffer[buffer.length - 1];
    if (bytesRead >= MAX_COUNT_BYTES) {
      truncated = true;
      break;
    }
  }

  if (isBinary) return { additions: 0, isBinary: true, truncated: false };
  const additions = bytesRead === 0 ? 0 : newlines + (lastByte === LINE_FEED ? 0 : 1);
  return { additions, isBinary: false, truncated };
}

function countLineFeeds(buffer: Buffer): number {
  let count = 0;
  let index = buffer.indexOf(LINE_FEED);
  while (index !== -1) {
    count += 1;
    index = buffer.indexOf(LINE_FEED, index + 1);
  }
  return count;
}

function binaryPatch(relativePath: string): string {
  return [
    ...patchHeader(relativePath),
    `Binary files /dev/null and b/${relativePath} differ`,
    '',
  ].join('\n');
}

function textPatch(relativePath: string, lines: string[], hasTrailingNewline: boolean): string {
  const patchLines = [...patchHeader(relativePath), '--- /dev/null', `+++ b/${relativePath}`];

  if (lines.length > 0) {
    patchLines.push(`@@ -0,0 +1,${lines.length} @@`);
    for (const line of lines) {
      patchLines.push(`+${line}`);
    }
    if (!hasTrailingNewline) {
      patchLines.push('\\ No newline at end of file');
    }
  }
  patchLines.push('');

  return patchLines.join('\n');
}

function patchHeader(relativePath: string): string[] {
  return [
    `diff --git a/${relativePath} b/${relativePath}`,
    'new file mode 100644',
    'index 0000000..0000000',
  ];
}
