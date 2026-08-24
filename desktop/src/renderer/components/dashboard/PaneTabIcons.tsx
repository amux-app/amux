import type { ComponentType } from 'react';
import { cn } from '../../lib/cn';
import type { PaneCellTab } from './PaneCellTabs';

interface TabIconProps {
  size?: number;
  className?: string;
}

const SVG_BASE_PROPS = {
  fill: 'none',
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true,
} as const;

const BASE_STROKE_WIDTH = 1.8;
const ACCENT_STROKE_WIDTH = 2.3;
const BASE_OPACITY = 0.55;

const ACCENT_STROKE_STYLE = { stroke: 'var(--accent)' } as const;
const ACCENT_FILL_STYLE = { fill: 'var(--accent)' } as const;

function TerminalIcon({ size = 12, className }: TabIconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      className={cn('shrink-0', className)}
      {...SVG_BASE_PROPS}
    >
      <polyline
        points="4 17 10 11 4 5"
        stroke="currentColor"
        strokeWidth={BASE_STROKE_WIDTH}
        opacity={BASE_OPACITY}
      />
      <line
        x1="12"
        y1="19"
        x2="20"
        y2="19"
        strokeWidth={ACCENT_STROKE_WIDTH}
        style={ACCENT_STROKE_STYLE}
      />
    </svg>
  );
}

function DiffIcon({ size = 12, className }: TabIconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      className={cn('shrink-0', className)}
      {...SVG_BASE_PROPS}
    >
      <g stroke="currentColor" strokeWidth={BASE_STROKE_WIDTH} opacity={BASE_OPACITY}>
        <line x1="4" y1="6" x2="11" y2="6" />
        <line x1="4" y1="12" x2="11" y2="12" />
        <line x1="4" y1="18" x2="11" y2="18" />
        <line x1="13" y1="6" x2="20" y2="6" />
        <line x1="13" y1="18" x2="20" y2="18" />
      </g>
      <line
        x1="13"
        y1="12"
        x2="20"
        y2="12"
        strokeWidth={ACCENT_STROKE_WIDTH}
        style={ACCENT_STROKE_STYLE}
      />
    </svg>
  );
}

function ActivityIcon({ size = 12, className }: TabIconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      className={cn('shrink-0', className)}
      {...SVG_BASE_PROPS}
    >
      <line
        x1="2"
        y1="12"
        x2="6"
        y2="12"
        stroke="currentColor"
        strokeWidth={BASE_STROKE_WIDTH}
        opacity={BASE_OPACITY}
      />
      <polyline
        points="6 12 9 4 13 20 16 12"
        strokeWidth={BASE_STROKE_WIDTH}
        style={ACCENT_STROKE_STYLE}
      />
      <line
        x1="16"
        y1="12"
        x2="22"
        y2="12"
        stroke="currentColor"
        strokeWidth={BASE_STROKE_WIDTH}
        opacity={BASE_OPACITY}
      />
    </svg>
  );
}

function TokensIcon({ size = 12, className }: TabIconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      className={cn('shrink-0', className)}
      {...SVG_BASE_PROPS}
    >
      <g stroke="currentColor" strokeWidth={BASE_STROKE_WIDTH} opacity={BASE_OPACITY}>
        <line x1="4" y1="9" x2="20" y2="9" />
        <line x1="4" y1="15" x2="20" y2="15" />
        <line x1="10" y1="3" x2="8" y2="21" />
        <line x1="16" y1="3" x2="14" y2="21" />
      </g>
      <circle cx="20" cy="5" r="2.5" stroke="none" style={ACCENT_FILL_STYLE} />
    </svg>
  );
}

function WorktreeIcon({ size = 12, className }: TabIconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      className={cn('shrink-0', className)}
      {...SVG_BASE_PROPS}
    >
      <g stroke="currentColor" strokeWidth={BASE_STROKE_WIDTH} opacity={BASE_OPACITY} fill="none">
        <line x1="6" y1="3" x2="6" y2="15" />
        <circle cx="6" cy="18" r="3" />
        <path d="M18 9a9 9 0 0 1-9 9" />
      </g>
      <circle cx="18" cy="6" r="3" stroke="none" style={ACCENT_FILL_STYLE} />
    </svg>
  );
}

export const PANE_TAB_ICONS = {
  terminal: TerminalIcon,
  diff: DiffIcon,
  activity: ActivityIcon,
  summary: SummaryIcon,
  tokens: TokensIcon,
  worktree: WorktreeIcon,
} satisfies Record<PaneCellTab, ComponentType<TabIconProps>>;

function SummaryIcon({ size = 12, className }: TabIconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      className={cn('shrink-0', className)}
      {...SVG_BASE_PROPS}
    >
      <g stroke="currentColor" strokeWidth={BASE_STROKE_WIDTH} opacity={BASE_OPACITY} fill="none">
        <rect x="4" y="3" width="13" height="18" rx="2" />
        <line x1="7" y1="8" x2="14" y2="8" />
        <line x1="7" y1="12" x2="14" y2="12" />
        <line x1="7" y1="16" x2="11" y2="16" />
      </g>
      <path
        d="M19 6l0.7 1.5L21 8l-1.3 0.5L19 10l-0.7-1.5L17 8l1.3-0.5z"
        stroke="none"
        style={ACCENT_FILL_STYLE}
      />
    </svg>
  );
}
