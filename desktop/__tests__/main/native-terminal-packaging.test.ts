import { readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';

const testDir = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(testDir, '../..');

describe('native terminal packaging', () => {
  it('keeps node-pty external to the Electron main bundle', () => {
    const viteConfig = readFileSync(resolve(desktopRoot, 'electron.vite.config.ts'), 'utf-8');

    expect(viteConfig).toMatch(/external:\s*\[[^\]]*['"]node-pty['"][^\]]*\]/s);
  });

  it('rebuilds and unpacks native terminal modules for packaged apps', () => {
    const builderConfig = readFileSync(resolve(desktopRoot, 'electron-builder.yml'), 'utf-8');

    expect(builderConfig).toMatch(/^npmRebuild:\s*true$/m);
    expect(builderConfig).not.toContain('node_modules/node-pty/**/*');
    expect(builderConfig).toContain('node_modules/node-pty/build/Release/*.node');
    expect(builderConfig).toContain('node_modules/node-pty/build/Release/spawn-helper');
    expect(builderConfig).toContain('"!node_modules/node-pty/prebuilds/**/*"');
    expect(builderConfig).not.toContain('  - node_modules/node-pty/prebuilds/');
    expect(builderConfig).toMatch(/^asarUnpack:\s*\n(?:\s+- .+\n)*\s+- .*\*\.node/m);
  });
});
