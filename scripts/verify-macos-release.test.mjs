import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { validateReleaseMetadata } from './verify-macos-release.mjs';

const VERSION = '0.2.0';

function sha512Base64(content) {
  return createHash('sha512').update(content).digest('base64');
}

function createReleaseFixture(transformMetadata = (value) => value) {
  const releaseDir = mkdtempSync(join(tmpdir(), 'amux-release-metadata-'));
  const entries = ['arm64', 'x64'].map((arch) => {
    const zipName = `Amux-${VERSION}-${arch}.zip`;
    const zipContent = Buffer.from(`${arch} update payload`);
    writeFileSync(join(releaseDir, zipName), zipContent);
    writeFileSync(join(releaseDir, `Amux-${VERSION}-${arch}.dmg`), `${arch} installer`);
    return {
      sha512: sha512Base64(zipContent),
      size: zipContent.length,
      url: zipName,
    };
  });
  writeFileSync(join(releaseDir, 'SHA256SUMS'), 'fixture\n');
  writeFileSync(join(releaseDir, 'amux-sbom.cdx.json'), '{}\n');
  const metadata = transformMetadata({ files: entries, version: VERSION });
  const yaml = [
    `version: ${metadata.version}`,
    'files:',
    ...metadata.files.flatMap((entry) => [
      `  - url: ${entry.url}`,
      `    sha512: ${entry.sha512}`,
      `    size: ${entry.size}`,
    ]),
    `path: ${metadata.files[0]?.url ?? ''}`,
    `sha512: ${metadata.files[0]?.sha512 ?? ''}`,
  ].join('\n');
  writeFileSync(join(releaseDir, 'latest-mac.yml'), yaml);
  return releaseDir;
}

describe('validateReleaseMetadata', () => {
  it('parses and cryptographically verifies exactly one ZIP for each architecture', () => {
    const releaseDir = createReleaseFixture();

    expect(validateReleaseMetadata(releaseDir, VERSION)).toEqual([
      expect.objectContaining({ arch: 'arm64', zipPath: join(releaseDir, `Amux-${VERSION}-arm64.zip`) }),
      expect.objectContaining({ arch: 'x64', zipPath: join(releaseDir, `Amux-${VERSION}-x64.zip`) }),
    ]);
  });

  it.each([
    ['wrong version', (metadata) => ({ ...metadata, version: '0.3.0' })],
    ['wrong size', (metadata) => ({ ...metadata, files: metadata.files.map((entry, index) => index === 0 ? { ...entry, size: entry.size + 1 } : entry) })],
    ['wrong hash', (metadata) => ({ ...metadata, files: metadata.files.map((entry, index) => index === 0 ? { ...entry, sha512: 'invalid' } : entry) })],
    ['DMG updater URL', (metadata) => ({ ...metadata, files: metadata.files.map((entry, index) => index === 0 ? { ...entry, url: `Amux-${VERSION}-arm64.dmg` } : entry) })],
    ['duplicate architecture', (metadata) => ({ ...metadata, files: [metadata.files[0], metadata.files[0]] })],
  ])('rejects %s metadata', (_label, mutate) => {
    const releaseDir = createReleaseFixture(mutate);

    expect(() => validateReleaseMetadata(releaseDir, VERSION)).toThrow();
  });
});
