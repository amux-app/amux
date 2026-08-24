import { motion, AnimatePresence } from 'motion/react';
import { X } from 'lucide-react';
import { useDecomposeStore } from '../../stores/decompose.store';
import { useKanbanStore } from '../../stores/kanban.store';
import { useProjectStore } from '../../stores/project.store';
import { useNotificationStore } from '../../stores/notification.store';
import { usePaneById } from '../../stores/pane.store';
import { useElectronSettingsStore } from '../../stores/electron-settings.store';
import { Spinner } from '../shared/Spinner';
import { Badge } from '../shared/Badge';
import { DecomposeTaskItem } from './DecomposeTaskItem';
import { cn } from '../../lib/cn';
import { isKanbanBoardEnabled } from '../../lib/feature-flags';

export function DecomposeSideSheet() {
  const isOpen = useDecomposeStore((s) => s.isOpen);
  const isLoading = useDecomposeStore((s) => s.isLoading);
  const tasks = useDecomposeStore((s) => s.tasks);
  const selectedIndices = useDecomposeStore((s) => s.selectedIndices);
  const includeDiff = useDecomposeStore((s) => s.includeDiff);
  const error = useDecomposeStore((s) => s.error);
  const close = useDecomposeStore((s) => s.close);
  const toggleTask = useDecomposeStore((s) => s.toggleTask);
  const selectAll = useDecomposeStore((s) => s.selectAll);
  const deselectAll = useDecomposeStore((s) => s.deselectAll);
  const setIncludeDiff = useDecomposeStore((s) => s.setIncludeDiff);
  const generate = useDecomposeStore((s) => s.generate);
  const prompt = useDecomposeStore((s) => s.prompt);

  const addBacklogItems = useKanbanStore((s) => s.addBacklogItems);
  const batchLaunch = useKanbanStore((s) => s.batchLaunch);
  const activeProject = useProjectStore((s) => s.activeProject);
  const addToast = useNotificationStore((s) => s.addToast);
  const paneId = useDecomposeStore((s) => s.paneId);
  const sourcePane = usePaneById(paneId);
  const kanbanBoardEnabled = useElectronSettingsStore((s) => isKanbanBoardEnabled(s.settings));

  const projectRoot = activeProject?.root ?? '';
  const sourcePaneSlug = sourcePane?.slug;

  if (!kanbanBoardEnabled) return null;

  const handleAddToBacklog = async () => {
    if (!projectRoot || selectedIndices.size === 0) return;
    const selected = tasks.filter((_, i) => selectedIndices.has(i));
    const items = selected.map((t) => ({
      title: t.title,
      prompt: t.prompt,
      complexity: t.complexity,
      sourceSlug: sourcePaneSlug,
      sourcePaneId: paneId ?? undefined,
      agent: undefined as 'claude' | 'opencode' | 'codex' | undefined,
    }));

    try {
      await addBacklogItems(projectRoot, items);
      addToast(`Added ${items.length} task${items.length !== 1 ? 's' : ''} to backlog`, 'success');
      close();
    } catch (err) {
      addToast(`Failed to add to backlog: ${(err as Error).message}`, 'error');
    }
  };

  const handleRunSelected = async () => {
    if (!projectRoot || selectedIndices.size === 0) return;
    const selected = tasks.filter((_, i) => selectedIndices.has(i));
    const items = selected.map((t) => ({
      title: t.title,
      prompt: t.prompt,
      complexity: t.complexity,
      sourceSlug: sourcePaneSlug,
      sourcePaneId: paneId ?? undefined,
      agent: undefined as 'claude' | 'opencode' | 'codex' | undefined,
    }));

    try {
      const added = await addBacklogItems(projectRoot, items);
      const ids = added.map((item) => item.id);
      const result = await batchLaunch(projectRoot, ids);
      addToast(`Launched ${result.launched} task${result.launched !== 1 ? 's' : ''}`, 'success');
      if (result.errors.length > 0) {
        addToast(result.errors[0], 'error');
      }
      close();
    } catch (err) {
      addToast(`Failed to launch: ${(err as Error).message}`, 'error');
    }
  };

  const handleRegenerate = () => {
    if (projectRoot) generate(projectRoot);
  };

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          <motion.div
            className="fixed inset-0 bg-black/40 z-40"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={close}
          />
          <motion.div
            className="fixed right-0 top-0 bottom-0 w-[440px] max-w-[90vw] bg-[var(--bg)] border-l border-[var(--border)] z-50 flex flex-col shadow-2xl"
            initial={{ x: '100%' }}
            animate={{ x: 0 }}
            exit={{ x: '100%' }}
            transition={{ type: 'spring', damping: 30, stiffness: 300 }}
          >
            <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--border)] shrink-0">
              <div>
                <div className="flex items-center gap-2">
                  <h2 className="text-sm font-semibold text-[var(--text)]">Decompose Task</h2>
                  <Badge label="Alpha" />
                </div>
                <p className="text-[11px] text-[var(--text-muted)] mt-0.5 truncate max-w-[300px]">
                  {prompt}
                </p>
              </div>
              <button
                onClick={close}
                className="min-w-7 min-h-7 flex items-center justify-center text-[var(--text-muted)] hover:text-[var(--text)] rounded transition-colors hover:bg-[var(--surface-raised)]"
              >
                <X size={16} />
              </button>
            </div>

            <div className="flex items-center gap-3 px-4 py-2 border-b border-[var(--border)] shrink-0">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={includeDiff}
                  onChange={(e) => setIncludeDiff(e.target.checked)}
                  className="accent-[var(--accent)]"
                />
                <span className="text-[11px] text-[var(--text-secondary)]">Include diff</span>
              </label>
              {!isLoading && tasks.length > 0 && (
                <button
                  onClick={handleRegenerate}
                  className="text-[11px] text-[var(--accent)] hover:underline ml-auto"
                >
                  Regenerate
                </button>
              )}
            </div>

            <div className="flex-1 overflow-y-auto px-4 py-3 space-y-2 min-h-0">
              {isLoading && (
                <div className="flex flex-col items-center justify-center py-16 gap-3">
                  <Spinner size="lg" />
                  <p className="text-[12px] text-[var(--text-muted)]">Breaking down the task...</p>
                </div>
              )}

              {error && !isLoading && (
                <div className="rounded-lg border border-[var(--error)]/30 bg-[var(--error)]/5 p-4">
                  <p className="text-[12px] text-[var(--error)] mb-2">{error}</p>
                  <button
                    onClick={handleRegenerate}
                    className="text-[11px] text-[var(--accent)] hover:underline"
                  >
                    Try again
                  </button>
                </div>
              )}

              {!isLoading && !error && tasks.length > 0 && (
                <>
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-[11px] text-[var(--text-muted)]">
                      {selectedIndices.size} of {tasks.length} selected
                    </span>
                    <div className="flex gap-2">
                      <button
                        onClick={selectAll}
                        className="text-[10px] text-[var(--accent)] hover:underline"
                      >
                        Select all
                      </button>
                      <button
                        onClick={deselectAll}
                        className="text-[10px] text-[var(--text-muted)] hover:underline"
                      >
                        None
                      </button>
                    </div>
                  </div>
                  {tasks.map((task, i) => (
                    <DecomposeTaskItem
                      key={i}
                      task={task}
                      index={i}
                      selected={selectedIndices.has(i)}
                      onToggle={() => toggleTask(i)}
                    />
                  ))}
                </>
              )}
            </div>

            {!isLoading && tasks.length > 0 && (
              <div className="flex gap-2 px-4 py-3 border-t border-[var(--border)] shrink-0">
                <button
                  onClick={handleAddToBacklog}
                  disabled={selectedIndices.size === 0}
                  className={cn(
                    'flex-1 py-2 rounded-lg text-[12px] font-medium transition-all border',
                    selectedIndices.size > 0
                      ? 'bg-[var(--surface-raised)] border-[var(--border)] text-[var(--text)] hover:bg-[var(--surface-raised)] hover:border-[color-mix(in_srgb,var(--text)_20%,var(--border))]'
                      : 'opacity-50 cursor-not-allowed bg-[var(--surface)] border-[var(--border)] text-[var(--text-muted)]',
                  )}
                >
                  Add to Backlog ({selectedIndices.size})
                </button>
                <button
                  onClick={handleRunSelected}
                  disabled={selectedIndices.size === 0}
                  className={cn(
                    'flex-1 py-2 rounded-lg text-[12px] font-medium transition-all border',
                    selectedIndices.size > 0
                      ? 'bg-[var(--accent)]/15 border-[var(--accent)]/30 text-[var(--accent)] hover:bg-[var(--accent)]/25'
                      : 'opacity-50 cursor-not-allowed bg-[var(--surface)] border-[var(--border)] text-[var(--text-muted)]',
                  )}
                >
                  Run Selected ({selectedIndices.size})
                </button>
              </div>
            )}
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
