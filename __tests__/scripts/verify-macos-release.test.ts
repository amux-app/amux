import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  validateMachOArchitectures,
  validateReleaseMetadata,
} from '../../scripts/verify-macos-release.mjs';

let releaseDir: string;
const version = '0.1.0';

function seedRelease(): void {
  mkdirSync(releaseDir, { recursive: true });
  const entries: Array<{ sha512: string; size: number; url: string }> = [];
  for (const arch of ['arm64', 'x64']) {
    const payload = Buffer.from(arch);
    writeFileSync(join(releaseDir, `MuxBase-${version}-${arch}.dmg`), arch);
    writeFileSync(join(releaseDir, `MuxBase-${version}-${arch}.zip`), payload);
    entries.push({
      sha512: createHash('sha512').update(payload).digest('base64'),
      size: payload.length,
      url: `MuxBase-${version}-${arch}.zip`,
    });
  }
  writeFileSync(join(releaseDir, 'SHA256SUMS'), 'checksums');
  writeFileSync(join(releaseDir, 'muxbase-sbom.cdx.json'), '{}');
  writeFileSync(
    join(releaseDir, 'latest-mac.yml'),
    [
      `version: ${version}`,
      'files:',
      ...entries.flatMap((entry) => [
        `  - url: ${entry.url}`,
        `    sha512: ${entry.sha512}`,
        `    size: ${entry.size}`,
      ]),
      `path: ${entries[0].url}`,
      `sha512: ${entries[0].sha512}`,
    ].join('\n'),
  );
}

describe('macOS release metadata verification', () => {
  beforeEach(() => {
    releaseDir = mkdtempSync(join(tmpdir(), 'muxbase-release-metadata-'));
    seedRelease();
  });

  afterEach(() => {
    rmSync(releaseDir, { force: true, recursive: true });
  });

  it('requires updater-addressable artifacts for both architectures', () => {
    expect(validateReleaseMetadata(releaseDir, version)).toEqual([
      {
        arch: 'arm64',
        dmgPath: join(releaseDir, `MuxBase-${version}-arm64.dmg`),
        zipPath: join(releaseDir, `MuxBase-${version}-arm64.zip`),
      },
      {
        arch: 'x64',
        dmgPath: join(releaseDir, `MuxBase-${version}-x64.dmg`),
        zipPath: join(releaseDir, `MuxBase-${version}-x64.zip`),
      },
    ]);
  });

  it('fails when one architecture is absent from updater metadata', () => {
    writeFileSync(
      join(releaseDir, 'latest-mac.yml'),
      `version: ${version}\nfiles:\n  - url: MuxBase-${version}-arm64.zip\n`,
    );

    expect(() => validateReleaseMetadata(releaseDir, version)).toThrow(
      'Updater metadata must contain exactly 2 ZIP entries',
    );
  });

  it('fails when an expected signed artifact is missing', () => {
    rmSync(join(releaseDir, `MuxBase-${version}-x64.dmg`));

    expect(() => validateReleaseMetadata(releaseDir, version)).toThrow('Missing release artifact');
  });

  it('fails when the release SBOM is missing', () => {
    rmSync(join(releaseDir, 'muxbase-sbom.cdx.json'));

    expect(() => validateReleaseMetadata(releaseDir, version)).toThrow('Missing release artifact');
  });

  it('requires each packaged native binary to support its declared architecture', () => {
    expect(() => validateMachOArchitectures('arm64 x86_64', 'arm64', 'native module'))
      .not.toThrow();
    expect(() => validateMachOArchitectures('arm64 x86_64', 'x64', 'native module'))
      .not.toThrow();
    expect(() => validateMachOArchitectures('arm64', 'x64', 'native module'))
      .toThrow('native module is not compatible with x64');
  });
});
