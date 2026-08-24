import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BacklogItem, DoneItem } from '../../src/shared/kanban-types';

const storeData = vi.hoisted(() => ({ projects: {} as Record<string, { backlog: BacklogItem[]; done: DoneItem[] }> }));

vi.mock('electron-store', () => ({
  default: class MockStore {
    get(key: string, fallback: unknown): unknown {
      return key === 'projects' ? storeData.projects : fallback;
    }

    set(key: string, value: unknown): void {
      if (key === 'projects') {
        storeData.projects = value as typeof storeData.projects;
      }
    }
  },
}));

import { KanbanPersistenceService } from '../../src/main/services/KanbanPersistenceService';

const PROJECT = '/project';

function makeBacklogItem(id: string, order: number): BacklogItem {
  return {
    agent: 'claude',
    complexity: 'S',
    createdAt: order,
    id,
    order,
    prompt: id,
    title: id,
  };
}

function makeDoneItem(id: string): DoneItem {
  return { id, mergedAt: Number(id.slice(1)), prompt: id, slug: id };
}

function resetService(): void {
  (KanbanPersistenceService as unknown as { instance: KanbanPersistenceService | undefined }).instance = undefined;
}

describe('KanbanPersistenceService', () => {
  beforeEach(() => {
    storeData.projects = {};
    resetService();
  });

  it('keeps project data isolated and returns empty defaults for a new project', () => {
    const service = KanbanPersistenceService.getInstance();

    service.addBacklogItems(PROJECT, [makeBacklogItem('one', 0)]);

    expect(service.getAll(PROJECT)).toEqual({ backlog: [makeBacklogItem('one', 0)], done: [] });
    expect(service.getAll('/other')).toEqual({ backlog: [], done: [] });
  });

  it('reorders known items and appends omitted items without losing them', () => {
    const service = KanbanPersistenceService.getInstance();
    service.addBacklogItems(PROJECT, [
      makeBacklogItem('one', 0),
      makeBacklogItem('two', 1),
      makeBacklogItem('three', 2),
    ]);

    const reordered = service.reorderBacklog(PROJECT, ['three', 'missing', 'one']);

    expect(reordered.map(({ id, order }) => ({ id, order }))).toEqual([
      { id: 'three', order: 0 },
      { id: 'one', order: 1 },
      { id: 'two', order: 2 },
    ]);
  });

  it('updates only an existing item and removes exactly the requested ids', () => {
    const service = KanbanPersistenceService.getInstance();
    service.addBacklogItems(PROJECT, [makeBacklogItem('one', 0), makeBacklogItem('two', 1)]);

    service.updateBacklogItem(PROJECT, 'one', { title: 'updated', order: 7 });
    service.removeBacklogItems(PROJECT, ['one', 'missing']);

    expect(service.getBacklog(PROJECT)).toEqual([makeBacklogItem('two', 1)]);
  });

  it('retains only the newest fifty completed items', () => {
    const service = KanbanPersistenceService.getInstance();
    const items = Array.from({ length: 51 }, (_unused, index) => makeDoneItem(`d${index}`));

    for (const item of items) service.addDoneItem(PROJECT, item);

    expect(service.getDone(PROJECT)).toHaveLength(50);
    expect(service.getDone(PROJECT)[0]).toEqual(items[50]);
    expect(service.getDone(PROJECT).at(-1)).toEqual(items[1]);
  });
});
