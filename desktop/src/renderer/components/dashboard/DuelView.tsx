import type { MuxBasePane } from 'muxbase/core';
import type { PaneActivityState } from '../../../shared/pane-activity';
import { ArrowLeft, Trophy } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Group, Panel, Separator } from 'react-resizable-panels';
import { usePaneActions } from '../../hooks/usePaneActions';
import { usePaneEffectiveStatus } from '../../hooks/usePaneEffectiveStatus';
import { cn } from '../../lib/cn';
import { resolveDuelPair } from '../../lib/duel-pair';
import { usePaneActivityStore, usePaneStore, useUiStore } from '../../stores';
import { InteractiveTerminal } from '../pane-detail/InteractiveTerminal';
import { Badge } from '../shared/Badge';
import { ConfirmDialog } from '../shared/ConfirmDialog';
import { EmptyState } from '../shared/EmptyState';
import { HoverTooltip } from '../shared/HoverTooltip';
import { StatusDot } from '../shared/StatusDot';

const ROLE_CHIP_CLASS: Record<'a' | 'b', string> = {
  a: 'bg-indigo-500/15 text-indigo-400 ring-1 ring-indigo-500/40',
  b: 'bg-teal-500/15 text-teal-400 ring-1 ring-teal-500/40',
};

function paneLabelOf(pane: MuxBasePane): string {
  return pane.title || pane.slug || pane.id;
}

function RoleChip({ role, size = 'sm' }: { role: 'a' | 'b'; size?: 'sm' | 'md' }) {
  const dimension = size === 'md' ? 'h-5 w-5 text-[11px]' : 'h-4 w-4 text-[10px]';
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-full font-bold uppercase leading-none',
        dimension,
        ROLE_CHIP_CLASS[role],
      )}
    >
      {role}
    </span>
  );
}

function SideIdentity({ pane, status, justFinished }: { pane: MuxBasePane; status: PaneActivityState; justFinished: boolean }) {
  const role = pane.duel?.role ?? 'a';
  const detail = [pane.model, pane.effort].filter(Boolean).join(' · ');

  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <RoleChip role={role} />
      {pane.agent && <Badge label={pane.agent} className="shrink-0" />}
      <HoverTooltip label={paneLabelOf(pane)} className="min-w-0 truncate text-xs font-medium text-[var(--text)]">
        {paneLabelOf(pane)}
      </HoverTooltip>
      {detail && <span className="shrink-0 text-[10px] text-[var(--text-muted)]">{detail}</span>}
      <StatusDot status={status} ready={justFinished} size="sm" />
    </div>
  );
}

function WinnerButton({ pane, onDeclare }: { pane: MuxBasePane; onDeclare: (pane: MuxBasePane) => void }) {
  return (
    <HoverTooltip label={`Declare ${paneLabelOf(pane)} the winner`} className="flex shrink-0 items-center">
      <button
        onClick={() => onDeclare(pane)}
        aria-label={`Declare ${paneLabelOf(pane)} the winner`}
        className="flex min-h-6 items-center gap-1 rounded px-1.5 text-[11px] font-medium text-[var(--accent)] transition-colors hover:bg-[var(--accent)]/20"
      >
        <Trophy size={13} />
        Winner
      </button>
    </HoverTooltip>
  );
}

interface DuelHeaderProps {
  onBack: () => void;
  onDeclare: (pane: MuxBasePane) => void;
  paneA: MuxBasePane;
  paneB: MuxBasePane;
  prompt: string;
  statusA: PaneActivityState;
  statusB: PaneActivityState;
  justFinishedA: boolean;
  justFinishedB: boolean;
}

function DuelHeader({
  justFinishedA,
  justFinishedB,
  onBack,
  onDeclare,
  paneA,
  paneB,
  prompt,
  statusA,
  statusB,
}: DuelHeaderProps) {
  return (
    <div className="flex items-center gap-3 border-b border-[var(--divider)] px-4 py-2">
      <button
        onClick={onBack}
        className="flex shrink-0 items-center gap-1.5 text-xs text-[var(--text-muted)] transition-colors hover:text-[var(--text)]"
      >
        <ArrowLeft size={14} />
        <span>Fleet</span>
      </button>
      <span className="shrink-0 text-[var(--divider-strong)]">|</span>
      {prompt && (
        <HoverTooltip label={prompt} className="min-w-0 max-w-[28rem] truncate text-xs text-[var(--text-secondary)]">
          {prompt}
        </HoverTooltip>
      )}
      <div className="ml-auto flex min-w-0 items-center gap-3">
        <div className="flex min-w-0 items-center gap-1.5">
          <SideIdentity pane={paneA} status={statusA} justFinished={justFinishedA} />
          <WinnerButton pane={paneA} onDeclare={onDeclare} />
        </div>
        <span className="shrink-0 text-[var(--divider-strong)]">|</span>
        <div className="flex min-w-0 items-center gap-1.5">
          <SideIdentity pane={paneB} status={statusB} justFinished={justFinishedB} />
          <WinnerButton pane={paneB} onDeclare={onDeclare} />
        </div>
      </div>
    </div>
  );
}

export function DuelView() {
  const duelGroupId = useUiStore((s) => s.duelGroupId);
  const returnToFleet = useUiStore((s) => s.returnToFleet);
  const panes = usePaneStore((s) => s.panes);
  const justFinishedIds = usePaneActivityStore((s) => s.justFinishedPaneIds);
  const { declareDuelWinner } = usePaneActions();
  const [pendingWinner, setPendingWinner] = useState<MuxBasePane | null>(null);

  const duelPair = useMemo(() => resolveDuelPair(panes, duelGroupId), [duelGroupId, panes]);
  const statusA = usePaneEffectiveStatus(duelPair?.[0]);
  const statusB = usePaneEffectiveStatus(duelPair?.[1]);

  if (!duelPair) {
    return (
      <div className="flex h-full items-center justify-center">
        <EmptyState
          title="Duel unavailable"
          description="Both Duel sides must be open to compare them."
          action="Back to fleet"
          onAction={returnToFleet}
        />
      </div>
    );
  }

  const [paneA, paneB] = duelPair;
  const loser = pendingWinner
    ? duelPair.find((pane) => pane.id !== pendingWinner.id) ?? null
    : null;

  const handleConfirm = () => {
    if (pendingWinner) declareDuelWinner(pendingWinner);
    setPendingWinner(null);
  };

  return (
    <div className="flex h-full flex-col">
      <DuelHeader
        justFinishedA={justFinishedIds.has(paneA.id)}
        justFinishedB={justFinishedIds.has(paneB.id)}
        onBack={returnToFleet}
        onDeclare={setPendingWinner}
        paneA={paneA}
        paneB={paneB}
        prompt={paneA.duel?.prompt ?? ''}
        statusA={statusA}
        statusB={statusB}
      />
      <div className="min-h-0 flex-1">
        <Group id={`duel-${duelGroupId}`} orientation="horizontal">
          <Panel defaultSize={50} minSize={25}>
            <InteractiveTerminal pane={paneA} />
          </Panel>
          <Separator className="muxbase-resize-handle" data-testid="duel-terminal-separator" />
          <Panel defaultSize={50} minSize={25}>
            <InteractiveTerminal pane={paneB} />
          </Panel>
        </Group>
      </div>
      <ConfirmDialog
        open={pendingWinner !== null}
        title="Declare duel winner"
        message={
          pendingWinner
            ? `Keep ${paneLabelOf(pendingWinner)}? ${loser ? paneLabelOf(loser) : 'The other pane'} will be closed, and its worktree and branch will be deleted.`
            : ''
        }
        confirmLabel="Keep winner"
        onConfirm={handleConfirm}
        onCancel={() => setPendingWinner(null)}
        danger
      />
    </div>
  );
}
