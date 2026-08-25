import type { MuxBasePane } from 'muxbase/core';
import { describe, expect, it } from 'vitest';
import { getCommandPaletteSearchScope } from '../src/renderer/lib/commandPaletteSearchScope';

function makePane(overrides: Partial<MuxBasePane> = {}): MuxBasePane {
  return {
    id: 'pane-1',
    paneId: '%1',
    prompt: 'scope',
    slug: 'pane-1',
    ...overrides,
  };
}

describe('getCommandPaletteSearchScope', () => {
  it('prefers the selected pane worktree', () => {
    const scope = getCommandPaletteSearchScope([
      makePane({ id: 'pane-1', projectRoot: '/repo', slug: 'frontend', worktreePath: '/repo/.muxbase/worktrees/frontend' }),
      makePane({ id: 'pane-2', projectRoot: '/repo', slug: 'backend', worktreePath: '/repo/.muxbase/worktrees/backend' }),
    ], 'pane-2', '/repo');

    expect(scope).toEqual({
      label: 'backend',
      rootPath: '/repo/.muxbase/worktrees/backend',
      scopeId: 'pane-2',
    });
  });

  it('falls back to the selected pane project root when no worktree exists', () => {
    const scope = getCommandPaletteSearchScope([
      makePane({ id: 'pane-1', projectRoot: '/repo', slug: 'shell-pane' }),
    ], 'pane-1', '/repo');

    expect(scope).toEqual({
      label: 'shell-pane',
      rootPath: '/repo',
      scopeId: 'pane-1',
    });
  });

  it('falls back to the first pane when nothing is selected', () => {
    const scope = getCommandPaletteSearchScope([
      makePane({ id: 'pane-1', projectRoot: '/repo', slug: 'first-pane', worktreePath: '/repo/.muxbase/worktrees/first-pane' }),
      makePane({ id: 'pane-2', projectRoot: '/repo', slug: 'second-pane', worktreePath: '/repo/.muxbase/worktrees/second-pane' }),
    ], null, '/repo');

    expect(scope).toEqual({
      label: 'first-pane',
      rootPath: '/repo/.muxbase/worktrees/first-pane',
      scopeId: 'pane-1',
    });
  });

  it('falls back to the session project root when there are no panes', () => {
    const scope = getCommandPaletteSearchScope([], null, '/repo');

    expect(scope).toEqual({
      label: 'project',
      rootPath: '/repo',
      scopeId: '/repo',
    });
  });
});
