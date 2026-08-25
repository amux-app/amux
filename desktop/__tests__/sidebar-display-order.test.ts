import type { MuxBasePane } from 'muxbase/core';
import { describe, expect, it } from 'vitest';
import { resolveSidebarDisplayOrder } from '../src/renderer/lib/sidebar-display-order';
import type { SidebarGroup } from '../src/renderer/lib/sidebar-order';

function makePane(id: string, overrides: Partial<MuxBasePane> = {}): MuxBasePane {
  return { id, paneId: `%${id}`, prompt: 'do something', slug: id, ...overrides };
}

function group(key: string, panes: MuxBasePane[], label: string | null = key): SidebarGroup {
  return { key, label, panes };
}

describe('resolveSidebarDisplayOrder', () => {
  it('returns the target order when the pointer is outside the list', () => {
    // Arrange
    const target = [group('a', [makePane('1'), makePane('2')])];
    const held = [group('a', [makePane('2'), makePane('1')])];

    // Act
    const result = resolveSidebarDisplayOrder(target, held, false);

    // Assert
    expect(result.map((g) => g.panes.map((p) => p.id))).toEqual([['1', '2']]);
  });

  it('returns the target order when there is no held snapshot yet', () => {
    // Arrange
    const target = [group('a', [makePane('1'), makePane('2')])];

    // Act
    const result = resolveSidebarDisplayOrder(target, null, true);

    // Assert
    expect(result).toBe(target);
  });

  it('keeps the held order while the pointer is inside, even after the target reorders', () => {
    // Arrange — held has 2 before 1; target has since reordered to 1 before 2
    const held = [group('a', [makePane('2', { title: 'stale' }), makePane('1', { title: 'stale' })])];
    const target = [group('a', [makePane('1', { title: 'fresh' }), makePane('2', { title: 'fresh' })])];

    // Act
    const result = resolveSidebarDisplayOrder(target, held, true);

    // Assert — order is held, but pane data is re-projected from target
    expect(result.map((g) => g.panes.map((p) => p.id))).toEqual([['2', '1']]);
    expect(result.map((g) => g.panes.map((p) => p.title))).toEqual([['fresh', 'fresh']]);
  });

  it('re-projects the held group label from the target', () => {
    // Arrange
    const held = [group('a', [makePane('1')], 'Old Label')];
    const target = [group('a', [makePane('1')], 'New Label')];

    // Act
    const result = resolveSidebarDisplayOrder(target, held, true);

    // Assert
    expect(result[0].label).toBe('New Label');
  });

  it('commits to the target immediately when a pane is added mid-hold', () => {
    // Arrange
    const held = [group('a', [makePane('1')])];
    const target = [group('a', [makePane('1'), makePane('2')])];

    // Act
    const result = resolveSidebarDisplayOrder(target, held, true);

    // Assert
    expect(result).toBe(target);
  });

  it('commits to the target immediately when a pane is removed mid-hold', () => {
    // Arrange
    const held = [group('a', [makePane('1'), makePane('2')])];
    const target = [group('a', [makePane('1')])];

    // Act
    const result = resolveSidebarDisplayOrder(target, held, true);

    // Assert
    expect(result).toBe(target);
  });

  it('commits to the target immediately when a group is added or removed mid-hold', () => {
    // Arrange
    const held = [group('a', [makePane('1')])];
    const target = [group('a', [makePane('1')]), group('b', [makePane('2')])];

    // Act
    const result = resolveSidebarDisplayOrder(target, held, true);

    // Assert
    expect(result).toBe(target);
  });

  it('commits held groups back to the target order on pointer leave', () => {
    // Arrange
    const held = [group('a', [makePane('2'), makePane('1')])];
    const target = [group('a', [makePane('1'), makePane('2')])];

    // Act — pointer left, so isPointerInside flips false
    const result = resolveSidebarDisplayOrder(target, held, false);

    // Assert
    expect(result).toBe(target);
  });
});
