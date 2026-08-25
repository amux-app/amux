import { execFileSync } from 'node:child_process';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { killMultiPaneTestSessionBestEffort } from './e2e/e2e-helpers.js';

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

describe('multi-pane E2E tmux cleanup', () => {
  beforeEach(() => {
    vi.mocked(execFileSync).mockReset();
  });

  it('kills only the uniquely named multi-pane test session', () => {
    expect(killMultiPaneTestSessionBestEffort('muxbase-muxbase-multi-pane-e2e-abc123'))
      .toBe(true);
    expect(execFileSync).toHaveBeenCalledWith(
      'tmux',
      ['kill-session', '-t', 'muxbase-muxbase-multi-pane-e2e-abc123'],
      { stdio: 'ignore' },
    );
  });

  it('refuses to kill a non-test session', () => {
    expect(killMultiPaneTestSessionBestEffort('muxbase-muxbase')).toBe(false);
    expect(execFileSync).not.toHaveBeenCalled();
  });
});
