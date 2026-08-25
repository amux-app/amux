import type { AgentName } from 'muxbase/core';
import type { AgentDefaultsResponse } from '../../../shared/ipc-types';
import { AgentSelector } from './AgentSelector';
import { AgentTuning } from './AgentTuning';
import { cn } from '../../lib/cn';

type DuelSideAccent = 'a' | 'b';

const ACCENT: Record<DuelSideAccent, { label: string; bar: string; dot: string; text: string }> = {
  a: { label: 'Side A', bar: '#6366f1', dot: 'bg-[#6366f1]', text: 'text-indigo-500' },
  b: { label: 'Side B', bar: '#14b8a6', dot: 'bg-[#14b8a6]', text: 'text-teal-600' },
};

interface DuelSideCardProps {
  accent: DuelSideAccent;
  agents: AgentName[];
  agent: AgentName | undefined;
  onAgentSelect: (agent: AgentName) => void;
  model: string | undefined;
  effort: string | undefined;
  onModelChange: (value: string | undefined) => void;
  onEffortChange: (value: string | undefined) => void;
  agentDefaults: AgentDefaultsResponse | null;
  autoFocus?: boolean;
  order?: AgentName[];
}

export function DuelSideCard({
  accent,
  agents,
  agent,
  onAgentSelect,
  model,
  effort,
  onModelChange,
  onEffortChange,
  agentDefaults,
  autoFocus,
  order,
}: DuelSideCardProps) {
  const skin = ACCENT[accent];

  return (
    <div className="relative flex flex-col gap-2.5 overflow-hidden rounded-[14px] border border-[var(--divider)] bg-[color-mix(in_srgb,var(--text)_2%,transparent)] p-3">
      <div className="h-[2px] w-full rounded-full opacity-80" style={{ background: skin.bar }} />
      <div className="flex items-center gap-2">
        <span className={cn('h-1.5 w-1.5 rounded-full', skin.dot)} />
        <span className={cn('text-[11px] font-semibold uppercase tracking-wider', skin.text)}>{skin.label}</span>
      </div>
      <AgentSelector
        agents={agents}
        allAgents={order}
        ariaLabel={`Select agent for ${skin.label}`}
        selected={agent}
        onSelect={onAgentSelect}
        variant="compact"
        autoFocus={autoFocus}
      />
      <AgentTuning
        agent={agent}
        model={model}
        effort={effort}
        onModelChange={onModelChange}
        onEffortChange={onEffortChange}
        defaults={agent ? agentDefaults?.[agent] : undefined}
        opencodeDefaults={agentDefaults?.opencode}
        defaultsLoading={agentDefaults === null}
      />
    </div>
  );
}
