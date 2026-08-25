import { type CSSProperties, useCallback, useEffect, useMemo, useRef } from 'react';
import type { AgentName } from 'muxbase/core';
import { AgentBrandIcon } from '../shared/agent-brand-icons';
import { cn } from '../../lib/cn';
import { nextRovingIndex } from '../../lib/roving-tabindex';

export const AGENT_INFO: Record<
  AgentName,
  { label: string; shortLabel: string; description: string; gradient: string; badgeBg: string; badgeText: string; brand: string }
> = {
  claude: {
    label: 'Claude Code',
    shortLabel: 'Claude',
    description: 'Anthropic',
    gradient: 'from-[#d97757] to-[#e5a18a]',
    badgeBg: 'rgba(217,119,87,0.13)',
    badgeText: '#d97757',
    brand: '#d97757',
  },
  codex: {
    label: 'Codex',
    shortLabel: 'Codex',
    description: 'OpenAI',
    gradient: 'from-[#19c37d] to-[#72dcb0]',
    badgeBg: 'rgba(25,195,125,0.13)',
    badgeText: '#19c37d',
    brand: '#19c37d',
  },
  opencode: {
    label: 'OpenCode',
    shortLabel: 'OpenCode',
    description: 'Open-source',
    gradient: 'from-[#9aa4b8] to-[#c6ccd7]',
    badgeBg: 'rgba(154,164,184,0.13)',
    badgeText: '#9aa4b8',
    brand: '#9aa4b8',
  },
  pi: {
    label: 'Pi',
    shortLabel: 'Pi',
    description: 'Multi-provider',
    gradient: 'from-[#7c83ff] to-[#b6baff]',
    badgeBg: 'rgba(124,131,255,0.13)',
    badgeText: '#7c83ff',
    brand: '#7c83ff',
  },
};

type AgentSelectorVariant = 'grid' | 'compact';

interface AgentSelectorProps {
  agents: AgentName[];
  selected: AgentName | undefined;
  onSelect: (agent: AgentName) => void;
  allAgents?: AgentName[];
  ariaLabel?: string;
  autoFocus?: boolean;
  variant?: AgentSelectorVariant;
}

const DEFAULT_AGENTS: AgentName[] = ['claude', 'codex', 'opencode', 'pi'];

function resolveInfo(agent: AgentName) {
  return AGENT_INFO[agent];
}

function useRovingSelection(
  displayAgents: AgentName[],
  agents: AgentName[],
  selected: AgentName | undefined,
  onSelect: (agent: AgentName) => void,
  autoFocus: boolean | undefined,
) {
  const cardRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const isAvailable = useCallback(
    (index: number) => agents.includes(displayAgents[index]),
    [agents, displayAgents],
  );

  const defaultFocusIndex = useMemo(() => {
    const selectedIndex = selected ? displayAgents.indexOf(selected) : -1;
    if (selectedIndex >= 0 && isAvailable(selectedIndex)) return selectedIndex;
    for (let i = 0; i < displayAgents.length; i++) if (isAvailable(i)) return i;
    return 0;
  }, [displayAgents, selected, isAvailable]);

  const initialFocusDoneRef = useRef(false);
  useEffect(() => {
    if (!autoFocus || initialFocusDoneRef.current) return;
    const card = cardRefs.current[defaultFocusIndex];
    if (!card || card.disabled) return;
    card.focus();
    initialFocusDoneRef.current = card === document.activeElement;
  }, [autoFocus, defaultFocusIndex]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    const currentIndex = displayAgents.findIndex((a) => a === selected);
    const start = currentIndex >= 0 ? currentIndex : defaultFocusIndex;
    const next = nextRovingIndex(e.key, start, isAvailable, displayAgents.length);
    if (next === null) return;
    e.preventDefault();
    if (next === start) return;
    onSelect(displayAgents[next]);
    cardRefs.current[next]?.focus();
  }, [displayAgents, selected, defaultFocusIndex, isAvailable, onSelect]);

  const tabIndexFor = useCallback(
    (index: number, available: boolean, isSelected: boolean) =>
      available && (isSelected || (!selected && index === defaultFocusIndex)) ? 0 : -1,
    [selected, defaultFocusIndex],
  );

  return { cardRefs, defaultFocusIndex, handleKeyDown, tabIndexFor };
}

export function AgentSelector({ agents, selected, onSelect, allAgents, ariaLabel = 'Select agent', autoFocus, variant = 'grid' }: AgentSelectorProps) {
  const displayAgents = allAgents ?? DEFAULT_AGENTS;
  const { cardRefs, handleKeyDown, tabIndexFor } = useRovingSelection(
    displayAgents,
    agents,
    selected,
    onSelect,
    autoFocus,
  );
  const compact = variant === 'compact';

  return (
    <div
      className={cn(compact ? 'flex flex-col gap-1.5' : 'grid grid-cols-1 gap-2 sm:grid-cols-2')}
      role="radiogroup"
      aria-label={ariaLabel}
      onKeyDown={handleKeyDown}
    >
      {displayAgents.map((agent, index) => {
        const available = agents.includes(agent);
        const info = resolveInfo(agent);
        const isSelected = selected === agent;
        const registerRef = (el: HTMLButtonElement | null) => { cardRefs.current[index] = el; };
        const commonProps = {
          ref: registerRef,
          type: 'button' as const,
          role: 'radio' as const,
          'aria-checked': isSelected,
          tabIndex: tabIndexFor(index, available, isSelected),
          disabled: !available,
          onClick: () => onSelect(agent),
          onFocus: () => onSelect(agent),
        };

        return compact ? (
          <CompactAgentCard key={agent} agent={agent} info={info} available={available} isSelected={isSelected} buttonProps={commonProps} />
        ) : (
          <GridAgentCard key={agent} agent={agent} info={info} available={available} isSelected={isSelected} buttonProps={commonProps} />
        );
      })}
    </div>
  );
}

type AgentInfo = (typeof AGENT_INFO)[AgentName];
type AgentCardButtonProps = React.ComponentPropsWithRef<'button'>;

interface AgentCardProps {
  agent: AgentName;
  info: AgentInfo;
  available: boolean;
  isSelected: boolean;
  buttonProps: AgentCardButtonProps;
}

function SelectionDot({ isSelected }: { isSelected: boolean }) {
  return (
    <div className={cn(
      'flex h-4 w-4 shrink-0 items-center justify-center rounded-full border transition-all duration-200',
      isSelected
        ? 'border-[var(--agent-brand)] bg-[color-mix(in_srgb,var(--agent-brand)_14%,transparent)] shadow-[0_0_16px_-6px_var(--agent-brand)]'
        : 'border-[var(--divider-strong)] bg-[color-mix(in_srgb,var(--text)_2%,transparent)]',
    )}>
      <span className={cn(
        'h-2 w-2 rounded-full transition-all duration-200',
        isSelected ? 'scale-100 bg-[var(--agent-brand)]' : 'scale-0 bg-transparent',
      )} />
    </div>
  );
}

function GridAgentCard({ agent, info, available, isSelected, buttonProps }: AgentCardProps) {
  return (
    <button
      {...buttonProps}
      style={{ '--agent-brand': info.brand } as CSSProperties}
      className={cn(
        'group relative grid min-h-14 grid-cols-[auto_1fr_auto] items-center gap-2.5 overflow-hidden rounded-xl border px-3 py-2.5 text-left transition-all duration-150',
        isSelected
          ? 'border-transparent bg-[linear-gradient(var(--surface-raised),var(--surface-raised))_padding-box,linear-gradient(120deg,var(--agent-brand),color-mix(in_srgb,var(--agent-brand)_25%,transparent))_border-box] shadow-[0_8px_26px_-14px_var(--agent-brand)]'
          : 'border-[var(--divider)] bg-[color-mix(in_srgb,var(--text)_2%,transparent)] hover:bg-[var(--tool-item-hover-bg)] hover:border-[var(--divider-strong)] hover:-translate-y-0.5',
        !available && 'cursor-not-allowed opacity-40',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-[color-mix(in_srgb,var(--agent-brand)_55%,transparent)]',
      )}
    >
      <div
        className={cn(
          'flex h-[30px] w-[30px] items-center justify-center rounded-[9px] border transition-colors',
          isSelected ? 'border-transparent bg-[linear-gradient(135deg,var(--agent-brand),color-mix(in_srgb,var(--agent-brand)_60%,white))] text-[#12141a]' : 'border-[var(--divider)]',
        )}
        style={!isSelected ? { background: info.badgeBg, color: info.badgeText } : undefined}
      >
        <AgentBrandIcon agent={agent} />
      </div>
      <div className="min-w-0">
        <span className="flex items-center gap-1.5 text-[13px] font-semibold leading-tight text-[var(--text)]">
          {info.shortLabel}
          {agent === 'pi' && <span className="rounded-full border border-[color-mix(in_srgb,var(--agent-brand)_45%,transparent)] px-1.5 py-0.5 text-[8px] font-bold tracking-wider text-[var(--agent-brand)]">NEW</span>}
        </span>
        <span className="mt-0.5 block truncate text-[10.5px] text-[var(--text-muted)]">{info.description}</span>
      </div>
      <SelectionDot isSelected={isSelected} />
    </button>
  );
}

function CompactAgentCard({ agent, info, available, isSelected, buttonProps }: AgentCardProps) {
  return (
    <button
      {...buttonProps}
      style={{ '--agent-brand': info.brand } as CSSProperties}
      className={cn(
        'group flex w-full items-center gap-2.5 rounded-[11px] border px-2.5 py-2 text-left transition-all duration-200',
        isSelected
          ? 'border-[#4a6cf7] bg-[rgba(74,108,247,0.10)] shadow-[0_0_20px_-10px_rgba(74,108,247,0.4)]'
          : 'border-[var(--divider)] bg-[color-mix(in_srgb,var(--text)_2%,transparent)] hover:bg-[var(--tool-item-hover-bg)] hover:border-[var(--divider-strong)]',
        !available && 'opacity-40 cursor-not-allowed',
      )}
    >
      <div
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[9px]"
        style={{ background: info.badgeBg, color: info.badgeText }}
      >
        <AgentBrandIcon agent={agent} size="sm" />
      </div>
      <div className="min-w-0 flex-1">
        <span className="block truncate text-[12px] font-semibold leading-tight text-[var(--text)]">
          {info.label}
        </span>
        <span className="block truncate text-[9.5px] leading-tight text-[var(--text-secondary)]">{info.description}</span>
      </div>
      <SelectionDot isSelected={isSelected} />
    </button>
  );
}
