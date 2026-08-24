/**
 * Mock AumxPane fixtures for testing
 */

import type { AumxPane } from '../../src/types.js';

export function createMockPane(overrides?: Partial<AumxPane>): AumxPane {
  return {
    id: 'aumx-1',
    slug: 'test-pane',
    prompt: 'test prompt',
    paneId: '%42',
    worktreePath: '/test/worktree/path',
    agent: 'claude',
    type: 'worktree',
    ...overrides,
  };
}

export function createShellPane(overrides?: Partial<AumxPane>): AumxPane {
  return createMockPane({
    type: 'shell',
    worktreePath: undefined,
    ...overrides,
  });
}

export function createWorktreePane(overrides?: Partial<AumxPane>): AumxPane {
  return createMockPane({
    type: 'worktree',
    worktreePath: '/test/project/.aumx/worktrees/test-pane',
    ...overrides,
  });
}

export function createMultiplePanes(count: number): AumxPane[] {
  return Array.from({ length: count }, (_, i) => createMockPane({
    id: `aumx-${i + 1}`,
    slug: `test-pane-${i + 1}`,
    paneId: `%${40 + i}`,
  }));
}
