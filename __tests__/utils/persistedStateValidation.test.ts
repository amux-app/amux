import { describe, expect, it } from 'vitest';
import {
  parseAumxConfig,
  parseStoredAumxSettings,
} from '../../src/utils/persistedStateValidation.js';

const VALID_PANE = {
  id: 'pane-1',
  paneId: '%1',
  prompt: 'Implement authentication',
  slug: 'implement-authentication',
};

describe('persisted state validation', () => {
  it('accepts a valid legacy config and supplies safe missing defaults', () => {
    expect(parseAumxConfig({ panes: [VALID_PANE] })).toMatchObject({
      lastUpdated: '',
      panes: [VALID_PANE],
      projectName: '',
      projectRoot: '',
      settings: {},
    });
  });

  it('rejects config panes without the identity fields used by orchestration', () => {
    expect(() => parseAumxConfig({ panes: [{ id: 'pane-1' }] }))
      .toThrow('paneId');
  });

  it('rejects malformed nested config settings', () => {
    expect(() => parseAumxConfig({ panes: [], settings: { useWorktree: 'yes' } }))
      .toThrow('useWorktree');
  });

  it('rejects malformed optional pane metadata used by runtime services', () => {
    expect(() => parseAumxConfig({
      panes: [{ ...VALID_PANE, worktreePath: 42 }],
    })).toThrow('worktreePath');

    expect(() => parseAumxConfig({
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

    expect(() => parseAumxConfig({
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

    expect(parseAumxConfig({ panes: [{ ...VALID_PANE, conflictMerge }] }))
      .toMatchObject({ panes: [{ conflictMerge }] });
    expect(() => parseAumxConfig({
      panes: [{ ...VALID_PANE, conflictMerge: { ...conflictMerge, targetCommit: '' } }],
    })).toThrow('conflictMerge.targetCommit');
  });

  it('rejects invalid persisted control pane geometry', () => {
    expect(() => parseAumxConfig({ controlPaneSize: 0, panes: [] }))
      .toThrow('controlPaneSize');
  });

  it('accepts known settings, preserves unknown values, and rejects malformed known values', () => {
    expect(parseStoredAumxSettings({ defaultAgent: '' })).toEqual({ defaultAgent: '' });

    expect(parseStoredAumxSettings({
      defaultAgent: 'codex',
      permissionMode: 'auto',
      useWorktree: true,
    })).toEqual({
      defaultAgent: 'codex',
      permissionMode: 'auto',
      useWorktree: true,
    });

    expect(() => parseStoredAumxSettings({ defaultAgent: 'unknown-agent' }))
      .toThrow('defaultAgent');
    expect(parseStoredAumxSettings({
      futureSetting: { enabled: true },
      useWorktree: true,
    })).toEqual({
      futureSetting: { enabled: true },
      useWorktree: true,
    });
  });

  it('preserves unknown config metadata when applying validated defaults', () => {
    expect(parseAumxConfig({
      futureTopLevel: { version: 2 },
      panes: [VALID_PANE],
    })).toMatchObject({
      futureTopLevel: { version: 2 },
      panes: [VALID_PANE],
    });
  });
});
