/**
 * Unit tests for openInEditorAction
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { openInEditor } from '../../src/actions/implementations/openInEditorAction.js';
import { createMockPane, createShellPane } from '../fixtures/mockPanes.js';
import { createMockContext } from '../fixtures/mockContext.js';
import { expectSuccess, expectError } from '../helpers/actionAssertions.js';
import { spawnSync } from 'child_process';

vi.mock('child_process', () => ({
  spawnSync: vi.fn(),
}));

describe('openInEditorAction', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('should open worktree in default editor (code)', async () => {
    delete process.env.EDITOR;
    delete process.env.VISUAL;
    const mockPane = createMockPane({
      worktreePath: '/test/worktree/path',
    });
    const mockContext = createMockContext([mockPane]);

    vi.mocked(spawnSync).mockReturnValue({ status: 0, stdout: Buffer.from(''), stderr: Buffer.from('') } as never);

    const result = await openInEditor(mockPane, mockContext);

    expect(spawnSync).toHaveBeenCalledWith(
      'code',
      ['/test/worktree/path'],
      { stdio: 'pipe', shell: false }
    );
    expectSuccess(result, 'code');
  });

  it('should use EDITOR environment variable when set', async () => {
    process.env.EDITOR = 'vim';
    const mockPane = createMockPane({
      worktreePath: '/test/path',
    });
    const mockContext = createMockContext([mockPane]);

    vi.mocked(spawnSync).mockReturnValue({ status: 0, stdout: Buffer.from(''), stderr: Buffer.from('') } as never);

    const result = await openInEditor(mockPane, mockContext);

    expect(spawnSync).toHaveBeenCalledWith(
      'vim',
      ['/test/path'],
      { stdio: 'pipe', shell: false }
    );
    expectSuccess(result, 'vim');
  });

  it('should use custom editor from params', async () => {
    const mockPane = createMockPane({
      worktreePath: '/test/path',
    });
    const mockContext = createMockContext([mockPane]);

    vi.mocked(spawnSync).mockReturnValue({ status: 0, stdout: Buffer.from(''), stderr: Buffer.from('') } as never);

    const result = await openInEditor(mockPane, mockContext, { editor: 'emacs' });

    expect(spawnSync).toHaveBeenCalledWith(
      'emacs',
      ['/test/path'],
      { stdio: 'pipe', shell: false }
    );
    expectSuccess(result, 'emacs');
  });

  it('should prioritize params editor over EDITOR env', async () => {
    process.env.EDITOR = 'vim';
    const mockPane = createMockPane({
      worktreePath: '/test/path',
    });
    const mockContext = createMockContext([mockPane]);

    vi.mocked(spawnSync).mockReturnValue({ status: 0, stdout: Buffer.from(''), stderr: Buffer.from('') } as never);

    await openInEditor(mockPane, mockContext, { editor: 'nano' });

    expect(spawnSync).toHaveBeenCalledWith(
      'nano',
      ['/test/path'],
      { stdio: 'pipe', shell: false }
    );
  });

  it('should return error for shell pane without worktree', async () => {
    const mockPane = createShellPane();
    const mockContext = createMockContext([mockPane]);

    const result = await openInEditor(mockPane, mockContext);

    expectError(result, 'no worktree');
  });

  it('should return error when editor command fails', async () => {
    const mockPane = createMockPane({
      worktreePath: '/test/path',
    });
    const mockContext = createMockContext([mockPane]);

    vi.mocked(spawnSync).mockReturnValue({
      status: 1,
      stdout: Buffer.from(''),
      stderr: Buffer.from('editor not found'),
    } as never);

    const result = await openInEditor(mockPane, mockContext);

    expectError(result, 'Failed to open');
  });

  it('should handle paths with spaces and special characters', async () => {
    delete process.env.EDITOR;
    delete process.env.VISUAL;
    const mockPane = createMockPane({
      worktreePath: '/test/path with spaces/worktree',
    });
    const mockContext = createMockContext([mockPane]);

    vi.mocked(spawnSync).mockReturnValue({ status: 0, stdout: Buffer.from(''), stderr: Buffer.from('') } as never);

    await openInEditor(mockPane, mockContext);

    // Verify path is properly quoted
    expect(spawnSync).toHaveBeenCalledWith(
      'code',
      ['/test/path with spaces/worktree'],
      { stdio: 'pipe', shell: false }
    );
  });

  it('should support various editor commands', async () => {
    const editors = ['nvim', 'subl', 'atom', 'idea', 'webstorm'];
    const mockPane = createMockPane({ worktreePath: '/test' });
    const mockContext = createMockContext([mockPane]);

    vi.mocked(spawnSync).mockReturnValue({ status: 0, stdout: Buffer.from(''), stderr: Buffer.from('') } as never);

    for (const editor of editors) {
      vi.clearAllMocks();
      await openInEditor(mockPane, mockContext, { editor });

      expect(spawnSync).toHaveBeenCalledWith(
        editor,
        ['/test'],
        { stdio: 'pipe', shell: false }
      );
    }
  });
});
