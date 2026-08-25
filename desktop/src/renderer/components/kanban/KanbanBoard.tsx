import {
  closestCenter,
  type CollisionDetection,
  type DragCancelEvent,
  type DragEndEvent,
  type DragStartEvent,
  DndContext,
  DragOverlay,
  KeyboardSensor,
  type Over,
  PointerSensor,
  pointerWithin,
  rectIntersection,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import { sortableKeyboardCoordinates } from '@dnd-kit/sortable';
import { AnimatePresence, motion } from 'motion/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Group, Panel, Separator } from 'react-resizable-panels';
import type { BacklogItem } from '../../../shared/kanban-types';
import type { KanbanColumnItem } from '../../hooks/useKanbanColumns';
import { useColumnOverride, useKanbanColumns, useRefreshDirtyMap } from '../../hooks/useKanbanColumns';
import { usePaneActions } from '../../hooks/usePaneActions';
import { formatAgentLabel } from '../../lib/formatters';
import {
  clearSelectionIfLaunching,
  launchingCardId,
  paneCardId,
  paneIdFromCardId,
  resolveLaunchingItem,
} from '../../lib/kanban-selection';
import { useKanbanStore } from '../../stores/kanban.store';
import { useNotificationStore } from '../../stores/notification.store';
import { usePaneStore } from '../../stores/pane.store';
import { useProjectStore } from '../../stores/project.store';
import { useWorktreeOverviewStore } from '../../stores/worktree-overview.store';
import { Spinner } from '../shared/Spinner';
import { WorktreeOverviewModal } from '../worktree/WorktreeOverviewModal';
import { AddBacklogDialog, type BacklogFormData } from './AddBacklogDialog';
import { getCardId, KanbanCardPreview } from './KanbanCard';
import { KanbanColumn } from './KanbanColumn';
import { KanbanSidePanel } from './KanbanSidePanel';

export function KanbanBoard() {
  const { columns, isLoading } = useKanbanColumns();
  const activeProject = useProjectStore((s) => s.activeProject);
  const sessionProjectRoot = useProjectStore((s) => s.sessionProjectRoot);
  const panes = usePaneStore((s) => s.panes);
  const addToast = useNotificationStore((s) => s.addToast);
  const batchLaunch = useKanbanStore((s) => s.batchLaunch);
  const addBacklogItems = useKanbanStore((s) => s.addBacklogItems);
  const removeBacklogItems = useKanbanStore((s) => s.removeBacklogItems);
  const updateBacklogItem = useKanbanStore((s) => s.updateBacklogItem);
  const clearDone = useKanbanStore((s) => s.clearDone);
  const reorderBacklog = useKanbanStore((s) => s.reorderBacklog);
  const load = useKanbanStore((s) => s.load);
  const loaded = useKanbanStore((s) => s.loaded);
  const loadedProjectRoot = useKanbanStore((s) => s.loadedProjectRoot);
  const { mergePane } = usePaneActions();
  const showWorktreeModal = useWorktreeOverviewStore((s) => s.isOpen);
  const closeWorktreeModal = useWorktreeOverviewStore((s) => s.close);
  const openWorktreeModal = useWorktreeOverviewStore((s) => s.open);
  const refreshDirtyMap = useRefreshDirtyMap();

  const { setOverride: setColumnOverride } = useColumnOverride();

  const [selectedCardId, setSelectedCardId] = useState<string | null>(null);
  const [activeDragItem, setActiveDragItem] = useState<KanbanColumnItem | null>(null);
  const [showAddBacklog, setShowAddBacklog] = useState(false);
  const [editingBacklogItem, setEditingBacklogItem] = useState<BacklogItem | null>(null);
  const launchingBacklogIdsRef = useRef(new Set<string>());
  const [launchingItems, setLaunchingItems] = useState<BacklogItem[]>([]);
  const columnsRef = useRef(columns);
  columnsRef.current = columns;

  const projectRoot = activeProject?.root ?? sessionProjectRoot ?? '';

  useEffect(() => {
    if (projectRoot && (!loaded || loadedProjectRoot !== projectRoot)) {
      setSelectedCardId(null);
      refreshDirtyMap();
      load(projectRoot);
    }
  }, [projectRoot, loaded, loadedProjectRoot, load, refreshDirtyMap]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable) return;
      if (e.key === 'w' || e.key === 'W') openWorktreeModal();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [openWorktreeModal]);

  const handleWorktreeJumpToPane = useCallback(
    (paneId: string) => {
      setSelectedCardId(paneCardId(paneId));
    },
    [],
  );

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const collisionDetection: CollisionDetection = useCallback((args) => {
    const pointerHits = pointerWithin(args);
    if (pointerHits.length > 0) return pointerHits;
    const intersections = rectIntersection(args);
    if (intersections.length > 0) return intersections;
    return closestCenter(args);
  }, []);

  const launchingBacklogIdSet = useMemo(
    () => new Set(launchingItems.map((item) => item.id)),
    [launchingItems],
  );

  const boardColumns = useMemo(() => {
    if (launchingBacklogIdSet.size === 0) return columns;
    const launchedBacklogIdsWithPane = new Set<string>();
    for (const col of columns) {
      for (const item of col.items) {
        if (item.type !== 'pane') continue;
        const sourceBacklogId = Reflect.get(item.data, 'sourceBacklogId');
        if (typeof sourceBacklogId === 'string') {
          launchedBacklogIdsWithPane.add(sourceBacklogId);
        }
      }
    }

    return columns.map((col) => {
      if (col.id === 'backlog') {
        return {
          ...col,
          items: col.items.filter(
            (item) => item.type !== 'backlog' || !launchingBacklogIdSet.has(item.data.id),
          ),
        };
      }
      if (col.id === 'in-progress') {
        const launchingCards: KanbanColumnItem[] = launchingItems
          .filter((item) => !launchedBacklogIdsWithPane.has(item.id))
          .map((item) => ({ type: 'launching' as const, data: item }));
        if (launchingCards.length === 0) return col;
        return { ...col, items: [...col.items, ...launchingCards] };
      }
      return col;
    });
  }, [columns, launchingBacklogIdSet, launchingItems]);

  const findItemById = useCallback(
    (id: string): KanbanColumnItem | null => {
      for (const col of boardColumns) {
        const found = col.items.find((item) => getCardId(item) === id);
        if (found) return found;
      }
      return null;
    },
    [boardColumns],
  );

  const handleDragStart = useCallback(
    (event: DragStartEvent) => {
      const item = findItemById(String(event.active.id));
      setActiveDragItem(item);
    },
    [findItemById],
  );

  const handleDragCancel = useCallback((_event: DragCancelEvent) => {
    setActiveDragItem(null);
  }, []);

  const resolveColumnId = useCallback(
    (targetId: string): string | null => {
      const columnIds = boardColumns.map((c) => c.id);
      if (columnIds.includes(targetId)) return targetId;
      for (const col of boardColumns) {
        if (col.items.some((item) => getCardId(item) === targetId)) return col.id;
      }
      return null;
    },
    [boardColumns],
  );

  const getDropColumnId = useCallback(
    (over: Over | null): string | null => {
      if (!over) return null;
      const overData = over.data.current as
        | { kind?: string; columnId?: string }
        | undefined;
      if (typeof overData?.columnId === 'string') {
        return overData.columnId;
      }
      return resolveColumnId(String(over.id));
    },
    [resolveColumnId],
  );

  const openLatestLaunchedPane = useCallback((paneIds: string[] | undefined) => {
    const paneId = paneIds?.[paneIds.length - 1];
    if (!paneId) return;
    setSelectedCardId(paneCardId(paneId));
  }, []);

  const launchBacklogItems = useCallback(
    async (itemIds: string[], successMessage: string | ((launched: number) => string)) => {
      if (itemIds.length === 0) return null;
      if (!projectRoot) {
        addToast('No active project selected yet. Wait for project detection or open a workspace first.', 'error');
        return null;
      }

      // Guard against duplicate launches while a prior launch for the same backlog item is still in flight.
      const pendingItemIds = itemIds.filter((id) => !launchingBacklogIdsRef.current.has(id));
      if (pendingItemIds.length === 0) {
        addToast('Task launch already in progress', 'info');
        return null;
      }
      const skippedCount = itemIds.length - pendingItemIds.length;
      if (skippedCount > 0) {
        addToast(`Skipped ${skippedCount} already-launching task${skippedCount > 1 ? 's' : ''}`, 'info');
      }

      for (const id of pendingItemIds) {
        launchingBacklogIdsRef.current.add(id);
      }

      // Read from ref to avoid columns in the dependency array (prevents cascading callback recreation)
      const capturedItems: BacklogItem[] = [];
      for (const col of columnsRef.current) {
        for (const item of col.items) {
          if (item.type === 'backlog' && pendingItemIds.includes(item.data.id)) {
            capturedItems.push(item.data);
          }
        }
      }
      if (pendingItemIds.length === 1) {
        setSelectedCardId(launchingCardId(pendingItemIds[0]));
      }
      setLaunchingItems((prev) => {
        const existingIds = new Set(prev.map((i) => i.id));
        const newItems = capturedItems.filter((i) => !existingIds.has(i.id));
        return newItems.length > 0 ? [...prev, ...newItems] : prev;
      });

      addToast(
        pendingItemIds.length === 1
          ? 'Launching task...'
          : `Launching ${pendingItemIds.length} tasks...`,
        'info',
      );

      try {
        const result = await batchLaunch(projectRoot, pendingItemIds);
        if (result.launched > 0) {
          addToast(
            typeof successMessage === 'function' ? successMessage(result.launched) : successMessage,
            'success',
          );
          refreshDirtyMap();
          openLatestLaunchedPane(result.launchedPaneIds);
        }
        if (result.errors.length > 0) {
          addToast(result.errors[0], 'error');
        }
        return result;
      } finally {
        for (const id of pendingItemIds) {
          launchingBacklogIdsRef.current.delete(id);
        }
        setSelectedCardId((current) => clearSelectionIfLaunching(current, pendingItemIds));
        setLaunchingItems((prev) => {
          const pendingSet = new Set(pendingItemIds);
          return prev.filter((item) => !pendingSet.has(item.id));
        });
      }
    },
    [projectRoot, batchLaunch, addToast, refreshDirtyMap, openLatestLaunchedPane],
  );

  const handleDragEnd = useCallback(
    async (event: DragEndEvent) => {
      setActiveDragItem(null);
      const { active, over } = event;
      if (!over) return;

      const activeId = String(active.id);
      const overId = String(over.id);
      const targetColumn = getDropColumnId(over);

      const item = findItemById(activeId);
      if (!item) {
        return;
      }

      const sourceColumn = boardColumns.find((col) =>
        col.items.some((ci) => getCardId(ci) === activeId),
      )?.id;

      if (item.type === 'launching' || item.type === 'done') return;

      if (item.type === 'backlog' && targetColumn === 'in-progress') {
        const backlogItem = item.data;
        try {
          await launchBacklogItems([backlogItem.id], `Launched "${backlogItem.title}"`);
        } catch (err) {
          addToast(`Failed to launch: ${(err as Error).message}`, 'error');
        }
        return;
      }

      if (item.type === 'pane' && targetColumn === 'done') {
        setColumnOverride(item.data.id, 'done');
        addToast('Marked as done', 'success');
        return;
      }

      if (item.type === 'pane' && targetColumn === 'needs-attention') {
        setColumnOverride(item.data.id, 'needs-attention');
        return;
      }

      if (item.type === 'pane' && targetColumn === 'review') {
        setColumnOverride(item.data.id, 'review');
        return;
      }

      if (item.type === 'pane' && targetColumn === 'in-progress') {
        setColumnOverride(item.data.id, 'in-progress');
        return;
      }

      if (item.type === 'backlog' && targetColumn === 'backlog') {
        if (!projectRoot) {
          addToast('No active project selected yet. Wait for project detection or open a workspace first.', 'error');
          return;
        }
        const backlogCol = boardColumns.find((c) => c.id === 'backlog');
        if (!backlogCol) return;
        const ids = backlogCol.items
          .filter((i) => i.type === 'backlog')
          .map((i) => i.data.id);

        const fromIndex = ids.indexOf(item.data.id);
        const targetItem = findItemById(overId);
        if (!targetItem || targetItem.type !== 'backlog') return;
        const toIndex = ids.indexOf(targetItem.data.id);

        if (fromIndex !== toIndex && fromIndex >= 0 && toIndex >= 0) {
          const reordered = [...ids];
          reordered.splice(fromIndex, 1);
          reordered.splice(toIndex, 0, item.data.id);
          await reorderBacklog(projectRoot, reordered);
        }
        return;
      }

      if (sourceColumn === targetColumn) return;
    },
    [projectRoot, findItemById, boardColumns, getDropColumnId, launchBacklogItems, reorderBacklog, addToast, setColumnOverride],
  );

  const selectedPaneId = paneIdFromCardId(selectedCardId);
  const selectedPane = selectedPaneId ? panes.find((p) => p.id === selectedPaneId) : null;
  const selectedLaunchingItem = resolveLaunchingItem(selectedCardId, launchingItems);

  const handleBatchLaunchAll = useCallback(async () => {
    const backlogCol = boardColumns.find((c) => c.id === 'backlog');
    if (!backlogCol) return;
    if (!projectRoot) {
      addToast('No active project selected yet. Wait for project detection or open a workspace first.', 'error');
      return;
    }
    const ids = backlogCol.items
      .filter((i) => i.type === 'backlog')
      .map((i) => i.data.id);
    if (ids.length === 0) return;
    try {
      await launchBacklogItems(
        ids,
        (launched) => `Launched ${launched} task${launched !== 1 ? 's' : ''}`,
      );
    } catch (err) {
      addToast(`Batch launch failed: ${(err as Error).message}`, 'error');
    }
  }, [boardColumns, projectRoot, launchBacklogItems, addToast]);

  const handleMergeAll = useCallback(async () => {
    const reviewCol = boardColumns.find((c) => c.id === 'review');
    if (!reviewCol) return;
    for (const item of reviewCol.items) {
      if (item.type === 'pane') {
        await mergePane(item.data.id);
      }
    }
    refreshDirtyMap();
  }, [boardColumns, mergePane, refreshDirtyMap]);

  const handleClearDone = useCallback(async () => {
    if (!projectRoot) {
      addToast('No active project selected yet. Wait for project detection or open a workspace first.', 'error');
      return;
    }
    await clearDone(projectRoot);
  }, [projectRoot, clearDone, addToast]);

  const handleAddBacklog = useCallback(
    async (data: BacklogFormData) => {
      if (!projectRoot) {
        addToast('No active project selected yet. Wait for project detection or open a workspace first.', 'error');
        return;
      }
      try {
        if (editingBacklogItem) {
          await updateBacklogItem(projectRoot, editingBacklogItem.id, {
            title: data.title,
            prompt: data.prompt,
            complexity: data.complexity,
            agent: data.agent,
            useWorktree: data.useWorktree,
            projectRoot: data.projectRoot,
          });
          addToast(`Updated "${data.title}"`, 'success');
        } else {
          await addBacklogItems(projectRoot, [data]);
          addToast(`Added "${data.title}" to backlog`, 'success');
        }
      } catch (err) {
        addToast(`Failed to ${editingBacklogItem ? 'update' : 'add'} task: ${(err as Error).message}`, 'error');
      }
    },
    [projectRoot, addBacklogItems, updateBacklogItem, editingBacklogItem, addToast],
  );

  const handleCardAction = useCallback(
    async (cardId: string, action: string) => {
      if (!projectRoot) {
        addToast('No active project selected yet. Wait for project detection or open a workspace first.', 'error');
        return;
      }
      const backlogId = cardId.startsWith('backlog-') ? cardId.replace('backlog-', '') : null;
      if (!backlogId) return;

      if (action === 'launch') {
        try {
          await launchBacklogItems([backlogId], 'Agent launched');
        } catch (err) {
          addToast(`Failed to launch: ${(err as Error).message}`, 'error');
        }
      } else if (action === 'remove') {
        try {
          await removeBacklogItems(projectRoot, [backlogId]);
          addToast('Removed from backlog', 'info');
        } catch (err) {
          addToast(`Failed to remove: ${(err as Error).message}`, 'error');
        }
      } else if (action === 'edit') {
        const backlogCol = boardColumns.find((c) => c.id === 'backlog');
        const item = backlogCol?.items.find(
          (i) => i.type === 'backlog' && i.data.id === backlogId,
        );
        if (item?.type === 'backlog') {
          setEditingBacklogItem(item.data);
        }
        setShowAddBacklog(true);
      }
    },
    [projectRoot, boardColumns, launchBacklogItems, removeBacklogItems, addToast],
  );

  const backlogCount = boardColumns.find((c) => c.id === 'backlog')?.items.length ?? 0;
  const reviewCount = boardColumns.find((c) => c.id === 'review')?.items.length ?? 0;
  const doneCount = boardColumns.find((c) => c.id === 'done')?.items.length ?? 0;

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-center gap-2 px-3 py-1.5 text-[10px] text-[var(--text-muted)] bg-[var(--surface)] border-b border-[var(--border)]">
        <span className="rounded border border-[var(--border)] px-1.5 py-0.5 font-semibold uppercase tracking-wide text-[var(--accent)]">
          Alpha
        </span>
        <span>Board is an early workflow and may change before general release.</span>
      </div>

      {isLoading && (
        <div className="flex items-center gap-2 px-4 py-1.5 text-[10px] text-[var(--text-muted)] bg-[var(--surface)] border-b border-[var(--border)]">
          <Spinner size="sm" />
          <span>Checking worktree status...</span>
        </div>
      )}

      <div className="flex-1 min-h-0">
        <Group orientation="horizontal">
          <Panel defaultSize={selectedPane || selectedLaunchingItem ? 60 : 100} minSize={40}>
            <DndContext
              sensors={sensors}
              collisionDetection={collisionDetection}
              onDragStart={handleDragStart}
              onDragCancel={handleDragCancel}
              onDragEnd={handleDragEnd}
            >
              <div className="flex gap-1 h-full p-2 overflow-x-auto">
                {boardColumns.map((col) => (
                  <KanbanColumn
                    key={col.id}
                    column={col}
                    selectedCardId={selectedCardId}
                    onCardClick={setSelectedCardId}
                    onCardAction={handleCardAction}
                    footerAction={
                      col.id === 'backlog'
                        ? { label: '+ Add Task', onClick: () => { setEditingBacklogItem(null); setShowAddBacklog(true); }, variant: 'accent' }
                        : col.id === 'done' && doneCount > 0
                          ? { label: 'Clear All', onClick: handleClearDone }
                          : undefined
                    }
                    secondaryAction={
                      col.id === 'backlog' && backlogCount > 0
                        ? { label: 'Launch All', onClick: handleBatchLaunchAll }
                        : col.id === 'review' && reviewCount > 0
                          ? { label: `Merge All (${reviewCount})`, onClick: handleMergeAll }
                          : undefined
                    }
                  />
                ))}
              </div>

              <DragOverlay dropAnimation={null}>
                {activeDragItem && (
                  <div className="w-[280px] rotate-[3deg] scale-105 opacity-90 shadow-2xl">
                    <KanbanCardPreview item={activeDragItem} />
                  </div>
                )}
              </DragOverlay>
            </DndContext>
          </Panel>

          <AnimatePresence>
            {(selectedPane || selectedLaunchingItem) && (
              <>
                <Separator className="muxbase-resize-handle" />
                <Panel defaultSize={40} minSize={25}>
                  <motion.div
                    className="h-full"
                    initial={{ opacity: 0, x: 20 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: 20 }}
                    transition={{ duration: 0.2 }}
                  >
                    {selectedPane && (
                      <KanbanSidePanel
                        pane={selectedPane}
                        onClose={() => setSelectedCardId(null)}
                      />
                    )}
                    {!selectedPane && selectedLaunchingItem && (
                      <KanbanLaunchingSidePanel
                        item={selectedLaunchingItem}
                        onClose={() => setSelectedCardId(null)}
                      />
                    )}
                  </motion.div>
                </Panel>
              </>
            )}
          </AnimatePresence>
        </Group>
      </div>

      <AddBacklogDialog
        isOpen={showAddBacklog}
        onClose={() => {
          setShowAddBacklog(false);
          setEditingBacklogItem(null);
        }}
        onSubmit={handleAddBacklog}
        editItem={editingBacklogItem ?? undefined}
      />

      {showWorktreeModal && (
        <WorktreeOverviewModal
          onClose={closeWorktreeModal}
          onJumpToPane={handleWorktreeJumpToPane}
        />
      )}
    </div>
  );
}

function KanbanLaunchingSidePanel({
  item,
  onClose,
}: {
  item: BacklogItem;
  onClose: () => void;
}) {
  return (
    <div className="flex h-full flex-col bg-[var(--surface)] border-l border-[var(--border)]">
      <div className="flex items-center justify-between px-3 py-2 border-b border-[var(--border)]">
        <div className="text-xs font-semibold text-[var(--text)] truncate font-mono">{item.title}</div>
        <button
          onClick={onClose}
          className="min-w-5 min-h-5 flex items-center justify-center text-[var(--text-muted)] hover:text-[var(--text)] rounded transition-colors hover:bg-[var(--surface-raised)]"
          aria-label="Close panel"
        >
          ×
        </button>
      </div>
      <div className="flex-1 min-h-0 flex flex-col items-center justify-center gap-2 text-center px-5">
        <Spinner size="md" />
        <div className="text-sm font-medium text-[var(--text)]">
          Preparing {item.agent ? formatAgentLabel(item.agent) : 'agent'} terminal
        </div>
        <div className="text-xs text-[var(--text-muted)] max-w-[280px]">
          Creating worktree, pane, and agent process. Terminal opens automatically when ready.
        </div>
      </div>
    </div>
  );
}
