import type { AgentName } from 'muxbase/core';
import { Loader2 } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { listAgents } from '../../api/agent.api';
import { usePaneActions } from '../../hooks/usePaneActions';
import { cn } from '../../lib/cn';
import { HEADER_ICON_BUTTON_CLASS } from '../../lib/constants';
import { useReviewLaunchStore } from '../../stores/review-launch.store';
import { AnchoredMenu } from '../shared/AnchoredMenu';
import { HoverTooltip } from '../shared/HoverTooltip';
import { ReviewAgentSegments } from './ReviewAgentSegments';

interface ReviewLaunchButtonProps {
  paneId: string;
  defaultAgent?: AgentName;
  highlight?: boolean;
}

type LoadState = 'idle' | 'loading' | 'ready' | 'error';

function AuroraLoupeIcon() {
  const BASE_STROKE_WIDTH = 1.8;
  const ACCENT_STROKE_WIDTH = 2.3;
  const BASE_OPACITY = 0.55;
  const ACCENT_STROKE_STYLE = { stroke: 'var(--accent)' } as const;

  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="shrink-0"
      aria-hidden
    >
      <g stroke="currentColor" strokeWidth={BASE_STROKE_WIDTH} opacity={BASE_OPACITY}>
        <circle cx="10" cy="10" r="6" />
        <line x1="14.5" y1="14.5" x2="20" y2="20" />
      </g>
      <polyline
        points="7.5 10.5 9.5 12.5 12.5 8.5"
        strokeWidth={ACCENT_STROKE_WIDTH}
        style={ACCENT_STROKE_STYLE}
      />
    </svg>
  );
}

export function ReviewLaunchButton({ paneId, defaultAgent, highlight }: ReviewLaunchButtonProps) {
  const { startReview } = usePaneActions();
  const isLaunching = useReviewLaunchStore((s) => s.launchingIds.has(paneId));
  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [loadState, setLoadState] = useState<LoadState>('idle');
  const [agents, setAgents] = useState<AgentName[]>([]);
  const [selected, setSelected] = useState<AgentName | undefined>(defaultAgent);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const loadAgents = useCallback(() => {
    setLoadState('loading');
    listAgents('review').then((available) => {
      setAgents(available);
      setSelected((current) => (current && available.includes(current) ? current : available[0]));
      setLoadState('ready');
    }).catch(() => setLoadState('error'));
  }, []);

  // Lazy-load the agent list the first time the popover opens.
  useEffect(() => {
    if (open && loadState === 'idle') {
      loadAgents();
    }
  }, [open, loadState, loadAgents]);

  // Close popover when a launch begins (e.g. from kebab menu on same pane).
  useEffect(() => {
    if (isLaunching) setOpen(false);
  }, [isLaunching]);

  const popoverOpen = open && !isLaunching;
  const canStart = !submitting && !isLaunching && loadState === 'ready' && !!selected && agents.includes(selected);

  const handleStart = async () => {
    if (!canStart || !selected) return;
    setSubmitting(true);
    try {
      await startReview(paneId, selected);
      setOpen(false);
    } finally {
      setSubmitting(false);
    }
  };

  const renderBody = () => {
    if (loadState === 'error') {
      return (
        <div className="text-[11px] text-[var(--text-secondary)]">
          <p className="mb-2">Couldn't load agents.</p>
          <button
            onClick={loadAgents}
            className="w-full rounded-md border border-[var(--border)] px-2 py-1.5 text-xs font-medium text-[var(--text)] hover:bg-[var(--surface)]"
          >
            Retry
          </button>
        </div>
      );
    }
    if (loadState === 'ready' && agents.length === 0) {
      return <p className="text-[11px] text-[var(--text-secondary)]">No agents available.</p>;
    }
    return (
      <>
        <p className="mb-[10px] text-[11px] font-semibold uppercase tracking-[0.04em] text-[var(--text-secondary)]">
          Review with
        </p>
        <ReviewAgentSegments agents={agents} selected={selected} onSelect={setSelected} />
        <button
          onClick={handleStart}
          disabled={!canStart}
          className="mt-[11px] h-9 w-full rounded-[10px] bg-[var(--accent)] text-[13px] font-[650] text-[var(--accent-contrast)] transition-all duration-150 hover:brightness-110 disabled:opacity-50 disabled:hover:brightness-100"
        >
          {submitting || isLaunching ? 'Starting…' : loadState === 'loading' || loadState === 'idle' ? 'Loading…' : 'Start Review'}
        </button>
      </>
    );
  };

  return (
    <div>
      <HoverTooltip
        className="inline-flex"
        label={isLaunching ? 'Starting review…' : 'Start review'}
        suppressed={popoverOpen}
      >
        <button
          ref={triggerRef}
          onClick={(e) => { e.stopPropagation(); if (!isLaunching) setOpen((v) => !v); }}
          disabled={isLaunching}
          className={cn(
            HEADER_ICON_BUTTON_CLASS,
            'text-[var(--text-muted)] hover:bg-[var(--surface-raised)] hover:text-[var(--text)]',
            highlight && !isLaunching && 'text-[var(--text)]',
            isLaunching && 'opacity-60 cursor-default',
          )}
          aria-label="Start review"
          aria-busy={isLaunching}
          aria-haspopup="dialog"
          aria-expanded={popoverOpen}
        >
          {isLaunching
            ? <Loader2 size={12} className="animate-spin" />
            : <AuroraLoupeIcon />
          }
        </button>
      </HoverTooltip>
      <AnchoredMenu
        className="w-64 rounded-[14px] border border-[var(--divider-strong)] bg-[var(--surface-raised)] shadow-[0_16px_50px_-12px_color-mix(in_srgb,var(--text)_22%,transparent)]"
        label="Start review"
        onClose={() => setOpen(false)}
        open={popoverOpen}
        role="dialog"
        triggerRef={triggerRef}
      >
        <div className="p-[14px]" onClick={(e) => e.stopPropagation()}>
          {renderBody()}
        </div>
      </AnchoredMenu>
    </div>
  );
}
