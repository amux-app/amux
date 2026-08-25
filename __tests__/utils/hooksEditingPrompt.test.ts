import { describe, expect, it } from 'vitest';

import { isHooksEditingPrompt } from '../../src/utils/hooksEditingPrompt.js';

describe('isHooksEditingPrompt', () => {
  it.each([
    'Create lifecycle hooks',
    'edit the muxbase hooks',
    'MODIFY .muxbase hooks safely',
    'work on .muxbase-hooks/worktree_created',
  ])('detects hook-editing intent in %j', (prompt) => {
    expect(isHooksEditingPrompt(prompt)).toBe(true);
  });

  it.each([
    'Explain hooks before deciding whether to edit anything',
    'Create a pane without lifecycle integrations',
    'hooks are useful; later we may modify the app',
  ])('does not over-match %j', (prompt) => {
    expect(isHooksEditingPrompt(prompt)).toBe(false);
  });

  it('handles long uncontrolled prompts without regex backtracking', () => {
    expect(isHooksEditingPrompt(`create${'.'.repeat(250_000)}hooks`)).toBe(true);
  });
});
