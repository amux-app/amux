import { describe, it, expect } from 'vitest';
import type { AumxPane } from 'aumx/core';
import type { BacklogItem, DoneItem } from '../../src/shared/kanban-types';
import { computeEffectiveStatusByPaneId, deriveKanbanColumns } from '../../src/renderer/hooks/useKanbanColumns';
import type { PaneActivityState } from '../../src/shared/pane-activity';
import { makeActivity } from '../helpers/pane-activity-fixtures';

function makePane(overrides: Partial<AumxPane> = {}): AumxPane {
  return {
    id: `aumx-${Math.random().toString(36).slice(2, 6)}`,
    slug: 'test-pane',
    prompt: 'do something',
    paneId: '%1',
    ...overrides,
  };
}

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

function makeDoneItem(overrides: Partial<DoneItem> = {}): DoneItem {
  return {
    id: `done-${Math.random().toString(36).slice(2, 6)}`,
    slug: 'done-task',
    prompt: 'Did something',
    mergedAt: Date.now(),
    ...overrides,
  };
}

function getColumnById(columns: ReturnType<typeof deriveKanbanColumns>, id: string) {
  return columns.find((c) => c.id === id)!;
}

describe('computeEffectiveStatusByPaneId', () => {
  it(`preserves a 'stopped' activity state instead of a stale working agentStatus`, () => {
    const panes = [makePane({ id: 'p1', agentStatus: 'working' })];
    const paneActivityById = { p1: makeActivity({ state: 'stopped' }) };

    const map = computeEffectiveStatusByPaneId(panes, {}, paneActivityById);

    expect(map.p1).toBe('stopped');
  });

  it(`routes a 'stopped' pane out of needs-attention in deriveKanbanColumns even though its stale agentStatus is 'waiting'`, () => {
    const panes = [makePane({ id: 'p1', agentStatus: 'waiting' })];
    const paneActivityById = { p1: makeActivity({ state: 'stopped' }) };
    const effectiveStatusByPaneId = computeEffectiveStatusByPaneId(panes, {}, paneActivityById);

    const columns = deriveKanbanColumns(panes, [], [], {}, { effectiveStatusByPaneId });

    expect(effectiveStatusByPaneId.p1).toBe('stopped');
    expect(getColumnById(columns, 'needs-attention').items).toHaveLength(0);
    expect(getColumnById(columns, 'in-progress').items).toHaveLength(1);
  });

  const uncertainStates: PaneActivityState[] = ['unknown', 'starting'];

  for (const state of uncertainStates) {
    it(`preserves an '${state}' activity state instead of consulting agentStatus`, () => {
      const panes = [makePane({ id: 'p1', agentStatus: 'working' })];
      const paneActivityById = { p1: makeActivity({ state }) };

      const map = computeEffectiveStatusByPaneId(panes, {}, paneActivityById);

      expect(map.p1).toBe(state);
    });

    it(`keeps an '${state}' pane out of needs-attention despite stale waiting metadata`, () => {
      const panes = [makePane({ id: 'p1', agentStatus: 'waiting' })];
      const paneActivityById = { p1: makeActivity({ state }) };
      const effectiveStatusByPaneId = computeEffectiveStatusByPaneId(panes, {}, paneActivityById);

      const columns = deriveKanbanColumns(panes, [], [], {}, { effectiveStatusByPaneId });

      expect(effectiveStatusByPaneId.p1).toBe(state);
      expect(getColumnById(columns, 'needs-attention').items).toHaveLength(0);
      expect(getColumnById(columns, 'in-progress').items).toHaveLength(1);
    });
  }
});

describe('deriveKanbanColumns', () => {
  describe('column structure', () => {
    it('returns 5 columns in correct order', () => {
      const columns = deriveKanbanColumns([], [], [], {});
      expect(columns).toHaveLength(5);
      expect(columns.map((c) => c.id)).toEqual([
        'backlog',
        'in-progress',
        'needs-attention',
        'review',
        'done',
      ]);
    });

    it('columns have correct droppable flags', () => {
      const columns = deriveKanbanColumns([], [], [], {});
      expect(getColumnById(columns, 'backlog').droppable).toBe(true);
      expect(getColumnById(columns, 'in-progress').droppable).toBe(true);
      expect(getColumnById(columns, 'needs-attention').droppable).toBe(true);
      expect(getColumnById(columns, 'review').droppable).toBe(true);
      expect(getColumnById(columns, 'done').droppable).toBe(true);
    });

    it('columns have correct draggableCards flags', () => {
      const columns = deriveKanbanColumns([], [], [], {});
      expect(getColumnById(columns, 'backlog').draggableCards).toBe(true);
      expect(getColumnById(columns, 'in-progress').draggableCards).toBe(true);
      expect(getColumnById(columns, 'needs-attention').draggableCards).toBe(true);
      expect(getColumnById(columns, 'review').draggableCards).toBe(true);
      expect(getColumnById(columns, 'done').draggableCards).toBe(true);
    });

    it('all columns are empty when no data provided', () => {
      const columns = deriveKanbanColumns([], [], [], {});
      for (const col of columns) {
        expect(col.items).toEqual([]);
      }
    });
  });

  describe('backlog column', () => {
    it('places backlog items in backlog column', () => {
      const items = [makeBacklogItem({ id: 'b1' }), makeBacklogItem({ id: 'b2' })];
      const columns = deriveKanbanColumns([], items, [], {});
      const backlog = getColumnById(columns, 'backlog');
      expect(backlog.items).toHaveLength(2);
      expect(backlog.items[0].type).toBe('backlog');
    });

    it('sorts backlog by order field', () => {
      const items = [
        makeBacklogItem({ id: 'b3', order: 2 }),
        makeBacklogItem({ id: 'b1', order: 0 }),
        makeBacklogItem({ id: 'b2', order: 1 }),
      ];
      const columns = deriveKanbanColumns([], items, [], {});
      const backlog = getColumnById(columns, 'backlog');
      expect(backlog.items.map((i) => (i.data as BacklogItem).id)).toEqual(['b1', 'b2', 'b3']);
    });
  });

  describe('pane status routing', () => {
    it('working panes go to in-progress', () => {
      const panes = [makePane({ id: 'p1', agentStatus: 'working' })];
      const columns = deriveKanbanColumns(panes, [], [], {});
      expect(getColumnById(columns, 'in-progress').items).toHaveLength(1);
      expect(getColumnById(columns, 'in-progress').items[0].data).toBe(panes[0]);
    });

    it('can override raw working status to in-progress via effective status map', () => {
      const panes = [makePane({ id: 'p1', agentStatus: 'working', worktreePath: '/tmp/wt' })];
      const columns = deriveKanbanColumns(panes, [], [], { p1: true }, {
        effectiveStatusByPaneId: { p1: 'idle' },
      });
      expect(getColumnById(columns, 'in-progress').items).toHaveLength(1);
      expect(getColumnById(columns, 'review').items).toHaveLength(0);
    });

    it('analyzing panes go to in-progress', () => {
      const panes = [makePane({ id: 'p1', agentStatus: 'analyzing' })];
      const columns = deriveKanbanColumns(panes, [], [], {});
      expect(getColumnById(columns, 'in-progress').items).toHaveLength(1);
    });

    it('undefined status panes go to in-progress (just created)', () => {
      const panes = [makePane({ id: 'p1' })]; // agentStatus is undefined
      const columns = deriveKanbanColumns(panes, [], [], {});
      expect(getColumnById(columns, 'in-progress').items).toHaveLength(1);
    });

    it('does not route persisted waiting metadata to needs-attention', () => {
      const panes = [makePane({ id: 'p1', agentStatus: 'waiting' })];
      const columns = deriveKanbanColumns(panes, [], [], {});
      expect(getColumnById(columns, 'needs-attention').items).toHaveLength(0);
    });

    it('idle panes with worktree and dirty state stay in-progress', () => {
      const panes = [makePane({ id: 'p1', agentStatus: 'idle', worktreePath: '/tmp/wt' })];
      const dirtyMap = { p1: true };
      const columns = deriveKanbanColumns(panes, [], [], dirtyMap);
      expect(getColumnById(columns, 'in-progress').items).toHaveLength(1);
      expect(getColumnById(columns, 'review').items).toHaveLength(0);
    });

    it('keeps idle dirty panes in progress when force-in-progress hint is provided', () => {
      const panes = [makePane({ id: 'p1', agentStatus: 'idle', worktreePath: '/tmp/wt' })];
      const dirtyMap = { p1: true };
      const columns = deriveKanbanColumns(panes, [], [], dirtyMap, {
        forceInProgressPaneIds: new Set(['p1']),
      });
      expect(getColumnById(columns, 'in-progress').items).toHaveLength(1);
      expect(getColumnById(columns, 'review').items).toHaveLength(0);
    });

    it('routes idle dirty panes to needs-attention when waiting-input hint is provided', () => {
      const panes = [makePane({ id: 'p1', agentStatus: 'idle', worktreePath: '/tmp/wt' })];
      const dirtyMap = { p1: true };
      const columns = deriveKanbanColumns(panes, [], [], dirtyMap, {
        forceNeedsAttentionPaneIds: new Set(['p1']),
      });
      expect(getColumnById(columns, 'needs-attention').items).toHaveLength(1);
      expect(getColumnById(columns, 'review').items).toHaveLength(0);
    });

    it('does not route to needs-attention on optionsQuestion alone, since nothing writes that field anymore', () => {
      const panes = [makePane({ id: 'p1', agentStatus: 'idle', optionsQuestion: 'Pick one' })];
      const columns = deriveKanbanColumns(panes, [], [], { p1: true });
      expect(getColumnById(columns, 'needs-attention').items).toHaveLength(0);
      expect(getColumnById(columns, 'in-progress').items).toHaveLength(1);
    });

    it('keeps working panes with a stale options question in progress', () => {
      const panes = [makePane({ id: 'p1', agentStatus: 'working', optionsQuestion: 'Pick one' })];
      const columns = deriveKanbanColumns(panes, [], [], {});
      expect(getColumnById(columns, 'in-progress').items).toHaveLength(1);
      expect(getColumnById(columns, 'needs-attention').items).toHaveLength(0);
    });

    it('uses effective status over raw waiting status for needs-attention routing', () => {
      const panes = [makePane({ id: 'p1', agentStatus: 'waiting', worktreePath: '/tmp/wt' })];
      const columns = deriveKanbanColumns(panes, [], [], { p1: true }, {
        effectiveStatusByPaneId: { p1: 'idle' },
      });
      expect(getColumnById(columns, 'in-progress').items).toHaveLength(1);
      expect(getColumnById(columns, 'needs-attention').items).toHaveLength(0);
    });

    it('routes pane to done when done override is provided', () => {
      const panes = [makePane({ id: 'p1', agentStatus: 'idle', worktreePath: '/tmp/wt' })];
      const columns = deriveKanbanColumns(panes, [], [], { p1: true }, {
        columnOverrides: { p1: 'done' },
      });
      expect(getColumnById(columns, 'done').items).toHaveLength(1);
      expect(getColumnById(columns, 'in-progress').items).toHaveLength(0);
    });

    it('routes pane to needs-attention when override is provided', () => {
      const panes = [makePane({ id: 'p1', agentStatus: 'idle', worktreePath: '/tmp/wt' })];
      const columns = deriveKanbanColumns(panes, [], [], { p1: true }, {
        columnOverrides: { p1: 'needs-attention' },
      });
      expect(getColumnById(columns, 'needs-attention').items).toHaveLength(1);
      expect(getColumnById(columns, 'in-progress').items).toHaveLength(0);
    });

    it('idle panes without worktree do NOT go to review', () => {
      const panes = [makePane({ id: 'p1', agentStatus: 'idle' })]; // no worktreePath
      const columns = deriveKanbanColumns(panes, [], [], { p1: true });
      expect(getColumnById(columns, 'review').items).toHaveLength(0);
    });

    it('idle panes with worktree and clean git state stay in-progress', () => {
      const panes = [makePane({ id: 'p1', agentStatus: 'idle', worktreePath: '/tmp/wt' })];
      const columns = deriveKanbanColumns(panes, [], [], { p1: false });
      expect(getColumnById(columns, 'in-progress').items).toHaveLength(1);
      expect(getColumnById(columns, 'review').items).toHaveLength(0);
    });

    it('idle panes with worktree and unknown git state stay in-progress until git check completes', () => {
      const panes = [makePane({ id: 'p1', agentStatus: 'idle', worktreePath: '/tmp/wt' })];
      const columns = deriveKanbanColumns(panes, [], [], {}); // p1 not in dirtyMap
      expect(getColumnById(columns, 'in-progress').items).toHaveLength(1);
      expect(getColumnById(columns, 'review').items).toHaveLength(0);
    });

    it('idle panes without worktree default to in-progress', () => {
      const panes = [makePane({ id: 'p1', agentStatus: 'idle' })];
      const columns = deriveKanbanColumns(panes, [], [], {});
      const paneColumns = columns.filter((c) => ['in-progress', 'needs-attention', 'review'].includes(c.id));
      const totalPaneItems = paneColumns.reduce((sum, c) => sum + c.items.length, 0);
      expect(totalPaneItems).toBe(1);
      expect(getColumnById(columns, 'in-progress').items).toHaveLength(1);
    });
  });

  describe('done column', () => {
    it('places done items in done column', () => {
      const items = [makeDoneItem({ id: 'd1' }), makeDoneItem({ id: 'd2' })];
      const columns = deriveKanbanColumns([], [], items, {});
      const done = getColumnById(columns, 'done');
      expect(done.items).toHaveLength(2);
      expect(done.items[0].type).toBe('done');
    });
  });

  describe('mixed scenarios', () => {
    it('routes multiple panes to correct columns simultaneously', () => {
      const panes = [
        makePane({ id: 'p1', agentStatus: 'working' }),
        makePane({ id: 'p2', agentStatus: 'analyzing' }),
        makePane({ id: 'p3', agentStatus: 'waiting' }),
        makePane({ id: 'p4', agentStatus: 'idle', worktreePath: '/tmp/wt' }),
        makePane({ id: 'p5' }), // undefined status
      ];
      const dirtyMap = { p4: true };
      const columns = deriveKanbanColumns(panes, [], [], dirtyMap);

      expect(getColumnById(columns, 'in-progress').items).toHaveLength(5);
      expect(getColumnById(columns, 'needs-attention').items).toHaveLength(0);
      expect(getColumnById(columns, 'review').items).toHaveLength(0);
    });

    it('backlog, panes, and done coexist correctly', () => {
      const backlog = [makeBacklogItem({ id: 'b1' })];
      const panes = [makePane({ id: 'p1', agentStatus: 'working' })];
      const done = [makeDoneItem({ id: 'd1' })];

      const columns = deriveKanbanColumns(panes, backlog, done, {});

      expect(getColumnById(columns, 'backlog').items).toHaveLength(1);
      expect(getColumnById(columns, 'in-progress').items).toHaveLength(1);
      expect(getColumnById(columns, 'done').items).toHaveLength(1);
    });

    it('does not mutate input arrays', () => {
      const backlog = [makeBacklogItem({ order: 2 }), makeBacklogItem({ order: 1 })];
      const backlogCopy = [...backlog];
      deriveKanbanColumns([], backlog, [], {});
      expect(backlog).toEqual(backlogCopy);
    });
  });
});
