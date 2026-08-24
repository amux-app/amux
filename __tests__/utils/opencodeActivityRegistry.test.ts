import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const fakeHome = mkdtempSync(join(tmpdir(), 'aumx-opencode-activity-home-'));

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: () => fakeHome };
});

const {
  ensureOpenCodeActivityPlugin,
  openCodeActivityPluginPath,
  removeOpenCodeActivityPlugin,
} = await import('../../src/utils/opencodeActivityRegistry');

afterAll(() => rmSync(fakeHome, { force: true, recursive: true }));
beforeEach(() => rmSync(join(fakeHome, '.config'), { force: true, recursive: true }));

describe('ensureOpenCodeActivityPlugin', () => {
  it('installs a global local plugin that records only normalised lifecycle metadata', () => {
    const pluginPath = ensureOpenCodeActivityPlugin();

    expect(pluginPath).toBe(openCodeActivityPluginPath());
    expect(existsSync(pluginPath as string)).toBe(true);
    const plugin = readFileSync(pluginPath as string, 'utf8');
    expect(plugin).toContain('session.status');
    expect(plugin).toContain('permission.asked');
    expect(plugin).toContain('session.error');
    expect(plugin).toContain('turn_failure_candidate');
    expect(plugin).toContain('AUMX_ACTIVITY_JOURNAL');
    expect(plugin).toContain('activeTurnIds');
    expect(plugin).toContain('AUMX_ACTIVITY_ADAPTER');
    expect(plugin).toContain('existsSync');
    expect(plugin).toContain('randomUUID()');
    expect(plugin).not.toContain('prompt');
    expect(plugin).not.toContain('tool_input');
  });

  it('fails closed instead of replacing a user-owned plugin at the reserved path', () => {
    const pluginPath = openCodeActivityPluginPath();
    mkdirSync(join(fakeHome, '.config', 'opencode', 'plugins'), { recursive: true });
    writeFileSync(pluginPath, 'export const userPlugin = true;\n');

    expect(ensureOpenCodeActivityPlugin()).toBeNull();
    expect(readFileSync(pluginPath, 'utf8')).toBe('export const userPlugin = true;\n');
  });

  it('removes only its owned plugin and revokes the writer-side consent gate', () => {
    const pluginPath = ensureOpenCodeActivityPlugin();
    const consentPath = join(fakeHome, '.config', 'opencode', 'aumx-activity.enabled');
    expect(existsSync(consentPath)).toBe(true);

    expect(removeOpenCodeActivityPlugin()).toBe(true);
    expect(existsSync(pluginPath as string)).toBe(false);
    expect(existsSync(consentPath)).toBe(false);
  });
});
