import { describe, expect, it } from 'vitest';
import type { BacklogItem } from '../../src/shared/kanban-types';
import {
  clearSelectionIfLaunching,
  launchingCardId,
  launchingItemIdFromCardId,
  paneCardId,
  paneIdFromCardId,
  resolveLaunchingItem,
} from '../../src/renderer/lib/kanban-selection';

function backlogItem(id: string): BacklogItem {
  return {
    id,
    title: `task-${id}`,
    prompt: `prompt-${id}`,
    complexity: 'M',
    createdAt: Date.now(),
    order: 0,
  };
}

describe('kanban-selection helpers', () => {
  it('builds and parses pane card ids', () => {
    const cardId = paneCardId('pane-123');
    expect(cardId).toBe('pane-pane-123');
    expect(paneIdFromCardId(cardId)).toBe('pane-123');
    expect(paneIdFromCardId('launching-abc')).toBeNull();
  });

  it('builds and parses launching card ids', () => {
    const cardId = launchingCardId('backlog-1');
    expect(cardId).toBe('launching-backlog-1');
    expect(launchingItemIdFromCardId(cardId)).toBe('backlog-1');
    expect(launchingItemIdFromCardId('pane-abc')).toBeNull();
  });

  it('resolves selected launching item from card id', () => {
    const items = [backlogItem('a'), backlogItem('b')];
    expect(resolveLaunchingItem('launching-b', items)?.id).toBe('b');
    expect(resolveLaunchingItem('pane-b', items)).toBeNull();
    expect(resolveLaunchingItem('launching-c', items)).toBeNull();
  });

  it('clears selection only when current selection is a completed launching item', () => {
    expect(clearSelectionIfLaunching('launching-a', ['a'])).toBeNull();
    expect(clearSelectionIfLaunching('launching-a', ['b'])).toBe('launching-a');
    expect(clearSelectionIfLaunching('pane-a', ['a'])).toBe('pane-a');
    expect(clearSelectionIfLaunching(null, ['a'])).toBeNull();
  });
});
