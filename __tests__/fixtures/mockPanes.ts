/**
 * Mock MuxBasePane fixtures for testing
 */

import type { MuxBasePane } from '../../src/types.js';

export function createMockPane(overrides?: Partial<MuxBasePane>): MuxBasePane {
  return {
    id: 'muxbase-1',
    slug: 'test-pane',
    prompt: 'test prompt',
    paneId: '%42',
    worktreePath: '/test/worktree/path',
    agent: 'claude',
    type: 'worktree',
    ...overrides,
  };
}

export function createShellPane(overrides?: Partial<MuxBasePane>): MuxBasePane {
  return createMockPane({
    type: 'shell',
    worktreePath: undefined,
    ...overrides,
  });
}

export function createWorktreePane(overrides?: Partial<MuxBasePane>): MuxBasePane {
  return createMockPane({
    type: 'worktree',
    worktreePath: '/test/project/.muxbase/worktrees/test-pane',
    ...overrides,
  });
}

export function createMultiplePanes(count: number): MuxBasePane[] {
  return Array.from({ length: count }, (_, i) => createMockPane({
    id: `muxbase-${i + 1}`,
    slug: `test-pane-${i + 1}`,
    paneId: `%${40 + i}`,
  }));
}
