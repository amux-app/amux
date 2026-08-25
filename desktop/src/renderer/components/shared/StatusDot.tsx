import type { AgentStatus } from 'muxbase/core';
import type { PaneActivityState } from '../../../shared/pane-activity';
import { Check } from 'lucide-react';
import type { CSSProperties } from 'react';
import { cn } from '../../lib/cn';

type Visual = AgentStatus | PaneActivityState | 'ready';

const SIZE_MAP = {
  xs: { box: 'h-[6px] w-[6px]', check: 5 },
  sm: { box: 'h-2 w-2', check: 6 },
  md: { box: 'h-2.5 w-2.5', check: 7 },
  lg: { box: 'h-3 w-3', check: 8 },
} as const;

/** Flat dots take their colour from the caller's `--dot-color`, so the sidebar can paint its own status scale. */
const FLAT_STYLE: CSSProperties = { backgroundColor: 'var(--dot-color, currentColor)' };

const STATUS_CLASS: Record<Visual, string> = {
  idle: 'bg-[var(--agent-idle)]',
  working: 'bg-[var(--agent-working)] animate-[pulse-dot_1.5s_ease-in-out_infinite]',
  waiting: 'bg-[var(--agent-waiting)] shadow-[0_0_6px_var(--agent-waiting)]',
  analyzing: 'bg-[var(--agent-analyzing)] animate-[pulse-dot_3s_ease-in-out_infinite]',
  starting: 'bg-[var(--agent-idle)] animate-pulse opacity-60',
  stopped: 'bg-[var(--text-secondary)] opacity-45',
  unknown: 'bg-transparent',
  ready: 'bg-[var(--attention-ready-dot)] shadow-[0_0_7px_var(--attention-ready-dot)]',
};

/**
 * Ready ships flat: every white highlight strong enough to be visible drops the
 * check below 4.5:1 in the light themes (locked in theme-contrast.test.ts).
 */
const STATUS_STYLE: Partial<Record<Visual, CSSProperties>> = {
  idle: {
    backgroundImage: 'radial-gradient(circle at 30% 25%, color-mix(in srgb, var(--agent-idle) 45%, white), transparent 70%)',
    boxShadow: '0 0 5px color-mix(in srgb, var(--agent-idle) 38%, transparent)',
  },
  working: {
    backgroundImage: 'radial-gradient(circle at 30% 25%, color-mix(in srgb, var(--agent-working) 45%, white), transparent 70%)',
  },
  waiting: {
    backgroundImage: 'radial-gradient(circle at 30% 25%, color-mix(in srgb, var(--agent-waiting) 50%, white), transparent 70%)',
  },
  analyzing: {
    backgroundImage: 'radial-gradient(circle at 30% 25%, color-mix(in srgb, var(--agent-analyzing) 45%, white), transparent 70%)',
  },
  starting: { opacity: 0.6 },
  stopped: { opacity: 0.45 },
};

interface StatusDotProps {
  status: AgentStatus | PaneActivityState;
  ready?: boolean;
  readyLabel?: string;
  size?: keyof typeof SIZE_MAP;
  variant?: 'default' | 'flat';
  className?: string;
}

export function StatusDot({ status, ready = false, readyLabel = 'Ready for review', size = 'md', variant = 'default', className }: StatusDotProps) {
  const visual: Visual = ready ? 'ready' : status;
  const sizing = SIZE_MAP[size];
  const flat = variant === 'flat';

  return (
    <span
      role="status"
      aria-label={ready ? readyLabel : status}
      className={cn(
        'relative inline-flex shrink-0 items-center justify-center rounded-full',
        sizing.box,
        !flat && STATUS_CLASS[visual],
        className,
      )}
      style={flat ? FLAT_STYLE : STATUS_STYLE[visual]}
    >
      {ready && (
        <Check
          size={sizing.check}
          strokeWidth={3.5}
          className="relative z-[1] text-[var(--attention-ready-icon)]"
        />
      )}
    </span>
  );
}
