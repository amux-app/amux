import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const fakeHome = mkdtempSync(join(tmpdir(), 'aumx-pi-activity-home-'));

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: () => fakeHome };
});

const {
  ensurePiActivityExtension,
  piActivityExtensionPath,
  removePiActivityExtension,
} = await import('../../src/utils/piActivityRegistry');

afterAll(() => rmSync(fakeHome, { force: true, recursive: true }));
beforeEach(() => rmSync(join(fakeHome, '.pi'), { force: true, recursive: true }));

describe('ensurePiActivityExtension', () => {
  it('installs a global extension that uses agent_settled as the idle edge', () => {
    const extensionPath = ensurePiActivityExtension();

    expect(extensionPath).toBe(piActivityExtensionPath());
    expect(existsSync(extensionPath as string)).toBe(true);
    const extension = readFileSync(extensionPath as string, 'utf8');
    expect(extension).toContain('agent_start');
    expect(extension).toContain('agent_settled');
    expect(extension).not.toContain('agent_end');
    expect(extension).toContain('AUMX_ACTIVITY_JOURNAL');
    expect(extension).toContain('AUMX_ACTIVITY_ADAPTER');
    expect(extension).toContain('existsSync');
    expect(extension).toContain('randomUUID');
    expect(extension).not.toContain('turnNumber');
  });

  it('fails closed instead of replacing a user-owned extension at the reserved path', () => {
    const extensionPath = piActivityExtensionPath();
    mkdirSync(join(fakeHome, '.pi', 'agent', 'extensions'), { recursive: true });
    writeFileSync(extensionPath, 'export default function userExtension() {}\n');

    expect(ensurePiActivityExtension()).toBeNull();
    expect(readFileSync(extensionPath, 'utf8')).toBe('export default function userExtension() {}\n');
  });

  it('removes only its owned extension and revokes the writer-side consent gate', () => {
    const extensionPath = ensurePiActivityExtension();
    const consentPath = join(fakeHome, '.pi', 'agent', 'aumx-activity.enabled');
    expect(existsSync(consentPath)).toBe(true);

    expect(removePiActivityExtension()).toBe(true);
    expect(existsSync(extensionPath as string)).toBe(false);
    expect(existsSync(consentPath)).toBe(false);
  });
});
