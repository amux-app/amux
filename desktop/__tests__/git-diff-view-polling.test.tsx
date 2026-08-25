// @vitest-environment happy-dom
import React from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import type { MuxBasePane } from 'muxbase/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GitDiffView } from '../src/renderer/components/pane-detail/GitDiffView';

const gitApi = vi.hoisted(() => ({
  getDiff: vi.fn(),
  getFileDiff: vi.fn(),
}));

vi.mock('../src/renderer/api/git.api', () => gitApi);

vi.mock('@git-diff-view/react', () => ({
  DiffModeEnum: { Split: 3, Unified: 4 },
  DiffView: ({ data }: { data: { hunks: string[] } }) => (
    <pre data-testid="diff-view">{data.hunks.join('\n')}</pre>
  ),
}));

const WORKING_POLL_MS = 4000;
const PANE: MuxBasePane = {
  id: 'pane-1',
  paneId: '%1',
  prompt: 'test',
  slug: 'pane-1',
  worktreePath: '/repo',
};

function setVisibility(state: 'hidden' | 'visible'): void {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  document.dispatchEvent(new Event('visibilitychange'));
}

async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

async function renderLoaded(): Promise<ReturnType<typeof render>> {
  const view = render(<GitDiffView pane={PANE} />);
  await advance(0);
  expect(gitApi.getDiff).toHaveBeenCalled();
  gitApi.getDiff.mockClear();
  return view;
}

describe('GitDiffView polling', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    gitApi.getDiff.mockResolvedValue({
      changedFiles: [],
      deletions: 0,
      diff: '',
      files: [],
      filesChanged: 0,
      insertions: 0,
      repo: { branch: 'main', isGitRepo: true, repoRoot: '/repo' },
      untrackedFiles: [],
    });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it('polls the working diff on the widened interval while visible', async () => {
    // Arrange
    await renderLoaded();

    // Act
    await advance(WORKING_POLL_MS - 1);

    // Assert
    expect(gitApi.getDiff).not.toHaveBeenCalled();
    await advance(1);
    expect(gitApi.getDiff).toHaveBeenCalledTimes(1);
  });

  it('stops polling once the tab hides the diff view', async () => {
    // Arrange
    const view = await renderLoaded();

    // Act: switching tabs unmounts the diff view in every host surface.
    view.unmount();
    await advance(WORKING_POLL_MS * 5);

    // Assert
    expect(gitApi.getDiff).not.toHaveBeenCalled();
  });

  it('stops polling while the window is hidden and refreshes the moment it returns', async () => {
    // Arrange
    await renderLoaded();

    // Act
    act(() => setVisibility('hidden'));
    await advance(WORKING_POLL_MS * 5);
    const callsWhileHidden = gitApi.getDiff.mock.calls.length;
    act(() => setVisibility('visible'));

    // Assert: the refresh fires on the transition, before any interval elapses.
    expect(callsWhileHidden).toBe(0);
    expect(gitApi.getDiff).toHaveBeenCalledTimes(1);
  });

  it('refreshes when diff content changes without changing its length or summary counts', async () => {
    // Arrange
    gitApi.getDiff.mockResolvedValueOnce({
      changedFiles: ['notes.ts'],
      deletions: 1,
      diff: 'old',
      files: [{
        additions: 1,
        deletions: 1,
        oldPath: 'notes.ts',
        path: 'notes.ts',
        patch: 'old',
        staged: false,
        status: 'modified',
        unstaged: true,
      }],
      filesChanged: 1,
      insertions: 1,
      repo: { branch: 'main', isGitRepo: true, repoRoot: '/repo' },
      untrackedFiles: [],
    });
    gitApi.getFileDiff.mockResolvedValueOnce({ path: 'notes.ts', patch: 'FULL_OLD_CONTENT' });
    await renderLoaded();
    await advance(0);
    expect(screen.getByTestId('diff-view').textContent).toContain('FULL_OLD_CONTENT');

    gitApi.getDiff.mockResolvedValueOnce({
      changedFiles: ['notes.ts'],
      deletions: 1,
      diff: 'new',
      files: [{
        additions: 1,
        deletions: 1,
        oldPath: 'notes.ts',
        path: 'notes.ts',
        patch: 'new',
        staged: false,
        status: 'modified',
        unstaged: true,
      }],
      filesChanged: 1,
      insertions: 1,
      repo: { branch: 'main', isGitRepo: true, repoRoot: '/repo' },
      untrackedFiles: [],
    });
    gitApi.getFileDiff.mockResolvedValueOnce({ path: 'notes.ts', patch: 'FULL_NEW_CONTENT' });

    // Act
    await advance(WORKING_POLL_MS);

    // Assert
    expect(gitApi.getFileDiff).toHaveBeenCalledTimes(2);
    const rendered = screen.getByTestId('diff-view').textContent;
    expect(rendered).toContain('FULL_NEW_CONTENT');
    expect(rendered).not.toContain('FULL_OLD_CONTENT');
  });
});
