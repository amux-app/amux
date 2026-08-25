import type { AgentName } from 'muxbase/core';
import { GitBranch } from 'lucide-react';
import { cn } from '../../lib/cn';
import { ToggleSwitch } from '../shared/ToggleSwitch';

interface QuickSettingsProps {
  agent: AgentName | undefined;
  onUseWorktreeChange: (v: boolean) => void;
  permissionMode: '' | 'auto';
  useWorktree: boolean;
}

interface WorktreeTileProps {
  agent: AgentName | undefined;
  checked: boolean;
  onChange: (v: boolean) => void;
}

const AUTO_MODE_COPY: Record<AgentName, { detail: string; label: string }> = {
  claude: {
    detail: 'Starts Claude Code in auto mode for safe workspace edits.',
    label: 'Claude Auto Mode',
  },
  codex: {
    detail: 'Uses workspace-write with on-request approvals.',
    label: 'Codex Auto Mode',
  },
  opencode: {
    detail: 'Uses OpenCode permissions without dangerous skip flags.',
    label: 'OpenCode Safe Defaults',
  },
  pi: {
    detail: 'Read, write, edit, and bash are enabled.',
    label: 'Pi Standard Tools',
  },
};

const AGENT_DEFAULT_COPY = {
  detail: 'Uses the selected agent permission defaults.',
  label: 'Agent Default',
};

const DEFAULT_AUTO_MODE_COPY = {
  detail: 'Safe workspace automation applies when an agent is selected.',
  label: 'Auto Mode',
};

function AutoModeTile({ agent, permissionMode }: { agent: AgentName | undefined; permissionMode: '' | 'auto' }) {
  const copy = agent === 'pi'
    ? AUTO_MODE_COPY.pi
    : permissionMode === ''
    ? AGENT_DEFAULT_COPY
    : agent ? AUTO_MODE_COPY[agent] : DEFAULT_AUTO_MODE_COPY;

  return (
    <div
      className={cn(
        'min-h-[58px] rounded-xl px-3 py-2.5',
        agent === 'pi'
          ? 'border border-[color-mix(in_srgb,var(--warning)_38%,transparent)] bg-[color-mix(in_srgb,var(--warning)_9%,transparent)]'
          : 'border border-[var(--divider)] bg-[color-mix(in_srgb,var(--text)_3%,transparent)]',
      )}
    >
      <div className="mb-1 flex items-center gap-2">
        <span className={cn('h-1.5 w-1.5 rounded-full', agent === 'pi' ? 'bg-[var(--warning)] shadow-[0_0_10px_color-mix(in_srgb,var(--warning)_60%,transparent)]' : 'bg-[var(--accent)]')} />
        <span className="text-[11px] font-semibold leading-none text-[var(--text)]">{copy.label}</span>
      </div>
      <p className="text-[10px] font-medium leading-snug text-[var(--text-muted)]">{copy.detail}</p>
    </div>
  );
}

function WorktreeTile({ agent, checked, onChange }: WorktreeTileProps) {
  return (
    <div
      className={cn(
        'flex min-h-[58px] items-center justify-between gap-3 rounded-xl px-3 py-2.5 transition-all duration-150',
        'border border-[var(--divider)] bg-[color-mix(in_srgb,var(--text)_3%,transparent)]',
        'hover:border-[var(--divider-strong)] hover:bg-[var(--tool-item-hover-bg)]',
      )}
    >
      <div className="flex min-w-0 items-center gap-2.5">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] border border-[var(--divider)] bg-[color-mix(in_srgb,var(--text)_4%,transparent)]">
          <GitBranch className="h-3.5 w-3.5 text-[var(--text-secondary)]" />
        </div>
        <div className="min-w-0">
          <span className="block text-[11px] font-semibold leading-none text-[var(--text)]">Git Worktree</span>
          <span className="mt-1 block truncate text-[9.5px] font-medium leading-none text-[var(--text-muted)]">
            {agent === 'pi' ? 'Recommended isolation' : 'Isolated branch and folder'}
          </span>
        </div>
      </div>
      <ToggleSwitch ariaLabel="Use Git Worktree" checked={checked} onChange={onChange} size="sm" />
    </div>
  );
}

export function QuickSettings({
  agent,
  onUseWorktreeChange,
  permissionMode,
  useWorktree,
}: QuickSettingsProps) {
  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1.08fr_0.92fr]">
      <AutoModeTile agent={agent} permissionMode={permissionMode} />
      <WorktreeTile agent={agent} checked={useWorktree} onChange={onUseWorktreeChange} />
    </div>
  );
}
