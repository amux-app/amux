import { describe, expect, it } from 'vitest';
import {
  parseMuxBaseConfig,
  parseMuxBaseStoredSettings,
} from '../../src/utils/persistedStateValidation.js';

const VALID_PANE = {
  id: 'pane-1',
  paneId: '%1',
  prompt: 'Implement authentication',
  slug: 'implement-authentication',
};

describe('persisted state validation', () => {
  it('accepts a valid legacy config and supplies safe missing defaults', () => {
    expect(parseMuxBaseConfig({ panes: [VALID_PANE] })).toMatchObject({
      lastUpdated: '',
      panes: [VALID_PANE],
      projectName: '',
      projectRoot: '',
      settings: {},
    });
  });

  it('rejects config panes without the identity fields used by orchestration', () => {
    expect(() => parseMuxBaseConfig({ panes: [{ id: 'pane-1' }] }))
      .toThrow('paneId');
  });

  it('rejects malformed nested config settings', () => {
    expect(() => parseMuxBaseConfig({ panes: [], settings: { useWorktree: 'yes' } }))
      .toThrow('useWorktree');
  });

  it('rejects malformed optional pane metadata used by runtime services', () => {
    expect(() => parseMuxBaseConfig({
      panes: [{ ...VALID_PANE, worktreePath: 42 }],
    })).toThrow('worktreePath');

    expect(() => parseMuxBaseConfig({
      panes: [{
        ...VALID_PANE,
        review: {
          changedFiles: 'many',
          reviewId: 'review-1',
          sourcePaneId: 'pane-0',
          sourceSlug: 'source',
          startedAt: Date.now(),
        },
      }],
    })).toThrow('review.changedFiles');

    expect(() => parseMuxBaseConfig({
      panes: [{ ...VALID_PANE, startedWithoutInitialPrompt: 'yes' }],
    })).toThrow('startedWithoutInitialPrompt');
  });

  it('accepts and validates persisted conflict ownership metadata', () => {
    const conflictMerge = {
      conflictPaneId: 'conflict-pane',
      mainRepoPath: '/workspace/main',
      repoPath: '/workspace/worktree',
      sourceBranch: 'feature',
      sourceCommit: 'source-commit',
      sourcePaneId: 'source-pane',
      targetBranch: 'main',
      targetCommit: 'target-commit',
      transactionId: 'transaction-1',
    };

    expect(parseMuxBaseConfig({ panes: [{ ...VALID_PANE, conflictMerge }] }))
      .toMatchObject({ panes: [{ conflictMerge }] });
    expect(() => parseMuxBaseConfig({
      panes: [{ ...VALID_PANE, conflictMerge: { ...conflictMerge, targetCommit: '' } }],
    })).toThrow('conflictMerge.targetCommit');
  });

  it.each([
    '0123456789abcdef0123456789abcdef01234567',
    '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  ])('accepts a %s git object id in review metadata', (snapshotSha) => {
    const pane = {
      ...VALID_PANE,
      review: {
        changedFiles: 1,
        reviewId: 'review-1',
        snapshotSha,
        sourcePaneId: 'pane-0',
        sourceSlug: 'source',
        startedAt: Date.now(),
      },
    };

    expect(parseMuxBaseConfig({ panes: [pane] }).panes[0]).toMatchObject({ review: { snapshotSha } });
  });

  it('rejects a malformed review snapshot object id while accepting legacy metadata without one', () => {
    const review = {
      changedFiles: 1,
      reviewId: 'review-1',
      sourcePaneId: 'pane-0',
      sourceSlug: 'source',
      startedAt: Date.now(),
    };

    expect(parseMuxBaseConfig({ panes: [{ ...VALID_PANE, review }] }).panes[0]).toMatchObject({ review });
    expect(() => parseMuxBaseConfig({
      panes: [{ ...VALID_PANE, review: { ...review, snapshotSha: 'not-a-git-object' } }],
    })).toThrow('review.snapshotSha');
  });

  it('rejects invalid persisted control pane geometry', () => {
    expect(() => parseMuxBaseConfig({ controlPaneSize: 0, panes: [] }))
      .toThrow('controlPaneSize');
  });

  it('accepts known settings, preserves unknown values, and rejects malformed known values', () => {
    expect(parseMuxBaseStoredSettings({ defaultAgent: '' })).toEqual({ defaultAgent: '' });

    expect(parseMuxBaseStoredSettings({
      defaultAgent: 'codex',
      permissionMode: 'auto',
      useWorktree: true,
    })).toEqual({
      defaultAgent: 'codex',
      permissionMode: 'auto',
      useWorktree: true,
    });

    expect(() => parseMuxBaseStoredSettings({ defaultAgent: 'unknown-agent' }))
      .toThrow('defaultAgent');
    expect(parseMuxBaseStoredSettings({
      futureSetting: { enabled: true },
      useWorktree: true,
    })).toEqual({
      futureSetting: { enabled: true },
      useWorktree: true,
    });
  });

  it('preserves unknown config metadata when applying validated defaults', () => {
    expect(parseMuxBaseConfig({
      futureTopLevel: { version: 2 },
      panes: [VALID_PANE],
    })).toMatchObject({
      futureTopLevel: { version: 2 },
      panes: [VALID_PANE],
    });
  });
});
