import { afterAll, describe, expect, it, vi } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const fakeHome = mkdtempSync(join(tmpdir(), 'aumx-codex-activity-home-'));

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: () => fakeHome };
});

const { ensureCodexActivityHookSettings, removeCodexActivityHookSettings } = await import('../../src/utils/codexActivityRegistry');

afterAll(() => rmSync(fakeHome, { force: true, recursive: true }));

describe('ensureCodexActivityHookSettings', () => {
  it('adds the recorder without replacing an existing user hook configuration', () => {
    const hooksPath = join(fakeHome, '.codex', 'hooks.json');
    const existing = {
      hooks: {
        UserPromptSubmit: [{ hooks: [{ command: 'existing-recorder', type: 'command' }] }],
      },
    };
    mkdirSync(join(fakeHome, '.codex'), { recursive: true });
    writeFileSync(hooksPath, JSON.stringify(existing));

    const result = ensureCodexActivityHookSettings();

    expect(result).toBe(hooksPath);
    const settings = JSON.parse(readFileSync(hooksPath, 'utf8'));
    const commands = settings.hooks.UserPromptSubmit.flatMap((group: { hooks: Array<{ command: string }> }) => group.hooks.map((hook) => hook.command));
    expect(commands).toContain('existing-recorder');
    expect(commands.some((command: string) => command.includes('record-codex-activity.cjs'))).toBe(true);
    expect(existsSync(commands.find((command: string) => command.includes('record-codex-activity.cjs')).replace(/^node ['"]?([^'"]+)['"]?$/, '$1'))).toBe(true);
    const amuxHandlers = settings.hooks.UserPromptSubmit
      .flatMap((group: { hooks: Array<{ async?: boolean; command: string }> }) => group.hooks)
      .filter((hook: { command: string }) => hook.command.includes('record-codex-activity.cjs'));
    expect(amuxHandlers).toHaveLength(1);
    expect(amuxHandlers[0]).toMatchObject({ type: 'command' });
    expect(amuxHandlers[0].async).toBeUndefined();
  });

  it('fails closed without modifying malformed hook settings', () => {
    const hooksPath = join(fakeHome, '.codex', 'hooks.json');
    writeFileSync(hooksPath, '{not-json');

    expect(ensureCodexActivityHookSettings()).toBeNull();
    expect(readFileSync(hooksPath, 'utf8')).toBe('{not-json');
  });

  it('removes only Amux-owned groups when consent is revoked', () => {
    const hooksPath = join(fakeHome, '.codex', 'hooks.json');
    writeFileSync(hooksPath, JSON.stringify({
      hooks: { Stop: [{ hooks: [{ command: 'existing-stop', type: 'command' }] }] },
    }));
    ensureCodexActivityHookSettings();

    expect(removeCodexActivityHookSettings()).toBe(true);
    const settings = JSON.parse(readFileSync(hooksPath, 'utf8'));
    expect(settings.hooks.Stop).toEqual([{ hooks: [{ command: 'existing-stop', type: 'command' }] }]);
    expect(settings.hooks.UserPromptSubmit).toBeUndefined();
  });
});

describe('unreadable hook configuration', () => {
  it('refuses to install rather than replacing hooks it could not read', () => {
    // Arrange
    const hooksPath = join(fakeHome, '.codex', 'hooks.json');
    const original = JSON.stringify({ hooks: { Stop: [{ hooks: [{ command: 'user-recorder', type: 'command' }] }] } });
    mkdirSync(join(fakeHome, '.codex'), { recursive: true });
    writeFileSync(hooksPath, original);
    chmodSync(hooksPath, 0o000);
    expect(() => readFileSync(hooksPath, 'utf8')).toThrow();

    // Act
    const result = ensureCodexActivityHookSettings();

    // Assert
    expect(result).toBeNull();
    chmodSync(hooksPath, 0o600);
    expect(readFileSync(hooksPath, 'utf8')).toBe(original);
    rmSync(hooksPath, { force: true });
  });
});
