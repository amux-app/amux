import { describe, expect, it } from 'vitest';
import {
  appUpdateSnapshotSchema,
  buildCanonicalReleaseNotesUrl,
  createInitialUpdateSnapshot,
  normalizeUpdateProgress,
} from '../../src/shared/app-update-types';

describe('app update contract', () => {
  it('creates a disabled development snapshot without updater implementation details', () => {
    const snapshot = createInitialUpdateSnapshot('0.1.0', 'development');

    expect(snapshot).toEqual({
      currentVersion: '0.1.0',
      disabledReason: 'development',
      phase: 'disabled',
      revision: 0,
    });
    expect(appUpdateSnapshotSchema.parse(snapshot)).toEqual(snapshot);
  });

  it('rejects state fields that are illegal for the current phase', () => {
    expect(() => appUpdateSnapshotSchema.parse({
      currentVersion: '0.1.0',
      disabledReason: 'not-in-applications',
      phase: 'ready',
      revision: 2,
    })).toThrow();

    expect(() => appUpdateSnapshotSchema.parse({
      availableVersion: '0.2.0',
      currentVersion: '0.1.0',
      phase: 'disabled',
      revision: 2,
    })).toThrow();

    expect(() => appUpdateSnapshotSchema.parse({
      availableVersion: '0.2.0',
      currentVersion: '0.1.0',
      phase: 'ready',
      releaseNotesUrl: 'https://evil.invalid/releases/tag/v0.2.0',
      revision: 2,
    })).toThrow();
  });

  it('accepts only finite non-negative transfer data and clamps update progress', () => {
    expect(normalizeUpdateProgress({
      bytesPerSecond: Number.POSITIVE_INFINITY,
      percent: 142.37,
      total: -10,
      transferred: 250,
    })).toEqual({
      bytesPerSecond: 0,
      percent: 100,
      total: 0,
      transferred: 0,
    });
  });

  it('builds release-note links only for validated stable semantic versions', () => {
    expect(buildCanonicalReleaseNotesUrl('0.2.0')).toBe(
      'https://github.com/amux-app/amux/releases/tag/v0.2.0',
    );
    expect(buildCanonicalReleaseNotesUrl('0.2.0-beta.1')).toBeNull();
    expect(buildCanonicalReleaseNotesUrl('not-a-version')).toBeNull();
    expect(buildCanonicalReleaseNotesUrl('0.2.0/../../issues')).toBeNull();
  });
});
