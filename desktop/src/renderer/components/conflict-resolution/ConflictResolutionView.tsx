import { useState, useCallback } from 'react';
import { ArrowLeft, ArrowRight } from 'lucide-react';
import { motion } from 'motion/react';
import { useConflictResolutionStore } from '../../stores/conflict-resolution.store';
import { useNotificationStore, usePaneById, useUiStore } from '../../stores';
import { LazyGitDiffView } from '../pane-detail/LazyGitDiffView';
import { Spinner } from '../shared/Spinner';
import { cn } from '../../lib/cn';
import * as paneApi from '../../api/pane.api';
import type { SerializableActionResult } from '../../../shared/ipc-types';

type ToastFn = (msg: string, severity: 'success' | 'error' | 'info' | 'warning') => void;

interface CallbackActions {
  closeConflict: () => void;
  closeView: () => void;
  focusPane: (paneId: string) => void;
  addToast: ToastFn;
}

function processCallbackResult(result: SerializableActionResult, actions: CallbackActions) {
  const { closeConflict, closeView, focusPane, addToast } = actions;

  if (result.type === 'navigation' && result.targetPaneId) {
    closeConflict();
    closeView();
    focusPane(result.targetPaneId);
    addToast(result.message, 'success');
    return;
  }

  if (result.type === 'error') {
    addToast(result.message, 'error');
    return;
  }

  closeConflict();
  closeView();
  const severity = result.type === 'success' ? 'success' : 'info';
  addToast(result.message, severity);
}

export function ConflictResolutionView() {
  const paneId = useConflictResolutionStore((s) => s.paneId);
  const callbackId = useConflictResolutionStore((s) => s.callbackId);
  const options = useConflictResolutionStore((s) => s.options);
  const conflictFiles = useConflictResolutionStore((s) => s.conflictFiles);
  const message = useConflictResolutionStore((s) => s.message);
  const closeConflict = useConflictResolutionStore((s) => s.closeConflictResolution);
  const closeView = useUiStore((s) => s.closeConflictView);
  const focusPane = useUiStore((s) => s.focusPane);
  const addToast = useNotificationStore((s) => s.addToast);
  const pane = usePaneById(paneId);
  const [loading, setLoading] = useState<string | null>(null);

  const handleBack = useCallback(() => {
    closeConflict();
    closeView();
  }, [closeConflict, closeView]);

  const handleStrategy = useCallback(
    async (optionId: string) => {
      if (!callbackId) return;
      setLoading(optionId);
      try {
        const result = await paneApi.executeCallback({ callbackId, value: optionId });
        processCallbackResult(result, { closeConflict, closeView, focusPane, addToast });
      } catch (err) {
        addToast(`Strategy failed: ${(err as Error).message}`, 'error');
      } finally {
        setLoading(null);
      }
    },
    [callbackId, closeConflict, closeView, focusPane, addToast],
  );

  if (!pane || !paneId) {
    return (
      <div className="flex items-center justify-center h-full">
        <Spinner />
      </div>
    );
  }

  const conflictCount = conflictFiles.length;

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      className="flex flex-col h-full bg-[var(--bg)]"
      data-testid="conflict-resolution-view"
    >
      <TopBar
        paneSlug={pane.slug}
        conflictCount={conflictCount}
        message={message}
        onBack={handleBack}
      />

      <div className="flex-1 min-h-0 flex">
        <div className="flex-1 min-w-0">
          <LazyGitDiffView pane={pane} />
        </div>

        <StrategySidebar
          options={options}
          loading={loading}
          onSelect={handleStrategy}
        />
      </div>

      <BottomBar conflictCount={conflictCount} onAbort={handleBack} />
    </motion.div>
  );
}

function TopBar({
  paneSlug,
  conflictCount,
  message,
  onBack,
}: {
  paneSlug: string;
  conflictCount: number;
  message: string | null;
  onBack: () => void;
}) {
  return (
    <div className="shrink-0 border-b border-[var(--border)] bg-[var(--surface-raised)] px-4 py-3">
      <div className="flex items-center gap-3">
        <button
          onClick={onBack}
          className="w-[30px] h-[30px] rounded-md border border-[var(--border)] flex items-center justify-center text-[var(--text-muted)] hover:text-[var(--text)] hover:bg-[var(--surface)] transition-colors"
          title="Back"
          data-testid="conflict-back-btn"
        >
          <ArrowLeft size={14} />
        </button>

        <div className="flex items-center gap-2">
          <h1 className="text-sm font-semibold text-[var(--text)]">Conflict Resolution</h1>
          {conflictCount > 0 && (
            <span
              className="px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-[var(--error)]/15 text-[var(--error)] border border-[var(--error)]/20"
              data-testid="conflict-count"
            >
              {conflictCount} {conflictCount === 1 ? 'conflict' : 'conflicts'}
            </span>
          )}
        </div>

        <div className="ml-auto flex items-center gap-1.5 text-[var(--text-muted)]">
          <span className="font-mono text-[11px] bg-[var(--surface)] border border-[var(--border)] rounded-md px-2 py-1 text-[var(--accent)]">
            {paneSlug}
          </span>
          <ArrowRight size={12} />
          <span className="font-mono text-[11px] bg-[var(--surface)] border border-[var(--border)] rounded-md px-2 py-1 text-[var(--text-secondary)]">
            main
          </span>
        </div>
      </div>

      {message && (
        <p className="mt-2 text-[11px] text-[var(--text-muted)] leading-relaxed max-w-[600px]">
          {message}
        </p>
      )}
    </div>
  );
}

function getStrategyCardClasses(isDefault: boolean, isCancel: boolean, isDisabled: boolean): string {
  const base = 'w-full text-left rounded-lg border p-3 transition-all hover:shadow-sm';
  if (isDisabled) {
    return cn(base, 'opacity-50 cursor-not-allowed border-[var(--border)]');
  }
  if (isDefault) {
    return cn(base, 'border-[var(--accent)]/30 bg-[var(--accent)]/[0.04] hover:bg-[var(--accent)]/[0.08]');
  }
  if (isCancel) {
    return cn(base, 'border-[var(--border)] hover:border-[var(--error)]/30');
  }
  return cn(base, 'border-[var(--border)] bg-[var(--surface)] hover:bg-[var(--surface-raised)]');
}

function getStrategyLabelClasses(isDefault: boolean, isCancel: boolean): string {
  if (isDefault) return 'text-xs font-medium text-[var(--accent)]';
  if (isCancel) return 'text-xs font-medium text-[var(--text-secondary)]';
  return 'text-xs font-medium text-[var(--text)]';
}

function StrategySidebar({
  options,
  loading,
  onSelect,
}: {
  options: Array<{ id: string; label: string; description?: string; danger?: boolean; default?: boolean }>;
  loading: string | null;
  onSelect: (id: string) => void;
}) {
  const isDisabled = loading !== null;

  return (
    <aside className="w-[260px] shrink-0 border-l border-[var(--border)] bg-[var(--surface-raised)] flex flex-col">
      <div className="px-4 py-3 border-b border-[var(--border)]">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-[var(--text-secondary)]">
          Resolution Strategy
        </h2>
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-3 space-y-2">
        {options.map((option) => {
          const isDefault = option.default === true;
          const isCancel = option.id === 'cancel';

          return (
            <button
              key={option.id}
              onClick={() => onSelect(option.id)}
              disabled={isDisabled}
              className={getStrategyCardClasses(isDefault, isCancel, isDisabled)}
              data-testid={`strategy-${option.id}`}
            >
              <div className="flex items-center gap-2">
                <span className={getStrategyLabelClasses(isDefault, isCancel)}>
                  {option.label}
                </span>
                {isDefault && (
                  <span className="px-1.5 py-0.5 rounded text-[9px] font-medium bg-[var(--accent)]/15 text-[var(--accent)]">
                    Recommended
                  </span>
                )}
                {loading === option.id && <Spinner size="sm" />}
              </div>
              {option.description && (
                <p className="mt-1.5 text-[11px] text-[var(--text-muted)] leading-relaxed">
                  {option.description}
                </p>
              )}
            </button>
          );
        })}
      </div>
    </aside>
  );
}

function BottomBar({
  conflictCount,
  onAbort,
}: {
  conflictCount: number;
  onAbort: () => void;
}) {
  return (
    <div className="shrink-0 border-t border-[var(--border)] bg-[var(--surface-raised)] px-4 py-3 flex items-center justify-between">
      <span className="text-[11px] text-[var(--text-muted)]">
        {conflictCount > 0
          ? `${conflictCount} conflicting ${conflictCount === 1 ? 'file' : 'files'} detected`
          : 'Review changes and choose a resolution strategy'}
      </span>
      <button
        onClick={onAbort}
        className="px-3 py-1.5 rounded-md text-[11px] font-medium text-[var(--text-secondary)] border border-[var(--border)] hover:border-[var(--error)]/30 hover:text-[var(--error)] transition-colors"
        data-testid="conflict-cancel-btn"
      >
        Cancel
      </button>
    </div>
  );
}
