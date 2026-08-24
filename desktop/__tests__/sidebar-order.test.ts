import { describe, it, expect } from 'vitest';
import type { AumxPane } from 'aumx/core';
import {
  orderSidebarPanes,
  type SidebarActivityLookup,
  type SidebarGroup,
  type SidebarPaneStatus,
  type SidebarStatusLookup,
} from '../src/renderer/lib/sidebar-order';

const ALPHA_ROOT = '/work/alpha';
const BETA_ROOT = '/work/beta';
const NO_STATUS: SidebarStatusLookup = new Map();
const NO_ACTIVITY: SidebarActivityLookup = {};

function makePane(id: string, overrides: Partial<AumxPane> = {}): AumxPane {
  return {
    id,
    slug: id,
    prompt: 'do something',
    paneId: `%${id}`,
    ...overrides,
  };
}

function statusLookup(entries: Record<string, SidebarPaneStatus>): SidebarStatusLookup {
  return new Map(Object.entries(entries));
}

function activityLookup(entries: Record<string, number>): SidebarActivityLookup {
  return Object.fromEntries(
    Object.entries(entries).map(([id, sinceWallMs]) => [id, { sinceWallMs }]),
  );
}

function idsOf(group: SidebarGroup): string[] {
  return group.panes.map((pane) => pane.id);
}

describe('orderSidebarPanes grouping', () => {
  it('groups by project root in first-appearance order', () => {
    // Arrange
    const panes = [
      makePane('a', { projectRoot: ALPHA_ROOT }),
      makePane('b', { projectRoot: BETA_ROOT }),
      makePane('c', { projectRoot: ALPHA_ROOT }),
    ];

    // Act
    const groups = orderSidebarPanes(panes, 'project', 'manual', NO_STATUS, NO_ACTIVITY);

    // Assert
    expect(groups.map((group) => group.key)).toEqual([ALPHA_ROOT, BETA_ROOT]);
    expect(groups.map((group) => group.label)).toEqual(['alpha', 'beta']);
    expect(groups.map(idsOf)).toEqual([['a', 'c'], ['b']]);
  });

  it('falls back to the active project root for panes without projectRoot', () => {
    // Arrange
    const panes = [makePane('a'), makePane('b', { projectRoot: BETA_ROOT })];
    const activeProject = { name: 'alpha', root: ALPHA_ROOT };

    // Act
    const groups = orderSidebarPanes(panes, 'project', 'manual', NO_STATUS, NO_ACTIVITY, activeProject);

    // Assert
    expect(groups.map((group) => group.key)).toEqual([ALPHA_ROOT, BETA_ROOT]);
    expect(groups.map(idsOf)).toEqual([['a'], ['b']]);
  });

  it('collects panes with no resolvable project into a single ungrouped group', () => {
    // Arrange
    const panes = [makePane('a'), makePane('b')];

    // Act
    const groups = orderSidebarPanes(panes, 'project', 'manual', NO_STATUS, NO_ACTIVITY);

    // Assert
    expect(groups).toHaveLength(1);
    expect(groups[0].key).toBe('ungrouped');
    expect(groups[0].label).toBeNull();
  });

  it('drops the header label when every pane belongs to one project', () => {
    // Arrange
    const panes = [
      makePane('a', { projectRoot: ALPHA_ROOT }),
      makePane('b', { projectRoot: ALPHA_ROOT }),
    ];

    // Act
    const groups = orderSidebarPanes(panes, 'project', 'manual', NO_STATUS, NO_ACTIVITY);

    // Assert
    expect(groups).toHaveLength(1);
    expect(groups[0].key).toBe(ALPHA_ROOT);
    expect(groups[0].label).toBeNull();
  });

  it('returns one unlabeled group in flat mode', () => {
    // Arrange
    const panes = [
      makePane('a', { projectRoot: ALPHA_ROOT }),
      makePane('b', { projectRoot: BETA_ROOT }),
    ];

    // Act
    const groups = orderSidebarPanes(panes, 'flat', 'manual', NO_STATUS, NO_ACTIVITY);

    // Assert
    expect(groups).toEqual([{ key: 'all', label: null, panes }]);
  });
});

describe('orderSidebarPanes priority sort', () => {
  it('ranks waiting above active, and idle alongside panes with no agent status', () => {
    // Arrange
    const panes = [
      makePane('idle'),
      makePane('shell'),
      makePane('analyzing'),
      makePane('working'),
      makePane('needs-input'),
    ];
    const statusOf = statusLookup({
      analyzing: { status: 'analyzing', waiting: false },
      idle: { status: 'idle', waiting: false },
      'needs-input': { status: 'idle', waiting: true },
      working: { status: 'working', waiting: false },
    });

    // Act
    const [group] = orderSidebarPanes(panes, 'flat', 'priority', statusOf, NO_ACTIVITY);

    // Assert
    expect(idsOf(group)).toEqual(['needs-input', 'analyzing', 'working', 'idle', 'shell']);
  });

  it('breaks rank ties by activity sinceWallMs descending, treating a missing value as oldest', () => {
    // Arrange
    const panes = [makePane('older'), makePane('never'), makePane('newer')];
    const activityOf = activityLookup({ newer: 30, older: 10 });

    // Act
    const [group] = orderSidebarPanes(panes, 'flat', 'priority', NO_STATUS, activityOf);

    // Assert
    expect(idsOf(group)).toEqual(['newer', 'older', 'never']);
  });

  it('is stable for panes with the same rank and timestamp', () => {
    // Arrange
    const panes = [
      makePane('first'),
      makePane('second'),
      makePane('third'),
    ];
    const statusOf = statusLookup({
      first: { status: 'idle', waiting: false },
      second: { status: 'idle', waiting: false },
      third: { status: 'idle', waiting: false },
    });
    const activityOf = activityLookup({ first: 5, second: 5, third: 5 });

    // Act
    const [group] = orderSidebarPanes(panes, 'flat', 'priority', statusOf, activityOf);

    // Assert
    expect(idsOf(group)).toEqual(['first', 'second', 'third']);
  });
});

describe('orderSidebarPanes updated and manual sorts', () => {
  it('ignores status when sorting by last updated', () => {
    // Arrange
    const panes = [makePane('waiting'), makePane('idle')];
    const statusOf = statusLookup({
      idle: { status: 'idle', waiting: false },
      waiting: { status: 'waiting', waiting: true },
    });
    const activityOf = activityLookup({ idle: 9, waiting: 1 });

    // Act
    const [group] = orderSidebarPanes(panes, 'flat', 'updated', statusOf, activityOf);

    // Assert
    expect(idsOf(group)).toEqual(['idle', 'waiting']);
  });

  it('preserves store order for manual sort', () => {
    // Arrange
    const panes = [makePane('a'), makePane('b'), makePane('c')];
    const statusOf = statusLookup({ c: { status: 'idle', waiting: true } });
    const activityOf = activityLookup({ a: 1, b: 99 });

    // Act
    const [group] = orderSidebarPanes(panes, 'flat', 'manual', statusOf, activityOf);

    // Assert
    expect(idsOf(group)).toEqual(['a', 'b', 'c']);
  });

  it('places new pane last within its project group with manual sort and project organize', () => {
    // Arrange
    const panes = [
      makePane('a', { projectRoot: ALPHA_ROOT }),
      makePane('b', { projectRoot: ALPHA_ROOT }),
      makePane('c', { projectRoot: ALPHA_ROOT }),
    ];

    // Act
    const groups = orderSidebarPanes(panes, 'project', 'manual', NO_STATUS, NO_ACTIVITY);

    // Assert
    expect(groups[0].panes.map((p) => p.id)).toEqual(['a', 'b', 'c']);
  });

  it('labels the unresolvable-project group so it cannot merge into a labeled one', () => {
    // Arrange — one pane resolves to a project, one has nothing to resolve
    const panes: AumxPane[] = [
      { agent: 'claude', id: 'a', paneId: '%1', projectRoot: ALPHA_ROOT, prompt: 'p', slug: 'a' },
      { agent: 'claude', id: 'b', paneId: '%2', prompt: 'p', slug: 'b' },
    ];

    // Act
    const groups = orderSidebarPanes(panes, 'project', 'manual', NO_STATUS, NO_ACTIVITY, null);

    // Assert
    expect(groups.map((group) => group.label)).toEqual(['alpha', 'Other']);
  });

  it('treats a working pane as active-now for updated sort, ranking it above a fresher idle one', () => {
    // Arrange
    const panes = [makePane('idle-fresh'), makePane('working-stale')];
    const statusOf = statusLookup({
      'idle-fresh': { status: 'idle', waiting: false },
      'working-stale': { status: 'working', waiting: false },
    });
    const activityOf = activityLookup({ 'idle-fresh': 100, 'working-stale': 1 });

    // Act
    const [group] = orderSidebarPanes(panes, 'flat', 'updated', statusOf, activityOf);

    // Assert
    expect(idsOf(group)).toEqual(['working-stale', 'idle-fresh']);
  });

  it('breaks ties among active-now panes by sinceWallMs descending, then original index', () => {
    // Arrange
    const panes = [
      makePane('working-older'),
      makePane('working-newer'),
      makePane('working-untimed'),
    ];
    const statusOf = statusLookup({
      'working-newer': { status: 'working', waiting: false },
      'working-older': { status: 'analyzing', waiting: false },
      'working-untimed': { status: 'working', waiting: false },
    });
    const activityOf = activityLookup({ 'working-newer': 20, 'working-older': 5 });

    // Act
    const [group] = orderSidebarPanes(panes, 'flat', 'updated', statusOf, activityOf);

    // Assert
    expect(idsOf(group)).toEqual(['working-newer', 'working-older', 'working-untimed']);
  });

  it('does not treat a waiting pane as active-now for updated sort', () => {
    // Arrange — a waiting pane is not "working right now"; it should sort on sinceWallMs alone
    const panes = [makePane('idle-fresh'), makePane('needs-input')];
    const statusOf = statusLookup({
      'idle-fresh': { status: 'idle', waiting: false },
      'needs-input': { status: 'waiting', waiting: true },
    });
    const activityOf = activityLookup({ 'idle-fresh': 100, 'needs-input': 1 });

    // Act
    const [group] = orderSidebarPanes(panes, 'flat', 'updated', statusOf, activityOf);

    // Assert
    expect(idsOf(group)).toEqual(['idle-fresh', 'needs-input']);
  });
});

describe('orderSidebarPanes group ordering', () => {
  it('orders groups under priority sort by their best (minimum) member rank', () => {
    // Arrange — beta only has idle members, alpha has one waiting member
    const panes = [
      makePane('a1', { projectRoot: ALPHA_ROOT }),
      makePane('a2', { projectRoot: ALPHA_ROOT }),
      makePane('needs-input', { projectRoot: BETA_ROOT }),
      makePane('b2', { projectRoot: BETA_ROOT }),
    ];
    const statusOf = statusLookup({
      a1: { status: 'idle', waiting: false },
      a2: { status: 'idle', waiting: false },
      b2: { status: 'idle', waiting: false },
      'needs-input': { status: 'idle', waiting: true },
    });

    // Act
    const groups = orderSidebarPanes(panes, 'project', 'priority', statusOf, NO_ACTIVITY);

    // Assert — beta (has the waiting member) ranks above alpha
    expect(groups.map((group) => group.key)).toEqual([BETA_ROOT, ALPHA_ROOT]);
  });

  it('sorts tied groups by label ascending and forces the ungrouped group last', () => {
    // Arrange — all panes idle, so every group ties on rank
    const panes = [
      makePane('z1', { projectRoot: '/work/zeta' }),
      makePane('a1', { projectRoot: ALPHA_ROOT }),
      makePane('u1'),
    ];
    const statusOf = statusLookup({
      a1: { status: 'idle', waiting: false },
      u1: { status: 'idle', waiting: false },
      z1: { status: 'idle', waiting: false },
    });

    // Act
    const groups = orderSidebarPanes(panes, 'project', 'priority', statusOf, NO_ACTIVITY, null);

    // Assert
    expect(groups.map((group) => group.label)).toEqual(['alpha', 'zeta', 'Other']);
  });

  it('orders groups under updated sort by their max effective-updated timestamp', () => {
    // Arrange — beta has a currently-working pane; alpha only has an older idle pane
    const panes = [
      makePane('a1', { projectRoot: ALPHA_ROOT }),
      makePane('working', { projectRoot: BETA_ROOT }),
      makePane('b2', { projectRoot: BETA_ROOT }),
    ];
    const statusOf = statusLookup({
      a1: { status: 'idle', waiting: false },
      b2: { status: 'idle', waiting: false },
      working: { status: 'working', waiting: false },
    });
    const activityOf = activityLookup({ a1: 50, b2: 5, working: 1 });

    // Act
    const groups = orderSidebarPanes(panes, 'project', 'updated', statusOf, activityOf);

    // Assert
    expect(groups.map((group) => group.key)).toEqual([BETA_ROOT, ALPHA_ROOT]);
  });

  it('preserves first-encounter group order under manual sort', () => {
    // Arrange — beta would rank first under priority or updated, but manual ignores that
    const panes = [
      makePane('a1', { projectRoot: ALPHA_ROOT }),
      makePane('working', { projectRoot: BETA_ROOT }),
    ];
    const statusOf = statusLookup({
      a1: { status: 'idle', waiting: false },
      working: { status: 'working', waiting: false },
    });
    const activityOf = activityLookup({ a1: 1, working: 99 });

    // Act
    const groups = orderSidebarPanes(panes, 'project', 'manual', statusOf, activityOf);

    // Assert
    expect(groups.map((group) => group.key)).toEqual([ALPHA_ROOT, BETA_ROOT]);
  });
});
