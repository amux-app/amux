import { describe, it, expect } from 'vitest';
import type { AumxPane } from 'aumx/core';
import {
  PANE_ATTENTION_PHRASES,
  getEffectivePaneStatus,
  getPaneAttention,
  type PaneAttentionReason,
  type PaneAttentionSession,
} from '../src/renderer/lib/pane-attention';
import { makeActivity } from './helpers/pane-activity-fixtures';

const PANE_ID = 'p1';

function makePane(overrides: Partial<AumxPane> = {}): AumxPane {
  return {
    id: PANE_ID,
    slug: 'test-pane',
    prompt: 'do something',
    paneId: '%1',
    ...overrides,
  };
}

const NO_FINISHED = new Set<string>();
const FINISHED = new Set<string>([PANE_ID]);

describe('getEffectivePaneStatus', () => {
  it('returns unknown when no activity snapshot exists', () => {
    const status = getEffectivePaneStatus(
      makePane({ agentStatus: 'working' }),
      { isOngoing: false, turnCompleted: true },
    );

    expect(status).toBe('unknown');
  });

  it('does not infer a live state from an ongoing session alone', () => {
    const status = getEffectivePaneStatus(
      makePane({ agentStatus: 'idle' }),
      { isOngoing: true, turnCompleted: false },
    );

    expect(status).toBe('unknown');
  });

  it('exposes awaiting input when activity is not available yet', () => {
    const status = getEffectivePaneStatus(
      makePane({ agentStatus: 'idle' }),
      { awaitingUserInput: true },
    );

    expect(status).toBe('waiting');
  });

  it('prefers runtime activity over a stale legacy agentStatus', () => {
    const status = getEffectivePaneStatus(
      makePane({ agentStatus: 'waiting' }),
      undefined,
      makeActivity({ state: 'idle' }),
    );

    expect(status).toBe('idle');
  });

  it('preserves the stopped activity state', () => {
    const status = getEffectivePaneStatus(
      makePane({ agentStatus: 'working' }),
      undefined,
      makeActivity({ state: 'stopped' }),
    );

    expect(status).toBe('stopped');
  });

  it('preserves unknown activity instead of consulting stale pane metadata', () => {
    const status = getEffectivePaneStatus(
      makePane({ agentStatus: 'waiting' }),
      undefined,
      makeActivity({ state: 'unknown' }),
    );

    expect(status).toBe('unknown');
  });

  it('does not fall back to persisted activity metadata', () => {
    const status = getEffectivePaneStatus(
      makePane({ agentStatus: 'working' }),
      undefined,
      undefined,
    );

    expect(status).toBe('unknown');
  });

  it('lets runtime activity win over a stale session waiting flag', () => {
    const status = getEffectivePaneStatus(
      makePane({ agentStatus: 'idle' }),
      { awaitingUserInput: true },
      makeActivity({ state: 'working' }),
    );

    expect(status).toBe('working');
  });
});

describe('getPaneAttention', () => {
  describe('waiting reason precedence', () => {
    const cases: Array<{
      name: string;
      pane: Partial<AumxPane>;
      session: PaneAttentionSession;
      reason: PaneAttentionReason;
    }> = [
      {
        name: 'session-input beats session-question',
        pane: { agentStatus: 'idle' },
        session: { awaitingUserInput: true, pendingUserQuestion: 'Which file?' },
        reason: 'session-input',
      },
      {
        name: 'session-question is the last waiting signal',
        pane: { agentStatus: 'idle' },
        session: { pendingUserQuestion: 'Which file?' },
        reason: 'session-question',
      },
    ];

    for (const testCase of cases) {
      it(testCase.name, () => {
        const attention = getPaneAttention(makePane(testCase.pane), testCase.session, NO_FINISHED);
        expect(attention).toEqual({ paneId: PANE_ID, kind: 'waiting', reason: testCase.reason });
      });
    }
  });

  it('waiting wins over ready', () => {
    const attention = getPaneAttention(
      makePane({ agentStatus: 'waiting' }),
      undefined,
      FINISHED,
    );
    expect(attention).toEqual({ paneId: PANE_ID, kind: 'ready', reason: 'just-finished' });
  });

  it('treats an empty pendingUserQuestion as absent', () => {
    const attention = getPaneAttention(
      makePane({ agentStatus: 'idle' }),
      { pendingUserQuestion: '' },
      NO_FINISHED,
    );
    expect(attention).toBeNull();
  });

  it('ignores pendingUserQuestion while the activity state is working', () => {
    const attention = getPaneAttention(
      makePane({ agentStatus: 'working' }),
      { pendingUserQuestion: 'Pick one' },
      NO_FINISHED,
      makeActivity({ state: 'working' }),
    );
    expect(attention).toBeNull();
  });

  it('ignores pendingUserQuestion while the activity state is starting', () => {
    const attention = getPaneAttention(
      makePane({ agentStatus: 'waiting' }),
      { pendingUserQuestion: 'Which file?' },
      NO_FINISHED,
      makeActivity({ state: 'starting' }),
    );
    expect(attention).toBeNull();
  });

  it('waits on awaitingUserInput even while the agent is working', () => {
    const attention = getPaneAttention(
      makePane({ agentStatus: 'working' }),
      { awaitingUserInput: true },
      NO_FINISHED,
    );
    expect(attention).toEqual({ paneId: PANE_ID, kind: 'waiting', reason: 'session-input' });
  });

  it('does not revive waiting from stale pane metadata', () => {
    const attention = getPaneAttention(
      makePane({ agentStatus: 'waiting' }),
      { turnCompleted: true },
      NO_FINISHED,
    );
    expect(attention).toBeNull();
  });

  it('reports ready for a just-finished pane', () => {
    const attention = getPaneAttention(
      makePane({ agentStatus: 'idle' }),
      { turnCompleted: true },
      FINISHED,
    );
    expect(attention).toEqual({ paneId: PANE_ID, kind: 'ready', reason: 'just-finished' });
  });

  it('reports no attention for an idle pane that is not just-finished', () => {
    const attention = getPaneAttention(makePane({ agentStatus: 'idle' }), undefined, NO_FINISHED);
    expect(attention).toBeNull();
  });

  it('uses runtime activity, not a stale waiting agentStatus, to decide attention', () => {
    const attention = getPaneAttention(
      makePane({ agentStatus: 'waiting' }),
      undefined,
      NO_FINISHED,
      makeActivity({ state: 'idle' }),
    );
    expect(attention).toBeNull();
  });
});

describe('PANE_ATTENTION_PHRASES', () => {
  const expectedPhrases: Record<PaneAttentionReason, string> = {
    'just-finished': 'finished',
    'session-input': 'needs input',
    'session-question': 'asked a question',
  };

  for (const [reason, phrase] of Object.entries(expectedPhrases)) {
    it(`maps ${reason} to "${phrase}"`, () => {
      expect(PANE_ATTENTION_PHRASES[reason as PaneAttentionReason]).toBe(phrase);
    });
  }

  it('maps every reason exactly once', () => {
    expect(Object.keys(PANE_ATTENTION_PHRASES).sort()).toEqual(
      Object.keys(expectedPhrases).sort(),
    );
  });
});
