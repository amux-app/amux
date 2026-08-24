import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

describe('macOS update packaging contract', () => {
  it('requires signing, macOS 13, stable updater metadata, and an Applications DMG link', () => {
    const config = parse(readFileSync(resolve(__dirname, '../../electron-builder.yml'), 'utf8'));
    const packageJson = JSON.parse(readFileSync(resolve(__dirname, '../../package.json'), 'utf8'));

    expect(config.forceCodeSigning).toBe(true);
    expect(packageJson.scripts['dist:release']).toContain('AUMX_REQUIRE_NOTARIZATION=1');
    expect(config.electronUpdaterCompatibility).toBe('>=6.8.9');
    expect(config.detectUpdateChannel).toBe(false);
    expect(config.mac.minimumSystemVersion).toBe('13.0');
    expect(config.publish).toMatchObject({
      channel: 'latest',
      owner: 'amux-app',
      provider: 'github',
      repo: 'amux',
    });
    expect(config.dmg.contents).toContainEqual(expect.objectContaining({
      path: '/Applications',
      type: 'link',
    }));
    expect(config.dmg.writeUpdateInfo).toBe(false);
  });
});
