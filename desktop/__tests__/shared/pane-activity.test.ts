import { describe, expect, it } from 'vitest';
import type { PaneActivity, VersionedActivity } from '../../src/shared/pane-activity';
import {
  captureReadinessToken,
  isBusyForKanban,
  revalidateReadiness,
  shouldConsumeLifecycleAdapterEvents,
} from '../../src/shared/pane-activity';
import { makeActivity } from '../helpers/pane-activity-fixtures';

function makeSnapshot(overrides: Partial<VersionedActivity> = {}, activityOverrides: Partial<PaneActivity> = {}): VersionedActivity {
  return {
    epochId: 'epoch-1',
    revision: 1,
    activity: makeActivity(activityOverrides),
    ...overrides,
  };
}

describe('captureReadinessToken', () => {
  it('captures pane identity and the target pane activity revision', () => {
    // Arrange
    const snapshot = makeSnapshot({}, { activityRevision: 7, paneIncarnationId: 'incarnation-9' });

    // Act
    const token = captureReadinessToken(snapshot);

    // Assert
    expect(token).toEqual({ activityRevision: 7, epochId: 'epoch-1', paneIncarnationId: 'incarnation-9' });
  });
});

describe('revalidateReadiness', () => {
  it('aborts when the target pane activity changed during the pending mutation', () => {
    // Arrange — the pane may have worked and returned to idle while the
    // action was gathering a snapshot; current readiness alone is insufficient.
    const token = captureReadinessToken(makeSnapshot({}, { activityRevision: 1 }));
    const current = makeSnapshot({}, { activityRevision: 5 });

    // Act
    const result = revalidateReadiness(token, current, undefined);

    // Assert
    expect(result).toEqual({ ok: false, reason: 'The pane activity changed while this action was preparing' });
  });

  it('aborts when the pane was recreated under a new incarnation, even though the new incarnation reads ready', () => {
    // Arrange
    const token = captureReadinessToken(makeSnapshot({}, { paneIncarnationId: 'incarnation-1' }));
    const current = makeSnapshot({}, { paneIncarnationId: 'incarnation-2' });

    // Act
    const result = revalidateReadiness(token, current, undefined);

    // Assert
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ reason: expect.stringMatching(/recreated/i) });
  });

  it('aborts when the activity epoch reset, even under the same paneIncarnationId', () => {
    // Arrange
    const token = captureReadinessToken(makeSnapshot({ epochId: 'epoch-1' }));
    const current = makeSnapshot({ epochId: 'epoch-2' });

    // Act
    const result = revalidateReadiness(token, current, undefined);

    // Assert
    expect(result.ok).toBe(false);
  });

  it('aborts when identity is unchanged but the caller-computed block reason says not ready', () => {
    // Arrange
    const token = captureReadinessToken(makeSnapshot());
    const current = makeSnapshot();

    // Act
    const result = revalidateReadiness(token, current, 'Wait until the source pane is idle before starting review');

    // Assert
    expect(result).toEqual({ ok: false, reason: 'Wait until the source pane is idle before starting review' });
  });

  it('skips the identity check and relies only on the block reason when no token was captured', () => {
    // Arrange — activity tracking was unavailable at capture time
    const current = makeSnapshot({}, { paneIncarnationId: 'incarnation-2' });

    // Act
    const readyResult = revalidateReadiness(undefined, current, undefined);
    const blockedResult = revalidateReadiness(undefined, current, 'busy');

    // Assert
    expect(readyResult).toEqual({ ok: true });
    expect(blockedResult).toEqual({ ok: false, reason: 'busy' });
  });

  it('aborts when a token was captured but the activity record vanished before revalidation', () => {
    // Arrange — activity tracking existed at capture time but is gone now (TOCTOU risk)
    const token = captureReadinessToken(makeSnapshot());

    // Act
    const result = revalidateReadiness(token, undefined, undefined);

    // Assert
    expect(result.ok).toBe(false);
  });
});

describe('isBusyForKanban', () => {
  it.each([
    ['unknown', false],
    ['idle', false],
    ['waiting', false],
    ['stopped', false],
    ['starting', true],
    ['working', true],
  ] as const)('maps %s to busy=%s without fabricating work', (state, expected) => {
    expect(isBusyForKanban(makeActivity({ state }))).toBe(expected);
  });
});

describe('shouldConsumeLifecycleAdapterEvents', () => {
  it('keeps the built-in Claude observer active but rejects opted-out third-party adapters', () => {
    expect(shouldConsumeLifecycleAdapterEvents('claude', false)).toBe(true);
    expect(shouldConsumeLifecycleAdapterEvents('codex', false)).toBe(false);
    expect(shouldConsumeLifecycleAdapterEvents('opencode', false)).toBe(false);
    expect(shouldConsumeLifecycleAdapterEvents('pi', false)).toBe(false);
    expect(shouldConsumeLifecycleAdapterEvents('codex', true)).toBe(true);
  });
});
