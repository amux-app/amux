import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readAppBuildInfo } from '../../src/main/services/AppBuildInfo';

describe('readAppBuildInfo', () => {
  it('reads local install build metadata from the packaged app package', () => {
    // Arrange
    const appPath = mkdtempSync(join(tmpdir(), 'muxbase-build-info-'));
    writeFileSync(
      join(appPath, 'package.json'),
      JSON.stringify({
        muxbaseBuild: {
          number: '20260517203045',
          version: '0.0.1.20260517203045',
        },
      }),
    );

    // Act
    const buildInfo = readAppBuildInfo(appPath, '0.0.1');

    // Assert
    expect(buildInfo).toEqual({
      buildNumber: '20260517203045',
      buildVersion: '0.0.1.20260517203045',
    });
  });

  it('normalizes electron-builder CLI numeric metadata to strings', () => {
    // Arrange
    const appPath = mkdtempSync(join(tmpdir(), 'muxbase-build-info-'));
    writeFileSync(
      join(appPath, 'package.json'),
      JSON.stringify({
        muxbaseBuild: {
          number: 20260517203045,
          version: '0.0.1.20260517203045',
        },
      }),
    );

    // Act
    const buildInfo = readAppBuildInfo(appPath, '0.0.1');

    // Assert
    expect(buildInfo).toEqual({
      buildNumber: '20260517203045',
      buildVersion: '0.0.1.20260517203045',
    });
  });

  it('falls back to the app version when build metadata is not stamped', () => {
    // Arrange
    const appPath = mkdtempSync(join(tmpdir(), 'muxbase-build-info-'));
    writeFileSync(join(appPath, 'package.json'), JSON.stringify({}));

    // Act
    const buildInfo = readAppBuildInfo(appPath, '0.0.1');

    // Assert
    expect(buildInfo).toEqual({
      buildVersion: '0.0.1',
    });
  });
});
