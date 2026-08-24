import { Bot, Ellipsis, Hourglass, Plus, TerminalSquare } from 'lucide-react';
import { useRef, useState } from 'react';
import { jumpToNextWaitingPane } from '../../hooks/usePaneAttention';
import { useSidebarPreferences } from '../../hooks/useSidebarPreferences';
import { cn } from '../../lib/cn';
import { useUiStore } from '../../stores';
import { SidebarOptionsMenu } from './SidebarOptionsMenu';
import { SIDEBAR_ICON_SIZE, SIDEBAR_TOOL_CLASS } from './SidebarRow';

const ELLIPSIS_ICON_STROKE = 2;
const PLUS_ICON_STROKE = 1.8;
const STAT_CHIP_CLASS = 'inline-flex h-[18px] shrink-0 items-center gap-[3px] whitespace-nowrap text-[12px] leading-none';
const STAT_ICON_SIZE = 12;
const STAT_ICON_STROKE = 1.5;

const LABEL_TEXT_CLASS = 'text-[13px] leading-[1.3] whitespace-nowrap text-[var(--sidebar-text-muted)]';

function waitingAriaLabel(count: number): string {
  return `${count} agent${count === 1 ? '' : 's'} waiting for input`;
}

function terminalCountLabel(count: number): string {
  return `${count} terminal${count === 1 ? '' : 's'}`;
}

function agentCountLabel(count: number): string {
  return `${count} agent${count === 1 ? '' : 's'}`;
}

interface SidebarSectionLabelProps {
  agentCount: number;
  hydrating: boolean;
  onCreate: () => void;
  terminalCount: number;
  waitingCount: number;
}

export function SidebarSectionLabel({
  agentCount,
  hydrating,
  onCreate,
  terminalCount,
  waitingCount,
}: Readonly<SidebarSectionLabelProps>) {
  const organize = useUiStore((s) => s.sidebarOrganize);
  const sort = useUiStore((s) => s.sidebarSort);
  const { setOrganize, setSort } = useSidebarPreferences();
  const menuTriggerRef = useRef<HTMLButtonElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <div className="group @container mt-[6px] flex h-[32px] items-center gap-[6px] px-[8px]">
      <div className="flex min-w-0 items-center gap-[6px] @max-[200px]:hidden">
        <span className="flex h-[16px] w-[16px] shrink-0 items-center justify-center text-[var(--sidebar-nav-icon)]">
          <Bot size={SIDEBAR_ICON_SIZE} strokeWidth={STAT_ICON_STROKE} />
        </span>
        <span className={cn(LABEL_TEXT_CLASS, 'truncate')}>Agents</span>
      </div>
      <span role="status" className="sr-only">
        {waitingCount > 0 ? waitingAriaLabel(waitingCount) : ''}
      </span>
      <div className="flex shrink-0 items-center gap-[8px]">
        {!hydrating && (
          <span
            className={cn(STAT_CHIP_CLASS, 'text-[var(--sidebar-text-muted)]')}
            aria-label={agentCountLabel(agentCount)}
          >
            <Bot
              size={STAT_ICON_SIZE}
              strokeWidth={STAT_ICON_STROKE}
              aria-hidden="true"
              className="hidden @max-[200px]:block"
            />
            <span>{agentCount}</span>
          </span>
        )}
        {!hydrating && terminalCount > 0 && (
          <span
            className={cn(STAT_CHIP_CLASS, 'text-[var(--sidebar-text-muted)]')}
            aria-label={terminalCountLabel(terminalCount)}
          >
            <TerminalSquare
              size={STAT_ICON_SIZE}
              strokeWidth={STAT_ICON_STROKE}
              aria-hidden="true"
            />
            <span>{terminalCount}</span>
          </span>
        )}
        {waitingCount > 0 && (
          <button
            type="button"
            aria-label={waitingAriaLabel(waitingCount)}
            onClick={jumpToNextWaitingPane}
            className={cn(STAT_CHIP_CLASS, 'sidebar-focus rounded-[4px] px-[2px] text-[var(--sidebar-status-waiting)]')}
          >
            <Hourglass size={STAT_ICON_SIZE} strokeWidth={STAT_ICON_STROKE} aria-hidden="true" />
            <span>{waitingCount}</span>
          </button>
        )}
      </div>
      <span
        className={cn(
          'ml-auto flex shrink-0 items-center gap-[2px] transition-opacity duration-150',
          'group-hover:opacity-100 group-focus-within:opacity-100',
          menuOpen ? 'opacity-100' : 'opacity-0',
        )}
      >
        <button
          ref={menuTriggerRef}
          type="button"
          aria-expanded={menuOpen}
          aria-haspopup="menu"
          aria-label="Sidebar options"
          onClick={() => setMenuOpen((open) => !open)}
          className={SIDEBAR_TOOL_CLASS}
        >
          <Ellipsis size={SIDEBAR_ICON_SIZE} strokeWidth={ELLIPSIS_ICON_STROKE} />
        </button>
        <button type="button" aria-label="New agent" onClick={onCreate} className={SIDEBAR_TOOL_CLASS}>
          <Plus size={SIDEBAR_ICON_SIZE} strokeWidth={PLUS_ICON_STROKE} />
        </button>
      </span>
      <SidebarOptionsMenu
        onClose={() => setMenuOpen(false)}
        onOrganizeChange={setOrganize}
        onSortChange={setSort}
        open={menuOpen}
        organize={organize}
        sort={sort}
        triggerRef={menuTriggerRef}
      />
    </div>
  );
}
