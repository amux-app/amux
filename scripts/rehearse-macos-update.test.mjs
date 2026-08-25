import { describe, expect, it } from 'vitest';
import {
  validateArchitecturePair,
  validateUpdateRehearsalRecord,
} from './rehearse-macos-update.mjs';

const sha256 = 'a'.repeat(64);

function record(architecture) {
  return {
    appPath: architecture === 'arm64' ? '/Applications/MuxBase Beta.app' : '/Users/test/Applications/MuxBase Beta.app',
    architecture,
    channel: 'beta',
    completedAt: '2026-08-07T12:30:00.000Z',
    fromVersion: '0.1.0-beta.1',
    metadataSha256: sha256,
    proofs: {
      afterRestartVersionMatches: true,
      applicationsGateCleared: true,
      backgroundDownloadVisible: true,
      dirtyRestartGuardPassed: true,
      laterKeptUpdateReady: true,
      noCheckOutsideApplications: true,
      normalRelaunchPassed: true,
      signaturePassed: true,
      staplingPassed: true,
      wrongLocationNoticeVisible: true,
    },
    repository: 'muxbase-app/muxbase',
    screenshots: ['wrong-location', 'ready', 'after-restart'].map((kind) => ({
      kind,
      path: `/tmp/${architecture}-${kind}.png`,
      sha256,
    })),
    soak: {
      completedAt: '2026-08-10T12:30:01.000Z',
      releaseBlockingDefects: 0,
      startedAt: '2026-08-07T12:30:00.000Z',
    },
    startedAt: '2026-08-07T12:00:00.000Z',
    toVersion: '0.1.0-beta.2',
    schemaVersion: 1,
  };
}

describe('macOS update rehearsal evidence', () => {
  it('accepts matching beta evidence for both architectures and a completed soak', () => {
    expect(validateArchitecturePair([record('arm64'), record('x64')], { requireSoak: true })).toEqual([]);
  });

  it('rejects incomplete, non-upgrade, and single-architecture evidence', () => {
    const invalid = record('arm64');
    invalid.toVersion = invalid.fromVersion;
    invalid.proofs.noCheckOutsideApplications = false;

    expect(validateUpdateRehearsalRecord(invalid)).toEqual(expect.arrayContaining([
      'toVersion must be newer than fromVersion.',
      'proofs.noCheckOutsideApplications must be true.',
    ]));
    expect(validateArchitecturePair([invalid])).toContain('Exactly two rehearsal records are required.');
  });

  it('rejects a prerelease record presented as stable-path proof', () => {
    const invalid = { ...record('arm64'), channel: 'stable' };
    expect(validateUpdateRehearsalRecord(invalid)).toContain(
      'stable evidence cannot use prerelease versions.',
    );
  });
});
