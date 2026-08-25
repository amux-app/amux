import type { AgentName } from 'muxbase/core';
import { ShieldCheck, ShieldAlert } from 'lucide-react';
import { useRef } from 'react';
import { cn } from '../../lib/cn';
import { AgentBrandIcon } from '../shared/agent-brand-icons';
import { AGENT_INFO } from '../create/AgentSelector';

interface ReviewAgentSegmentsProps {
  agents: AgentName[];
  selected: AgentName | undefined;
  onSelect: (agent: AgentName) => void;
}

const SHORT_LABEL: Record<string, string> = {
  claude: 'Claude',
  codex: 'Codex',
  opencode: 'OpenCode',
};

// Per-agent read-only enforcement matrix — surface this to the user so the
// "read-only review" affordance doesn't over-promise. Source of truth:
// src/utils/agentLaunch.ts getReadOnlyFlags.
//  - Codex     → --sandbox read-only --ask-for-approval never (OS sandbox)
//  - Claude    → --permission-mode plan (model/policy-level; user-bypassable)
//  - OpenCode  → --agent plan (model/policy-level; user-bypassable)
type ReviewEnforcement = {
  kind: 'os' | 'model';
  description: string;
};

const ENFORCEMENT_INFO: Record<AgentName, ReviewEnforcement | null> = {
  codex: {
    kind: 'os',
    description: 'Codex runs with an OS-enforced read-only sandbox and approval prompts disabled; write and network attempts fail.',
  },
  claude: {
    kind: 'model',
    description: 'Claude runs in plan mode — read-only by policy. The reviewer can request to exit plan mode; do not approve that prompt.',
  },
  opencode: {
    kind: 'model',
    description: 'OpenCode runs in plan mode — read-only by policy. The reviewer can request to exit plan mode; do not approve that prompt.',
  },
  pi: null,
};

export function ReviewAgentSegments({ agents, selected, onSelect }: ReviewAgentSegmentsProps) {
  const selectedLabel = selected ? SHORT_LABEL[selected] ?? selected : undefined;
  const enforcement = selected ? ENFORCEMENT_INFO[selected] : undefined;
  const groupRef = useRef<HTMLDivElement>(null);

  const handleKeyDown = (e: React.KeyboardEvent, index: number) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const next = e.key === 'ArrowRight'
      ? (index + 1) % agents.length
      : (index - 1 + agents.length) % agents.length;
    onSelect(agents[next]);
    (groupRef.current?.children[next] as HTMLElement | undefined)?.focus();
  };

  return (
    <>
      <div
        ref={groupRef}
        role="radiogroup"
        aria-label="Select reviewer"
        className="flex gap-1 rounded-[11px] border border-[var(--divider)] bg-[color-mix(in_srgb,var(--text)_4%,transparent)] p-1"
      >
        {agents.map((agent, idx) => {
          const isSelected = selected === agent;
          const info = AGENT_INFO[agent];

          return (
            <button
              key={agent}
              type="button"
              role="radio"
              aria-checked={isSelected}
              tabIndex={isSelected ? 0 : -1}
              onClick={() => onSelect(agent)}
              onKeyDown={(e) => handleKeyDown(e, idx)}
              className={cn(
                'flex flex-1 flex-col items-center gap-[5px] rounded-[8px] px-1 py-[9px] text-[var(--text-secondary)] transition-all duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]/60',
                isSelected
                  ? 'bg-[var(--surface)] text-[var(--text)] shadow-[0_1px_2px_color-mix(in_srgb,var(--text)_14%,transparent),0_0_0_1px_var(--divider-strong)]'
                  : 'hover:text-[var(--text)]',
              )}
            >
              <span style={{ color: info?.badgeText }} className="flex items-center justify-center">
                <AgentBrandIcon agent={agent} />
              </span>
              <span className="text-[10.5px] font-semibold leading-none">{SHORT_LABEL[agent] ?? agent}</span>
            </button>
          );
        })}
      </div>

      {selectedLabel && (
        <p className="mx-0.5 mt-[13px] text-[11.5px] text-[var(--text-secondary)]">
          Reviewing with <span className="font-semibold text-[var(--text-secondary)]">{selectedLabel}</span>
        </p>
      )}

      {enforcement && (
        <div
          className={cn(
            'mx-0.5 mt-[8px] flex items-start gap-1.5 rounded-md border px-2 py-1.5 text-[10.5px] leading-snug',
            enforcement.kind === 'os'
              ? 'border-[var(--accent)]/30 bg-[var(--accent)]/5 text-[var(--text-secondary)]'
              : 'border-[color-mix(in_srgb,var(--warning)_40%,transparent)] bg-[color-mix(in_srgb,var(--warning)_12%,transparent)] text-[var(--text-secondary)]',
          )}
        >
          {enforcement.kind === 'os'
            ? <ShieldCheck size={12} className="mt-px shrink-0 text-[var(--accent)]" />
            : <ShieldAlert size={12} className="mt-px shrink-0 text-[var(--warning)]" />
          }
          <span>{enforcement.description}</span>
        </div>
      )}
    </>
  );
}
