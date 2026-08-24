const TMUX_VERSION_PATTERN = /^(?:tmux\s+)?(\d+)\.(\d+)([a-z])?$/;

export interface TmuxVersion {
  major: number;
  minor: number;
  suffix: string;
  raw: string;
}

export function parseTmuxVersion(raw: string): TmuxVersion | null {
  const match = raw.trim().match(TMUX_VERSION_PATTERN);
  if (!match) return null;

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    suffix: match[3] ?? '',
    raw: raw.trim(),
  };
}

function suffixRank(suffix: string): number {
  return suffix === '' ? 0 : suffix.charCodeAt(0) - 96;
}

export function compareTmuxVersions(left: TmuxVersion, right: TmuxVersion): number {
  if (left.major !== right.major) return left.major < right.major ? -1 : 1;
  if (left.minor !== right.minor) return left.minor < right.minor ? -1 : 1;
  const leftRank = suffixRank(left.suffix);
  const rightRank = suffixRank(right.suffix);
  if (leftRank === rightRank) return 0;
  return leftRank < rightRank ? -1 : 1;
}

export function isSupportedTmuxVersion(raw: string, minimum: string): boolean {
  const parsed = parseTmuxVersion(raw);
  const required = parseTmuxVersion(minimum);
  if (!parsed || !required) return false;
  return compareTmuxVersions(parsed, required) >= 0;
}
