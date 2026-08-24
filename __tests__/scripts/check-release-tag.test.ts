import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const SCRIPT_SOURCE = readFileSync(resolve('scripts/check-release-tag.mjs'), 'utf8');
const fixtureRoots: string[] = [];

function createReleaseFixture(manifestVersion: string): string {
  const root = mkdtempSync(join(tmpdir(), 'amux-release-tag-'));
  fixtureRoots.push(root);
  mkdirSync(join(root, 'desktop'));
  mkdirSync(join(root, 'scripts'));
  writeFileSync(join(root, 'package.json'), '{"version":"1.2.3"}\n');
  writeFileSync(join(root, 'desktop/package.json'), '{"version":"1.2.3"}\n');
  writeFileSync(
    join(root, '.release-please-manifest.json'),
    `${JSON.stringify({ '.': manifestVersion })}\n`,
  );
  writeFileSync(join(root, 'scripts/check-release-tag.mjs'), SCRIPT_SOURCE);
  return root;
}

describe('check-release-tag', () => {
  afterEach(() => {
    for (const root of fixtureRoots.splice(0)) {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it('accepts a tag only when packages and the release manifest agree', () => {
    const root = createReleaseFixture('1.2.3');

    expect(() => execFileSync(
      process.execPath,
      [join(root, 'scripts/check-release-tag.mjs'), 'v1.2.3'],
      { encoding: 'utf8' },
    )).not.toThrow();
  });

  it('fails closed when the release manifest does not match the tag', () => {
    const root = createReleaseFixture('1.2.2');
    const result = spawnSync(
      process.execPath,
      [join(root, 'scripts/check-release-tag.mjs'), 'v1.2.3'],
      { encoding: 'utf8' },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('release manifest');
    expect(result.stderr).toContain('1.2.2');
  });
});
