// @vitest-environment happy-dom
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import type { MuxBasePane } from 'muxbase/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GitDiffView } from '../src/renderer/components/pane-detail/GitDiffView';
import {
  GIT_DIFF_CONTENT_MIN_SIZE,
  GIT_DIFF_FILE_LIST_DEFAULT_SIZE,
  GIT_DIFF_FILE_LIST_MAX_SIZE,
  GIT_DIFF_FILE_LIST_MIN_SIZE,
  GIT_DIFF_FILE_LIST_PANEL_ID_PREFIX,
  GIT_DIFF_RESIZE_HANDLE_CLASS,
  GIT_DIFF_RESIZE_TARGET_MINIMUM_SIZE,
} from '../src/renderer/components/pane-detail/gitDiffLayout';

const gitApi = vi.hoisted(() => ({
  getDiff: vi.fn(),
  getFileDiff: vi.fn(),
}));

vi.mock('../src/renderer/api/git.api', () => gitApi);

vi.mock('@git-diff-view/react', () => ({
  DiffModeEnum: { Split: 3, Unified: 4 },
  DiffView: () => <pre data-testid="diff-view" />,
}));

const PANE: MuxBasePane = {
  id: 'pane-1',
  paneId: '%1',
  prompt: 'test',
  slug: 'pane-1',
  worktreePath: '/repo',
};

describe('GitDiffView resizable file list', () => {
  beforeEach(() => {
    const patch = [
      'diff --git a/src/example.ts b/src/example.ts',
      '--- a/src/example.ts',
      '+++ b/src/example.ts',
      '@@ -1 +1 @@',
      '-old',
      '+new',
    ].join('\n');

    gitApi.getDiff.mockResolvedValue({
      changedFiles: ['src/example.ts'],
      deletions: 1,
      diff: patch,
      files: [
        {
          additions: 1,
          deletions: 1,
          path: 'src/example.ts',
          patch,
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
    gitApi.getFileDiff.mockResolvedValue({ path: 'src/example.ts', patch });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('exposes an accessible horizontal resize control between files and code', async () => {
    render(<GitDiffView pane={PANE} />);

    const separator = await screen.findByRole('separator', {
      name: 'Resize changed files panel',
    });

    expect(separator.getAttribute('aria-orientation')).toBe('vertical');
    expect(separator.getAttribute('tabindex')).toBe('0');
    expect(separator.className).toContain(GIT_DIFF_RESIZE_HANDLE_CLASS);
  });

  it('keeps each diff splitter association unique when several panes are visible', async () => {
    render(
      <>
        <GitDiffView pane={PANE} />
        <GitDiffView pane={{ ...PANE, id: 'pane-2', paneId: '%2' }} />
      </>,
    );

    await screen.findAllByRole('separator', {
      name: 'Resize changed files panel',
    });
    const fileListPanelIds = Array.from(document.querySelectorAll(`[id^="${GIT_DIFF_FILE_LIST_PANEL_ID_PREFIX}-"]`), (panel) => panel.id);

    expect(fileListPanelIds).toHaveLength(2);
    expect(new Set(fileListPanelIds).size).toBe(2);
  });

  it('keeps the file list compact while protecting useful code width', () => {
    expect(GIT_DIFF_FILE_LIST_DEFAULT_SIZE).toBe(280);
    expect(GIT_DIFF_FILE_LIST_MIN_SIZE).toBe(160);
    expect(GIT_DIFF_FILE_LIST_MAX_SIZE).toBe('50%');
    expect(GIT_DIFF_CONTENT_MIN_SIZE).toBe('35%');
    expect(GIT_DIFF_RESIZE_TARGET_MINIMUM_SIZE).toEqual({
      fine: 14,
      coarse: 28,
    });
  });
});
