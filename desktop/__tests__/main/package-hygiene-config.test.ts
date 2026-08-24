import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const DESKTOP_ROOT = resolve(__dirname, '..', '..');

describe('packaged app hygiene', () => {
  it('excludes only measured development artifacts while preserving package entrypoints', () => {
    const config = readFileSync(resolve(DESKTOP_ROOT, 'electron-builder.yml'), 'utf8');

    expect(config).toContain('"!**/*.map"');
    expect(config).toContain('"!node_modules/minisearch/src/**/*"');
    expect(config).toContain('"!node_modules/zod/src/**/*"');
    expect(config).toContain('"!node_modules/node-pty/src/**/*"');
    expect(config).toContain('"!node_modules/node-pty/prebuilds/**/*"');
    expect(config).not.toContain('"!**/src/**/*"');
  });

  it('verifies actual archive contents after packaged smoke builds', () => {
    const packageJson = JSON.parse(
      readFileSync(resolve(DESKTOP_ROOT, 'package.json'), 'utf8'),
    ) as { scripts: Record<string, string> };

    expect(packageJson.scripts['package:smoke']).toContain('verify-package-contents.mjs');
  });

  it('cleans stale release artifacts before packaged smoke builds', () => {
    const packageJson = JSON.parse(
      readFileSync(resolve(DESKTOP_ROOT, 'package.json'), 'utf8'),
    ) as { scripts: Record<string, string> };

    expect(packageJson.scripts['package:smoke']).toMatch(
      /^node \.\.\/scripts\/clean-desktop-release\.mjs && electron-builder /,
    );
  });
});
