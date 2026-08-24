// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// `editorDetection` reads from `node:child_process` and `node:fs` at call time.
// Mock both so the test runs deterministically regardless of what's actually
// installed on the host.
const execFileSyncMock = vi.fn<[string, string[]?, object?], string>();
const existsSyncMock = vi.fn<[string], boolean>();

vi.mock('node:child_process', () => ({
  execFileSync: (file: string, args?: string[], opts?: object) => execFileSyncMock(file, args, opts),
}));
vi.mock('node:fs', () => ({
  existsSync: (path: string) => existsSyncMock(path),
}));

async function loadModule() {
  // Fresh import per test so vi.mock state isn't cached.
  vi.resetModules();
  return await import('../../src/main/services/editorDetection.js');
}

beforeEach(() => {
  execFileSyncMock.mockReset();
  existsSyncMock.mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
  delete process.env.EDITOR;
});

describe('detectAvailableEditors', () => {
  it('returns only the fallback when nothing is installed', async () => {
    // Neutralize a host-inherited $EDITOR so the fallback stays `code`.
    vi.stubEnv('EDITOR', '');
    execFileSyncMock.mockImplementation(() => {
      // `command -v` exits non-zero when binary isn't on PATH.
      throw new Error('not found');
    });
    existsSyncMock.mockReturnValue(false);

    const { detectAvailableEditors } = await loadModule();
    const editors = detectAvailableEditors();

    expect(editors).toEqual([
      { id: 'system', label: 'System default', command: 'code', source: 'fallback' },
    ]);
  });

  it('includes VS Code when `code` is on PATH', async () => {
    execFileSyncMock.mockImplementation((_file, args) => {
      const cmd = (args ?? [])[1] ?? '';
      if (cmd.includes('"code"')) return '/usr/local/bin/code\n';
      throw new Error('not found');
    });
    existsSyncMock.mockImplementation((p: string) => p === '/usr/local/bin/code');

    const { detectAvailableEditors } = await loadModule();
    const editors = detectAvailableEditors();

    expect(editors.find((e) => e.id === 'vscode')).toMatchObject({
      label: 'VS Code',
      command: '/usr/local/bin/code',
      source: 'path',
    });
    // System fallback is always last.
    expect(editors[editors.length - 1].id).toBe('system');
  });

  it('falls back to .app bundle when CLI is missing but the app is installed', async () => {
    execFileSyncMock.mockImplementation(() => {
      throw new Error('not found');
    });
    // Cursor is installed in /Applications but no `cursor` CLI is on PATH.
    existsSyncMock.mockImplementation((p: string) => {
      return p === '/Applications/Cursor.app/Contents/Resources/app/bin/cursor';
    });

    const { detectAvailableEditors } = await loadModule();
    const editors = detectAvailableEditors();
    const cursor = editors.find((e) => e.id === 'cursor');

    expect(cursor).toMatchObject({
      label: 'Cursor',
      command: '/Applications/Cursor.app/Contents/Resources/app/bin/cursor',
      source: 'app',
    });
  });

  it('exposes $EDITOR as a separate entry when it is not already a known editor', async () => {
    process.env.EDITOR = 'nano';
    execFileSyncMock.mockImplementation(() => { throw new Error('not found'); });
    existsSyncMock.mockReturnValue(false);

    const { detectAvailableEditors } = await loadModule();
    const editors = detectAvailableEditors();

    const envEntry = editors.find((e) => e.id === 'env');
    expect(envEntry).toMatchObject({
      command: 'nano',
      source: 'env',
    });
    expect(envEntry?.label).toContain('nano');

    // System fallback now uses $EDITOR.
    const fallback = editors.find((e) => e.id === 'system');
    expect(fallback?.command).toBe('nano');
  });

  it('does not duplicate $EDITOR when it points at an already-detected CLI', async () => {
    process.env.EDITOR = 'code';
    execFileSyncMock.mockImplementation((_file, args) => {
      const cmd = (args ?? [])[1] ?? '';
      if (cmd.includes('"code"')) return '/usr/local/bin/code\n';
      throw new Error('not found');
    });
    existsSyncMock.mockImplementation((p: string) => p === '/usr/local/bin/code');

    const { detectAvailableEditors } = await loadModule();
    const editors = detectAvailableEditors();

    expect(editors.filter((e) => e.id === 'vscode')).toHaveLength(1);
    expect(editors.filter((e) => e.id === 'env')).toHaveLength(0);
  });
});

describe('resolveEditorById', () => {
  it('resolves a detected id to that editor descriptor', async () => {
    // Arrange
    execFileSyncMock.mockImplementation((_file, args) => {
      const cmd = (args ?? [])[1] ?? '';
      if (cmd.includes('"code"')) return '/usr/local/bin/code\n';
      throw new Error('not found');
    });
    existsSyncMock.mockImplementation((p: string) => p === '/usr/local/bin/code');
    const { resolveEditorById } = await loadModule();

    // Act
    const resolved = resolveEditorById('vscode');

    // Assert
    expect(resolved).toMatchObject({ id: 'vscode', command: '/usr/local/bin/code', source: 'path' });
  });

  it('falls back to the system descriptor for an unknown id (never an arbitrary binary)', async () => {
    // Arrange
    execFileSyncMock.mockImplementation(() => { throw new Error('not found'); });
    existsSyncMock.mockReturnValue(false);
    const { resolveEditorById } = await loadModule();

    // Act
    const resolved = resolveEditorById('/usr/bin/evil --exec');

    // Assert
    expect(resolved).toEqual({ id: 'system', label: 'System default', command: 'code', source: 'fallback' });
  });

  it('falls back to the system descriptor when no id is supplied', async () => {
    // Arrange
    execFileSyncMock.mockImplementation(() => { throw new Error('not found'); });
    existsSyncMock.mockReturnValue(false);
    const { resolveEditorById } = await loadModule();

    // Act
    const resolved = resolveEditorById();

    // Assert
    expect(resolved.id).toBe('system');
  });
});
