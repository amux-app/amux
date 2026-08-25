import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { getMacOSReleaseEnvironmentError } from './macos-release-env.mjs';

const checker = resolve(process.cwd(), 'scripts/check-macos-release-env.mjs');

function checkReleaseEnvironment(environment) {
  return spawnSync(process.execPath, [checker], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, ...environment },
  });
}

describe('macOS release environment preflight', () => {
  it('accepts the Electron Builder signing identity with direct notarization credentials', () => {
    const error = getMacOSReleaseEnvironmentError({
      APPLE_APP_SPECIFIC_PASSWORD: 'password',
      APPLE_ID: 'release@example.com',
      APPLE_TEAM_ID: 'TEAMID',
      CSC_NAME: 'MuxBase release identity',
    }, 'darwin');

    expect(error).toBeNull();
  });

  it('does not accept a signing variable that Electron Builder ignores', () => {
    const error = getMacOSReleaseEnvironmentError({
      APPLE_NOTARY_PROFILE: 'muxbase-notary',
      APPLE_SIGN_IDENTITY: 'MuxBase release identity',
    }, 'darwin');

    expect(error).toContain('CSC_NAME');
  });

  it('rejects macOS packaging on other platforms even when credentials are present', () => {
    const error = getMacOSReleaseEnvironmentError({
      APPLE_NOTARY_PROFILE: 'muxbase-notary',
      CSC_NAME: 'MuxBase release identity',
    }, 'linux');

    expect(error).toBe('macOS release packaging must run on macOS.');
  });

  it('runs the command-line preflight against the actual host platform', () => {
    const result = checkReleaseEnvironment({
      APPLE_NOTARY_PROFILE: 'muxbase-notary',
      CSC_NAME: 'MuxBase release identity',
    });

    expect(result.status).toBe(process.platform === 'darwin' ? 0 : 1);
    if (process.platform !== 'darwin') {
      expect(result.stderr).toContain('macOS release packaging must run on macOS.');
    }
  });
});
