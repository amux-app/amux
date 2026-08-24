import { useRef, useState } from 'react';
import { usePaneAttention } from '../../hooks/usePaneAttention';
import { cn } from '../../lib/cn';
import { HoverTooltip } from '../shared/HoverTooltip';
import { AttentionPeek } from './AttentionPeek';

const ATTENTION_SHORTCUT = '⌘⇧J';
const MAX_DISPLAYED_COUNT = 99;
const NO_DRAG_CLASS = '[-webkit-app-region:no-drag]';
const STAT_ACTION_HINT = 'Open waiting agents.';
const ZEN_ACTION_HINT = 'Jump to next.';

const BUTTON_CLASS = cn(
  NO_DRAG_CLASS,
  'cursor-pointer rounded-sm text-[var(--attention-waiting-text)] hover:underline',
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]/50',
);
const ZEN_BUTTON_CLASS = 'inline-flex h-6 min-w-6 items-center justify-center px-1 text-xs font-medium';

const ATTENTION_STAT_TEST_ID = 'resource-attention-stat';
const ZEN_ATTENTION_TEST_ID = 'zen-attention-stat';

interface AttentionStatProps {
  variant: 'stat' | 'zen';
}

function formatAttentionCount(count: number): string {
  return count > MAX_DISPLAYED_COUNT ? `${MAX_DISPLAYED_COUNT}+` : String(count);
}

export function AttentionStat({ variant }: AttentionStatProps) {
  const { jumpToNextWaitingPane, waitingCount, waitingItems } = usePaneAttention();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [peekOpen, setPeekOpen] = useState(false);

  // The Zen numeral has no room for a list, so it keeps the direct jump.
  const zen = variant === 'zen';
  // The stat unmounts its subtree when the fleet goes quiet; without this the
  // peek would reappear on its own the next time an agent starts waiting.
  if (peekOpen && waitingCount === 0) setPeekOpen(false);
  if (waitingCount === 0) return null;

  const count = formatAttentionCount(waitingCount);
  const closePeek = () => setPeekOpen(false);

  return (
    <>
      {!zen && <span className={cn('text-[var(--border)]', NO_DRAG_CLASS)}>|</span>}
      <HoverTooltip
        align={zen ? 'end' : 'center'}
        className={cn('inline-flex', NO_DRAG_CLASS)}
        label={`${count} agents waiting for input · ${ATTENTION_SHORTCUT}`}
        suppressed={peekOpen}
      >
        <button
          aria-expanded={zen ? undefined : peekOpen}
          aria-haspopup={zen ? undefined : 'menu'}
          aria-label={`${count} agents waiting for input. ${zen ? ZEN_ACTION_HINT : STAT_ACTION_HINT}`}
          className={cn(BUTTON_CLASS, zen && ZEN_BUTTON_CLASS)}
          data-testid={zen ? ZEN_ATTENTION_TEST_ID : ATTENTION_STAT_TEST_ID}
          onClick={zen ? jumpToNextWaitingPane : () => setPeekOpen((open) => !open)}
          ref={triggerRef}
          type="button"
        >
          {zen ? count : `${count} waiting`}
        </button>
      </HoverTooltip>
      {!zen && (
        <AttentionPeek items={waitingItems} onClose={closePeek} open={peekOpen} triggerRef={triggerRef} />
      )}
    </>
  );
}
