import type { GitChangedFileStatus, GitDiffFileEntry } from '../../../shared/ipc-types.js';

export interface ParsedStatusEntry {
  path: string;
  oldPath?: string;
  status: GitChangedFileStatus;
  staged: boolean;
  unstaged: boolean;
}

export interface TrackedDiffStat {
  path: string;
  oldPath?: string;
  status: GitChangedFileStatus;
  additions: number;
  deletions: number;
}

export interface WorkingTreeDiffData {
  diff: string;
  files: GitDiffFileEntry[];
  filesChanged: number;
  insertions: number;
  deletions: number;
  changedFiles: string[];
  untrackedFiles: string[];
}

export const EMPTY_PATCH_STATS = {
  additions: 0,
  deletions: 0,
  isBinary: false,
};

interface DiffHeaderInfo {
  path: string;
  oldPath?: string;
  status: GitChangedFileStatus;
}

export function summarizeGitDiffFiles(files: GitDiffFileEntry[]): Omit<WorkingTreeDiffData, 'diff' | 'files'> {
  return {
    filesChanged: files.length,
    insertions: files.reduce((sum, file) => sum + (file.additions || 0), 0),
    deletions: files.reduce((sum, file) => sum + (file.deletions || 0), 0),
    changedFiles: files.map((file) => file.path),
    untrackedFiles: files.filter((file) => file.status === 'untracked').map((file) => file.path),
  };
}

export function parsePorcelainV1Z(output: string): ParsedStatusEntry[] {
  if (!output) return [];

  const tokens = output.split('\0');
  const entries: ParsedStatusEntry[] = [];

  for (let index = 0; index < tokens.length; index += 1) {
    let token = tokens[index];
    if (!token) continue;
    // execAsync trims stdout, which strips a leading space when the X column
    // is empty (e.g. unstaged-only ` M README.md` → `M README.md`). Restore it
    // so the slice indexes line up with the porcelain `XY <path>` format.
    if (token.length >= 3 && token[2] !== ' ') {
      token = ` ${token}`;
    }
    if (token.length < 3) continue;

    const xy = token.slice(0, 2);
    let path = token.slice(3);
    let oldPath: string | undefined;

    const x = xy[0];
    const y = xy[1];
    const hasRenameOrCopy = x === 'R' || y === 'R' || x === 'C' || y === 'C';
    if (hasRenameOrCopy) {
      const nextToken = tokens[index + 1];
      if (nextToken) {
        oldPath = nextToken;
        index += 1;
      }
    }

    if (!path) continue;

    entries.push({
      path,
      oldPath,
      status: mapGitStatus(xy),
      staged: xy !== '??' && xy[0] !== ' ' && xy[0] !== '?',
      unstaged: xy === '??' || (xy[1] !== ' ' && xy[1] !== '?'),
    });
  }

  return entries;
}

function mapGitStatus(xy: string): GitChangedFileStatus {
  if (xy === '??') return 'untracked';
  if (xy === '!!') return 'unknown';
  const x = xy[0];
  const y = xy[1];

  const hasConflict =
    x === 'U' || y === 'U' || xy === 'AA' || xy === 'DD' || xy === 'AU' || xy === 'UA' || xy === 'DU' || xy === 'UD';
  if (hasConflict) return 'conflict';
  if (x === 'R' || y === 'R') return 'renamed';
  if (x === 'C' || y === 'C') return 'copied';
  if (x === 'A' || y === 'A') return 'added';
  if (x === 'D' || y === 'D') return 'deleted';
  if (x === 'T' || y === 'T') return 'typechange';
  if (x === 'M' || y === 'M') return 'modified';
  return 'unknown';
}

function toParsedStatusFromPatch(path: string, patch: string): ParsedStatusEntry {
  const headerInfo = extractDiffHeaderInfo(path, patch);
  return {
    path: headerInfo.path,
    oldPath: headerInfo.oldPath,
    status: headerInfo.status,
    staged: true,
    unstaged: false,
  };
}

function extractDiffHeaderInfo(path: string, patch: string): DiffHeaderInfo {
  const lines = patch.split('\n');
  const firstLine = lines[0] ?? '';
  const match = firstLine.match(/^diff --git a\/(.+?) b\/(.+)$/);

  let oldPath = match ? dequoteGitPath(match[1]) : undefined;
  let nextPath = match ? dequoteGitPath(match[2]) : path;
  let status: GitChangedFileStatus = 'modified';
  let typeChangeSeen = false;

  for (const line of lines.slice(1, 40)) {
    if (line.startsWith('rename from ')) {
      oldPath = dequoteGitPath(line.slice('rename from '.length));
      status = 'renamed';
      continue;
    }
    if (line.startsWith('rename to ')) {
      nextPath = dequoteGitPath(line.slice('rename to '.length));
      status = 'renamed';
      continue;
    }
    if (line.startsWith('copy from ')) {
      oldPath = dequoteGitPath(line.slice('copy from '.length));
      status = 'copied';
      continue;
    }
    if (line.startsWith('copy to ')) {
      nextPath = dequoteGitPath(line.slice('copy to '.length));
      status = 'copied';
      continue;
    }
    if (line.startsWith('new file mode ')) {
      status = 'added';
      continue;
    }
    if (line.startsWith('deleted file mode ')) {
      status = 'deleted';
      continue;
    }
    if (line.startsWith('old mode ') || line.startsWith('new mode ')) {
      typeChangeSeen = true;
      continue;
    }
  }

  if (status === 'modified' && typeChangeSeen) {
    status = 'typechange';
  }

  if (oldPath === nextPath) {
    oldPath = undefined;
  }

  return {
    path: nextPath,
    oldPath,
    status,
  };
}

export function splitDiffByFile(diffText: string): Map<string, string> {
  const map = new Map<string, string>();
  if (!diffText) return map;

  const lines = diffText.split('\n');
  let chunk: string[] = [];

  const flush = () => {
    if (chunk.length === 0) return;
    const patch = chunk.join('\n').trim();
    chunk = [];
    if (!patch) return;
    const path = extractDiffPathFromPatch(patch);
    if (!path) return;
    const nextPatch = `${patch}\n`;
    const existingPatch = map.get(path);
    map.set(path, existingPatch ? `${existingPatch.trimEnd()}\n\n${nextPatch}` : nextPatch);
  };

  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      flush();
    }
    chunk.push(line);
  }
  flush();

  return map;
}

function extractDiffPathFromPatch(patch: string): string | null {
  const lines = patch.split('\n');
  let fromHeaderA: string | null = null;
  let fromHeaderB: string | null = null;

  const first = lines[0] ?? '';
  const match = first.match(/^diff --git a\/(.+?) b\/(.+)$/);
  if (match) {
    fromHeaderA = dequoteGitPath(match[1]);
    fromHeaderB = dequoteGitPath(match[2]);
  }

  for (const line of lines.slice(1, 12)) {
    if (line.startsWith('+++ ')) {
      if (line === '+++ /dev/null') {
        continue;
      }
      if (line.startsWith('+++ b/')) {
        return dequoteGitPath(line.slice(6));
      }
      return dequoteGitPath(line.slice(4));
    }
  }

  if (fromHeaderB && fromHeaderB !== '/dev/null') return fromHeaderB;
  if (fromHeaderA && fromHeaderA !== '/dev/null') return fromHeaderA;
  return null;
}

function dequoteGitPath(value: string): string {
  const trimmed = value.trim();
  if (!(trimmed.startsWith('"') && trimmed.endsWith('"'))) {
    return trimmed;
  }
  return trimmed
    .slice(1, -1)
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\');
}

export function countPatchStats(patch: string | undefined): { additions: number; deletions: number; isBinary: boolean } {
  if (!patch) return { additions: 0, deletions: 0, isBinary: false };
  const isBinary = /(^|\n)(Binary files |GIT binary patch)/.test(patch);
  if (isBinary) return { additions: 0, deletions: 0, isBinary: true };

  let additions = 0;
  let deletions = 0;
  for (const line of patch.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) additions += 1;
    else if (line.startsWith('-')) deletions += 1;
  }
  return { additions, deletions, isBinary: false };
}

export function looksBinary(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, Math.min(buffer.length, 8000));
  for (let index = 0; index < sample.length; index += 1) {
    if (sample[index] === 0) return true;
  }
  return false;
}

export function sortGitDiffFiles(files: GitDiffFileEntry[]): GitDiffFileEntry[] {
  const statusRank: Record<GitChangedFileStatus, number> = {
    modified: 0,
    added: 1,
    deleted: 2,
    renamed: 3,
    copied: 4,
    typechange: 5,
    untracked: 6,
    conflict: 7,
    unknown: 8,
  };

  return [...files].sort((a, b) => {
    const rankDiff = (statusRank[a.status] ?? 99) - (statusRank[b.status] ?? 99);
    if (rankDiff !== 0) return rankDiff;
    return a.path.localeCompare(b.path);
  });
}

function mapRawDiffStatus(statusCode: string): GitChangedFileStatus {
  switch (statusCode) {
    case 'A': return 'added';
    case 'C': return 'copied';
    case 'D': return 'deleted';
    case 'M': return 'modified';
    case 'R': return 'renamed';
    case 'T': return 'typechange';
    default: return 'unknown';
  }
}

export function parseRawDiffWithNumstat(raw: string | null): Map<string, TrackedDiffStat> {
  const changes: Array<Omit<TrackedDiffStat, 'additions' | 'deletions'>> = [];
  const numStats = new Map<string, { additions: number; deletions: number }>();

  if (!raw) return new Map<string, TrackedDiffStat>();

  let index = 0;
  const segments = raw.split('\0').filter(Boolean);

  while (index < segments.length) {
    const segment = segments[index++];
    if (!segment) break;

    if (segment.startsWith(':')) {
      const [, , , , change] = segment.split(' ');
      const filePath = segments[index++];
      if (!filePath) break;

      let path = filePath;
      let oldPath: string | undefined;
      const statusCode = change?.[0] ?? '';

      if (statusCode === 'R' || statusCode === 'C') {
        const renamedPath = segments[index++];
        if (renamedPath) {
          oldPath = filePath;
          path = renamedPath;
        }
      }

      changes.push({ path, oldPath, status: mapRawDiffStatus(statusCode) });
      continue;
    }

    const [additionsRaw, deletionsRaw, filePath] = segment.split('\t');
    if (additionsRaw === undefined || deletionsRaw === undefined || filePath === undefined) continue;

    let numstatPath = filePath;
    if (numstatPath === '') {
      index += 1;
      numstatPath = segments[index++] ?? '';
    }

    if (!numstatPath) continue;

    numStats.set(numstatPath, {
      additions: additionsRaw === '-' ? 0 : parseInt(additionsRaw, 10) || 0,
      deletions: deletionsRaw === '-' ? 0 : parseInt(deletionsRaw, 10) || 0,
    });
  }

  const trackedStats = new Map<string, TrackedDiffStat>();

  for (const change of changes) {
    const stats = numStats.get(change.path) ?? { additions: 0, deletions: 0 };
    trackedStats.set(change.path, {
      ...change,
      additions: stats.additions,
      deletions: stats.deletions,
    });
  }

  for (const [path, stats] of numStats.entries()) {
    if (trackedStats.has(path)) continue;
    trackedStats.set(path, {
      path,
      status: 'modified',
      additions: stats.additions,
      deletions: stats.deletions,
    });
  }

  return trackedStats;
}

export function mergeTrackedDiffStats(...maps: Array<Map<string, TrackedDiffStat>>): Map<string, TrackedDiffStat> {
  const merged = new Map<string, TrackedDiffStat>();

  for (const map of maps) {
    for (const stat of map.values()) {
      const existing = merged.get(stat.path);
      if (!existing) {
        merged.set(stat.path, { ...stat });
        continue;
      }

      existing.additions += stat.additions;
      existing.deletions += stat.deletions;
      existing.oldPath ??= stat.oldPath;
      if (existing.status === 'unknown' && stat.status !== 'unknown') {
        existing.status = stat.status;
      }
    }
  }

  return merged;
}

export function parseDiffToStatusEntries(diffText: string): { trackedDiffText: string; parsedStatus: ParsedStatusEntry[] } {
  if (!diffText.trim()) return { trackedDiffText: '', parsedStatus: [] };
  const patchByPath = splitDiffByFile(diffText);
  const parsedStatus = Array.from(patchByPath.entries())
    .map(([path, patch]) => toParsedStatusFromPatch(path, patch));
  return { trackedDiffText: diffText, parsedStatus };
}

export const __test__ = {
  extractDiffHeaderInfo,
  parseRawDiffWithNumstat,
  splitDiffByFile,
  summarizeGitDiffFiles,
  toParsedStatusFromPatch,
};
