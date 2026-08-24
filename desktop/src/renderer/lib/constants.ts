import type { ProviderHealthLevel, ProviderId } from '../../shared/ipc-types';
import { SIDEBAR_DEFAULT_WIDTH, SIDEBAR_MAX_WIDTH, SIDEBAR_MIN_WIDTH } from '../../shared/sidebar-metrics';

export const AGENT_PROVIDERS: Record<string, ProviderId> = {
  claude: 'anthropic',
  codex: 'openai',
};

export const PROVIDER_HEALTH: Record<ProviderHealthLevel, { color: string; label: string }> = {
  ok: { color: 'var(--success)', label: 'Operational' },
  degraded: { color: 'var(--warning)', label: 'Degraded' },
  down: { color: 'var(--error)', label: 'Critical' },
  unknown: { color: 'var(--text-secondary)', label: 'Status unavailable' },
};

export const SIDEBAR_WIDTH = SIDEBAR_DEFAULT_WIDTH;
export { SIDEBAR_MAX_WIDTH, SIDEBAR_MIN_WIDTH } from '../../shared/sidebar-metrics';

/** Persisted widths are clamped on read so a stale or corrupt value cannot break the layout. */
export function clampSidebarWidth(width: number): number {
  if (!Number.isFinite(width)) return SIDEBAR_WIDTH;
  return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, Math.round(width)));
}
export const SIDEBAR_TOGGLE_LABEL = 'Toggle sidebar';
export const SIDEBAR_TOGGLE_TOOLTIP = 'Toggle sidebar ⌘B';
export const CONTEXT_WINDOW_TOKENS = 200_000;

/**
 * Overlay stacking ladder — the single place these layers are defined.
 * chrome overlays / portalled menus / tooltips (50) < modal surfaces (60) < toasts (70).
 * A modal backdrop must outrank chrome regardless of DOM order, otherwise
 * same-layer chrome rendered later stays clickable through the backdrop.
 * Notifications outrank modal surfaces so a toast is never buried by a backdrop.
 */
export const OVERLAY_CHROME_Z_CLASS = 'z-50';
export const MODAL_SURFACE_Z_CLASS = 'z-[60]';
export const TOAST_Z_CLASS = 'z-[70]';

/** Shared 22x22 metric for icon-only header controls so their centers align across rows. */
export const HEADER_ICON_BUTTON_CLASS =
  'inline-flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-md transition-colors';

/** WCAG 2.2 SC 2.5.8 minimum pointer target, bound to the --control-min token. */
export const MIN_TARGET_BUTTON_CLASS =
  'h-[var(--control-min)] w-[var(--control-min)] shrink-0';

const FILE_EXT_COLORS: Record<string, string> = {
  ts: '#58a6ff', tsx: '#58a6ff', js: '#d29922', jsx: '#d29922',
  py: '#3572a5', yaml: '#d29922', yml: '#d29922', json: '#3fb950',
  md: '#b48ead', css: '#58a6ff', html: '#f85149', sh: '#89e051',
  go: '#00add8', rs: '#dea584', java: '#b07219', sql: '#e38c00',
  toml: '#d29922', gitignore: '#6b7280', env: '#6b7280',
  dockerfile: '#384d54',
};

export function getFileExtColor(filename: string): string {
  if (filename.startsWith('.')) {
    const bare = filename.slice(1);
    if (FILE_EXT_COLORS[bare]) return FILE_EXT_COLORS[bare];
  }
  const dotIdx = filename.lastIndexOf('.');
  const ext = dotIdx >= 0 ? filename.slice(dotIdx + 1).toLowerCase() : '';
  return FILE_EXT_COLORS[ext] ?? 'var(--text-muted)';
}

export const AGENT_STYLES: Record<string, {
  bg: string; text: string; letter: string;
  badgeBg: string; badgeText: string; badgeBorder: string;
}> = {
  claude: {
    bg: 'rgba(139, 92, 246, 0.12)', text: 'var(--agent-brand-claude)', letter: 'C',
    badgeBg: 'rgba(139, 92, 246, 0.18)', badgeText: 'var(--agent-brand-claude-badge)', badgeBorder: 'rgba(139, 92, 246, 0.35)',
  },
  codex: {
    bg: 'rgba(245, 158, 11, 0.12)', text: 'var(--agent-brand-codex)', letter: 'X',
    badgeBg: 'rgba(245, 158, 11, 0.18)', badgeText: 'var(--agent-brand-codex-badge)', badgeBorder: 'rgba(245, 158, 11, 0.35)',
  },
  opencode: {
    bg: 'rgba(125, 211, 252, 0.12)', text: 'var(--agent-brand-opencode)', letter: 'O',
    badgeBg: 'rgba(56, 189, 248, 0.18)', badgeText: 'var(--agent-brand-opencode-badge)', badgeBorder: 'rgba(56, 189, 248, 0.35)',
  },
  pi: {
    bg: 'rgba(124, 131, 255, 0.12)', text: '#7c83ff', letter: 'π',
    badgeBg: 'rgba(124, 131, 255, 0.18)', badgeText: '#7c83ff', badgeBorder: 'rgba(124, 131, 255, 0.35)',
  },
  shell: {
    bg: 'var(--agent-brand-shell-bg)', text: 'var(--agent-brand-shell)', letter: '>',
    badgeBg: 'var(--agent-brand-shell-badge-bg)', badgeText: 'var(--agent-brand-shell-badge)', badgeBorder: 'var(--agent-brand-shell-border)',
  },
};

export function paneSidebarTopLineColor(agentKey: string, selected: boolean): string | undefined {
  if (!selected) return undefined;
  const raw = AGENT_STYLES[agentKey]?.badgeText ?? AGENT_STYLES[agentKey]?.text;
  if (raw) return `color-mix(in srgb, ${raw} 62%, transparent)`;
  return 'color-mix(in srgb, var(--accent) 52%, transparent)';
}

interface ShortcutEntry {
  keys: string;
  action: string;
}

export interface ShortcutGroup {
  label: string;
  shortcuts: ShortcutEntry[];
}

export const SHORTCUT_GROUPS: ShortcutGroup[] = [
  {
    label: 'General',
    shortcuts: [
      { keys: '⌘ K', action: 'Open command palette' },
      { keys: '⌘ P', action: 'Search files by name' },
      { keys: '⌘ F', action: 'Find in open file' },
      { keys: '⌘ ⇧ F', action: 'Search in project files' },
      { keys: '⇧ ⇧', action: 'Search in project files' },
      { keys: '⌘ ,', action: 'Open settings' },
      { keys: '?', action: 'Toggle help overlay' },
    ],
  },
  {
    label: 'Panes',
    shortcuts: [
      { keys: '⌘ N', action: 'Create new pane' },
      { keys: '⌘ J', action: 'Jump to selected pane' },
      { keys: '⌘ ⇧ J', action: 'Jump to next waiting agent' },
      { keys: '⌘ M', action: 'Merge selected pane' },
      { keys: '⌘ W', action: 'Close selected pane' },
      { keys: '⌘ 1-9', action: 'Select pane by index' },
    ],
  },
  {
    label: 'Views',
    shortcuts: [
      { keys: '⌘ B', action: 'Toggle sidebar' },
      { keys: '⌘ ⇧ B', action: 'Toggle board alpha' },
      { keys: '⌘ O', action: 'Open workspace picker' },
      { keys: '⌘ ⌥ Z', action: 'Toggle Zen mode' },
      { keys: 'Esc', action: 'Exit Zen mode' },
    ],
  },
];
