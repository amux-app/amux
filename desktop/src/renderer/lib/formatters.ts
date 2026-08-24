import { useProjectStore } from '../stores/project.store';

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const MONTH = 30 * DAY;
const YEAR = 365 * DAY;

const AGENT_LABELS: Record<string, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
  pi: 'Pi',
};

export function formatAgentLabel(agent: string | undefined): string {
  if (!agent) return 'Terminal';
  return AGENT_LABELS[agent] ?? agent;
}

export function formatRelativeTime(date: Date | string | number): string {
  const ts = typeof date === 'number' ? date : new Date(date).getTime();
  const diff = Math.max(0, Date.now() - ts);

  if (diff < MINUTE) return 'just now';
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)}m ago`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)}h ago`;
  if (diff < MONTH) return `${Math.floor(diff / DAY)}d ago`;
  if (diff < YEAR) return `${Math.floor(diff / MONTH)}mo ago`;
  return `${Math.floor(diff / YEAR)}y ago`;
}

// Calendar-day labels for session pickers ("Today", "Yesterday", then falls back to formatRelativeTime).
// Returns an empty string for invalid timestamps (0 or NaN) so callers can hide the field.
export function formatSessionDate(updatedAt: number): string {
  if (!updatedAt) return '';
  const diffDays = Math.floor((Date.now() - updatedAt) / DAY);
  if (diffDays === 0) {
    const time = new Date(updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return `Today · ${time}`;
  }
  if (diffDays === 1) return 'Yesterday';
  return formatRelativeTime(updatedAt);
}

// Paths lose their head, never their tail: the trailing segments identify the project.
export function truncatePath(path: string, maxLen = 45): string {
  if (path.length <= maxLen) return path;
  const home = collapseHomePrefix(path);
  if (home.length <= maxLen) return home;
  return '...' + home.slice(home.length - maxLen + 3);
}

// The real home dir arrives from the boot session payload; the /Users heuristic
// only covers macOS and only kicks in before that payload has loaded.
function collapseHomePrefix(path: string): string {
  const homeDir = useProjectStore.getState().homeDir;
  if (homeDir) {
    const normalizedHome = homeDir.replace(/[\\/]+$/, '') || homeDir;
    const suffix = path.slice(normalizedHome.length);
    if (path === normalizedHome || (
      path.startsWith(normalizedHome)
      && (suffix.startsWith('/') || suffix.startsWith('\\'))
    )) {
      return `~${suffix}`;
    }
    return path;
  }
  return path.replace(/^\/Users\/[^/]+/, '~');
}

// Collapses newlines to spaces before truncating \u2014 for single-line previews.
export function truncateOneLine(text: string, maxLen: number): string {
  const oneLine = text.replace(/\n/g, ' ').trim();
  if (oneLine.length <= maxLen) return oneLine;
  return oneLine.slice(0, maxLen).trimEnd() + '...';
}

// Elapsed seconds \u2192 "12m 3s" / "2m" / "3s".
export function formatDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (m === 0) return `${s}s`;
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
}

// Elapsed time between two epoch-ms timestamps, formatted like formatDuration.
export function formatSessionOffset(
  timestamp: number | undefined,
  sessionStart: number | undefined,
): string {
  if (timestamp == null || sessionStart == null) return '';
  return formatDuration(Math.max(0, Math.floor((timestamp - sessionStart) / 1000)));
}

// Coarse wall-clock span \u2192 "45s" / "1.5m".
export function formatCompactDuration(sec: number): string {
  return sec < 60 ? `${sec.toFixed(0)}s` : `${(sec / 60).toFixed(1)}m`;
}

// Sub-second-aware span \u2192 "350ms" / "1.5s".
export function formatMillis(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

export function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export function formatUSD(usd: number): string {
  if (!Number.isFinite(usd) || usd === 0) return '$0';
  if (usd < 1) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

export function formatPercent(ratio: number): string {
  return `${Math.round(ratio * 100)}%`;
}

// Empirically observed from HAI's TUI across multiple sessions: 0.529–0.544.
// Mean clusters around 0.539. HAI's TUI rounds €, so this is good to ~1%.
const EUR_HAI_RATE = 0.539;
const EUR_MARKET_RATE = 0.92;

export type CostCurrency = 'USD' | 'EUR-hai' | 'EUR-market';

export function formatCost(usd: number, currency: CostCurrency): string {
  if (!Number.isFinite(usd) || usd === 0) {
    return currency === 'USD' ? '$0' : '€0';
  }
  if (currency === 'USD') {
    return usd < 1 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
  }
  const rate = currency === 'EUR-hai' ? EUR_HAI_RATE : EUR_MARKET_RATE;
  const eur = usd * rate;
  return eur < 1 ? `€${eur.toFixed(4)}` : `€${eur.toFixed(2)}`;
}
