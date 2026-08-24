import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { KanbanData, BacklogItem, BatchLaunchResponse } from '../../src/shared/kanban-types';

vi.mock('../../src/renderer/api/kanban.api', () => ({
  getKanban: vi.fn(),
  addBacklogItems: vi.fn(),
  removeBacklogItems: vi.fn(),
  updateBacklogItem: vi.fn(),
  reorderBacklog: vi.fn(),
  addDoneItem: vi.fn(),
  clearDone: vi.fn(),
  batchLaunch: vi.fn(),
}));

import { useKanbanStore } from '../../src/renderer/stores/kanban.store';
import * as kanbanApi from '../../src/renderer/api/kanban.api';

const mockedApi = vi.mocked(kanbanApi);

function makeBacklogItem(overrides: Partial<BacklogItem> = {}): BacklogItem {
  return {
    id: `item-${Math.random().toString(36).slice(2, 6)}`,
    title: 'Test task',
    prompt: 'Do something',
    complexity: 'M',
    createdAt: Date.now(),
    order: 0,
    ...overrides,
  };
}

function makeKanbanData(overrides: Partial<KanbanData> = {}): KanbanData {
  return { backlog: [], done: [], ...overrides };
}

describe('useKanbanStore', () => {
  beforeEach(() => {
    useKanbanStore.setState({ backlog: [], done: [], loaded: false, loadedProjectRoot: null });
    vi.clearAllMocks();
  });

  describe('initial state', () => {
    it('has empty backlog and done', () => {
      const state = useKanbanStore.getState();
      expect(state.backlog).toEqual([]);
      expect(state.done).toEqual([]);
      expect(state.loaded).toBe(false);
      expect(state.loadedProjectRoot).toBe(null);
    });
  });

  describe('load', () => {
    it('fetches data and sets loaded flag', async () => {
      const items = [makeBacklogItem({ id: 'b1' })];
      mockedApi.getKanban.mockResolvedValue(makeKanbanData({ backlog: items }));

      await useKanbanStore.getState().load('/project');

      expect(mockedApi.getKanban).toHaveBeenCalledWith({ projectRoot: '/project' });
      expect(useKanbanStore.getState().backlog).toEqual(items);
      expect(useKanbanStore.getState().loaded).toBe(true);
      expect(useKanbanStore.getState().loadedProjectRoot).toBe('/project');
    });
  });

  describe('refresh', () => {
    it('fetches data without resetting loaded flag', async () => {
      useKanbanStore.setState({ loaded: true });
      const items = [makeBacklogItem({ id: 'b1' })];
      mockedApi.getKanban.mockResolvedValue(makeKanbanData({ backlog: items }));

      await useKanbanStore.getState().refresh('/project');

      expect(useKanbanStore.getState().backlog).toEqual(items);
      expect(useKanbanStore.getState().loaded).toBe(true);
      expect(useKanbanStore.getState().loadedProjectRoot).toBe('/project');
    });
  });

  describe('addBacklogItems', () => {
    it('calls API and refreshes backlog', async () => {
      const newItem = makeBacklogItem({ id: 'new-1' });
      mockedApi.addBacklogItems.mockResolvedValue({ success: true, items: [newItem] });
      mockedApi.getKanban.mockResolvedValue(makeKanbanData({ backlog: [newItem] }));

      const result = await useKanbanStore.getState().addBacklogItems('/project', [
        { title: 'New', prompt: 'Do', complexity: 'S' },
      ]);

      expect(result).toEqual([newItem]);
      expect(useKanbanStore.getState().backlog).toEqual([newItem]);
    });

    it('returns items even when success is false', async () => {
      const items = [makeBacklogItem()];
      mockedApi.addBacklogItems.mockResolvedValue({ success: false, items });

      const result = await useKanbanStore.getState().addBacklogItems('/project', []);

      expect(result).toEqual(items);
      expect(mockedApi.getKanban).not.toHaveBeenCalled();
    });
  });

  describe('removeBacklogItems', () => {
    it('calls API and refreshes backlog', async () => {
      mockedApi.removeBacklogItems.mockResolvedValue({ success: true });
      mockedApi.getKanban.mockResolvedValue(makeKanbanData());

      await useKanbanStore.getState().removeBacklogItems('/project', ['item-1']);

      expect(mockedApi.removeBacklogItems).toHaveBeenCalledWith({
        projectRoot: '/project',
        itemIds: ['item-1'],
      });
      expect(useKanbanStore.getState().backlog).toEqual([]);
    });
  });

  describe('reorderBacklog', () => {
    it('calls reorder API and refreshes', async () => {
      const reordered = [makeBacklogItem({ id: 'b2', order: 0 }), makeBacklogItem({ id: 'b1', order: 1 })];
      mockedApi.reorderBacklog.mockResolvedValue({ success: true });
      mockedApi.getKanban.mockResolvedValue(makeKanbanData({ backlog: reordered }));

      await useKanbanStore.getState().reorderBacklog('/project', ['b2', 'b1']);

      expect(mockedApi.reorderBacklog).toHaveBeenCalledWith({
        projectRoot: '/project',
        orderedIds: ['b2', 'b1'],
      });
      expect(useKanbanStore.getState().backlog).toEqual(reordered);
    });
  });

  describe('clearDone', () => {
    it('clears done list immediately', async () => {
      useKanbanStore.setState({
        done: [{ id: 'd1', slug: 'test', prompt: 'p', mergedAt: 1 }],
      });
      mockedApi.clearDone.mockResolvedValue({ success: true });

      await useKanbanStore.getState().clearDone('/project');

      expect(useKanbanStore.getState().done).toEqual([]);
    });
  });

  describe('updateBacklogItem', () => {
    it('calls API and refreshes backlog', async () => {
      const updated = makeBacklogItem({ id: 'b1', title: 'Updated' });
      mockedApi.updateBacklogItem.mockResolvedValue({ success: true });
      mockedApi.getKanban.mockResolvedValue(makeKanbanData({ backlog: [updated] }));

      await useKanbanStore.getState().updateBacklogItem('/project', 'b1', { title: 'Updated' });

      expect(mockedApi.updateBacklogItem).toHaveBeenCalledWith({
        projectRoot: '/project',
        itemId: 'b1',
        updates: { title: 'Updated' },
      });
      expect(useKanbanStore.getState().backlog).toEqual([updated]);
    });
  });

  describe('addDoneItem', () => {
    it('calls API and refreshes done list', async () => {
      const doneItem = { id: 'd1', slug: 'test', prompt: 'p', mergedAt: Date.now() };
      mockedApi.addDoneItem.mockResolvedValue({ success: true });
      mockedApi.getKanban.mockResolvedValue(makeKanbanData({ done: [doneItem] }));

      await useKanbanStore.getState().addDoneItem('/project', {
        slug: 'test',
        prompt: 'p',
      });

      expect(mockedApi.addDoneItem).toHaveBeenCalledWith({
        projectRoot: '/project',
        item: { slug: 'test', prompt: 'p' },
      });
      expect(useKanbanStore.getState().done).toEqual([doneItem]);
    });
  });

  describe('batchLaunch', () => {
    it('returns launch result and refreshes backlog', async () => {
      const batchResult: BatchLaunchResponse = {
        success: true,
        launched: 2,
        errors: [],
        launchedPaneIds: ['p1', 'p2'],
      };
      mockedApi.batchLaunch.mockResolvedValue(batchResult);
      mockedApi.getKanban.mockResolvedValue(makeKanbanData());

      const result = await useKanbanStore.getState().batchLaunch('/project', ['b1', 'b2']);

      expect(result).toEqual({ launched: 2, errors: [], launchedPaneIds: ['p1', 'p2'] });
      expect(mockedApi.batchLaunch).toHaveBeenCalledWith({
        projectRoot: '/project',
        itemIds: ['b1', 'b2'],
      });
    });

    it('refreshes backlog after batch launch to remove launched items', async () => {
      useKanbanStore.setState({ backlog: [makeBacklogItem({ id: 'b1' }), makeBacklogItem({ id: 'b2' })] });
      mockedApi.batchLaunch.mockResolvedValue({ success: true, launched: 1, errors: [], launchedPaneIds: ['p1'] });
      mockedApi.getKanban.mockResolvedValue(makeKanbanData({ backlog: [makeBacklogItem({ id: 'b2' })] }));

      await useKanbanStore.getState().batchLaunch('/project', ['b1']);

      expect(useKanbanStore.getState().backlog).toHaveLength(1);
      expect(useKanbanStore.getState().backlog[0].id).toBe('b2');
    });

    it('returns errors from partial launches', async () => {
      mockedApi.batchLaunch.mockResolvedValue({
        success: false,
        launched: 1,
        errors: ['Task B: creation failed'],
      });
      mockedApi.getKanban.mockResolvedValue(makeKanbanData());

      const result = await useKanbanStore.getState().batchLaunch('/project', ['b1', 'b2']);

      expect(result.launched).toBe(1);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain('creation failed');
      expect(result.launchedPaneIds).toEqual([]);
    });
  });
});
