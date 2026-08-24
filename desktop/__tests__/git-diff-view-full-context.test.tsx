// @vitest-environment happy-dom
import React from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import type { AumxPane } from 'aumx/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GitDiffView } from '../src/renderer/components/pane-detail/GitDiffView';

const gitApi = vi.hoisted(() => ({
  getDiff: vi.fn(),
  getFileDiff: vi.fn(),
}));

vi.mock('../src/renderer/api/git.api', () => gitApi);

const FULL_FILE_INDICATOR_LABEL = 'Full file context loaded';

vi.mock('@git-diff-view/react', () => ({
  DiffModeEnum: { Split: 3, Unified: 4 },
  DiffView: ({ data }: { data: { hunks: string[] } }) => (
    <pre data-testid="diff-view">{data.hunks.join('\n')}</pre>
  ),
}));

describe('GitDiffView full context', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('replaces the compact selected-file patch with full-file context', async () => {
    // Arrange
    const compactPatch = [
      'diff --git a/src/long-file.ts b/src/long-file.ts',
      '--- a/src/long-file.ts',
      '+++ b/src/long-file.ts',
      '@@ -57,7 +57,7 @@',
      ' line 57',
      '-line 60',
      '+line 60 changed',
    ].join('\n');
    const fullPatch = [
      'diff --git a/src/long-file.ts b/src/long-file.ts',
      '--- a/src/long-file.ts',
      '+++ b/src/long-file.ts',
      '@@ -1,80 +1,80 @@',
      ' line 1',
      '-line 60',
      '+line 60 changed',
      ' line 80',
    ].join('\n');
    const pane: AumxPane = {
      id: 'pane-1',
      paneId: '%1',
      prompt: 'test',
      slug: 'pane-1',
      worktreePath: '/repo',
    };

    gitApi.getDiff.mockResolvedValue({
      changedFiles: ['src/long-file.ts'],
      deletions: 1,
      diff: compactPatch,
      files: [
        {
          additions: 1,
          deletions: 1,
          path: 'src/long-file.ts',
          patch: compactPatch,
          staged: false,
          status: 'modified',
          unstaged: true,
        },
      ],
      filesChanged: 1,
      insertions: 1,
      repo: { branch: 'main', isGitRepo: true, repoRoot: '/repo' },
      untrackedFiles: [],
    });
    gitApi.getFileDiff.mockResolvedValue({ path: 'src/long-file.ts', patch: fullPatch });

    // Act
    render(<GitDiffView pane={pane} />);

    // Assert
    expect(await screen.findByText('src/long-file.ts')).toBeTruthy();
    await waitFor(() => expect(gitApi.getFileDiff).toHaveBeenCalledWith({
      diffMode: 'working',
      oldPath: undefined,
      path: 'src/long-file.ts',
      worktreePath: '/repo',
    }));
    await waitFor(() => expect(screen.getByTestId('diff-view').textContent).toContain(' line 1'));
    expect(screen.getByTestId('diff-view').textContent).toContain(' line 80');
    expect(screen.getByLabelText(FULL_FILE_INDICATOR_LABEL)).toBeTruthy();
  });

  it('keeps the compact patch visible when full-file context is too large', async () => {
    // Arrange
    const compactPatch = [
      'diff --git a/src/large-file.ts b/src/large-file.ts',
      '--- a/src/large-file.ts',
      '+++ b/src/large-file.ts',
      '@@ -57,7 +57,7 @@',
      ' line 57',
      '-line 60',
      '+line 60 changed',
    ].join('\n');
    const pane: AumxPane = {
      id: 'pane-1',
      paneId: '%1',
      prompt: 'test',
      slug: 'pane-1',
      worktreePath: '/repo',
    };

    gitApi.getDiff.mockResolvedValue({
      changedFiles: ['src/large-file.ts'],
      deletions: 1,
      diff: compactPatch,
      files: [
        {
          additions: 1,
          deletions: 1,
          path: 'src/large-file.ts',
          patch: compactPatch,
          staged: false,
          status: 'modified',
          unstaged: true,
        },
      ],
      filesChanged: 1,
      insertions: 1,
      repo: { branch: 'main', isGitRepo: true, repoRoot: '/repo' },
      untrackedFiles: [],
    });
    gitApi.getFileDiff.mockResolvedValue({
      error: 'Full-file diff is too large; showing compact diff.',
      path: 'src/large-file.ts',
      tooLarge: true,
    });

    // Act
    render(<GitDiffView pane={pane} />);

    // Assert
    expect(await screen.findByText('src/large-file.ts')).toBeTruthy();
    await waitFor(() => expect(gitApi.getFileDiff).toHaveBeenCalled());
    expect(screen.getByTestId('diff-view').textContent).toContain(' line 57');
    expect(screen.queryByLabelText(FULL_FILE_INDICATOR_LABEL)).toBeNull();
    const fallbackIndicator = await screen.findByRole('img', { name: /too large/i });
    expect(fallbackIndicator.getAttribute('aria-label')).toBe('Full-file diff is too large; showing compact diff.');
  });
});
