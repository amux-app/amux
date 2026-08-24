import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('child_process', () => ({
  execFile: vi.fn(),
}));

// clone/pull now run assertSafeCloneTarget, which resolves DNS — keep it offline and public.
vi.mock('dns/promises', () => ({
  lookup: vi.fn().mockResolvedValue([{ address: '140.82.112.3', family: 4 }]),
}));

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    existsSync: vi.fn(),
    mkdirSync: vi.fn(),
    renameSync: vi.fn(),
    rmSync: vi.fn(),
  };
});

import { execFile } from 'child_process';
import { existsSync, mkdirSync, renameSync, rmSync } from 'fs';
import { GitOperations } from '../../src/services/marketplace/GitOperations.js';

type GitCall = (cmd: string, args: string[], opts: unknown, cb: (err: Error | null, res?: { stdout: string; stderr: string }) => void) => void;

const asMock = (fn: unknown) => fn as unknown as ReturnType<typeof vi.fn>;

function routeGit(handlers: {
  clone?: () => Error | null;
  config?: string;
  revParse?: string;
}): void {
  asMock(execFile).mockImplementation(((cmd: string, args: string[], _opts: unknown, cb) => {
    const sub = args[0];
    if (sub === 'clone') {
      const err = handlers.clone ? handlers.clone() : null;
      return cb(err, err ? undefined : { stdout: '', stderr: '' });
    }
    if (sub === 'config') return cb(null, { stdout: `${handlers.config ?? ''}\n`, stderr: '' });
    if (sub === 'rev-parse') return cb(null, { stdout: `${handlers.revParse ?? ''}\n`, stderr: '' });
    return cb(null, { stdout: '', stderr: '' });
  }) as unknown as GitCall);
}

const cloneArgs = () =>
  asMock(execFile).mock.calls.find((c) => (c[1] as string[])[0] === 'clone');

describe('GitOperations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('clone', () => {
    it('clones into a temp path then renames atomically to the final path', async () => {
      // Arrange
      asMock(existsSync).mockReturnValue(false);
      routeGit({});

      // Act
      await new GitOperations().clone('https://github.com/example/repo.git', '/tmp/clones/repo');

      // Assert
      expect(mkdirSync).toHaveBeenCalledWith('/tmp/clones', { recursive: true });
      const call = cloneArgs()!;
      const tempTarget = (call[1] as string[])[4];
      expect(tempTarget).toMatch(/^\/tmp\/clones\/repo\.tmp-[0-9a-f]{12}$/);
      expect(renameSync).toHaveBeenCalledWith(tempTarget, '/tmp/clones/repo');
    });

    it('skips clone when the directory already exists', async () => {
      // Arrange
      asMock(existsSync).mockReturnValue(true);

      // Act
      await new GitOperations().clone('https://github.com/example/repo.git', '/tmp/clones/repo');

      // Assert
      expect(execFile).not.toHaveBeenCalled();
    });

    it('removes the temp dir and rethrows on clone failure without leaving a final dir', async () => {
      // Arrange
      asMock(existsSync).mockReturnValue(false);
      routeGit({ clone: () => new Error('network down') });

      // Act
      const promise = new GitOperations().clone('https://github.com/example/repo.git', '/tmp/clones/repo');

      // Assert
      await expect(promise).rejects.toThrow('network down');
      const tempTarget = (cloneArgs()![1] as string[])[4];
      expect(rmSync).toHaveBeenCalledWith(tempTarget, { recursive: true, force: true });
      expect(renameSync).not.toHaveBeenCalled();
    });
  });

  describe('ensureClone', () => {
    it('returns the HEAD sha without cloning when the existing origin matches', async () => {
      // Arrange
      asMock(existsSync).mockReturnValue(true);
      routeGit({ config: 'https://github.com/example/repo.git', revParse: 'abc123def456' });

      // Act
      const sha = await new GitOperations().ensureClone('https://github.com/example/repo', '/tmp/clones/repo');

      // Assert
      expect(sha).toBe('abc123def456');
      expect(cloneArgs()).toBeUndefined();
    });

    it('removes the stale dir and re-clones when the origin does not match', async () => {
      // Arrange
      asMock(existsSync).mockReturnValue(true);
      routeGit({ config: 'https://github.com/attacker/evil.git', revParse: 'newsha000000' });

      // Act
      const sha = await new GitOperations().ensureClone('https://github.com/example/repo', '/tmp/clones/repo');

      // Assert
      expect(rmSync).toHaveBeenCalledWith('/tmp/clones/repo', { recursive: true, force: true });
      expect(cloneArgs()).toBeDefined();
      expect(renameSync).toHaveBeenCalled();
      expect(sha).toBe('newsha000000');
    });
  });

  describe('clone race', () => {
    it('treats a rename ENOTEMPTY as a benign concurrent win when the existing origin matches', async () => {
      // Arrange: target does not exist at check time, a concurrent add wins the rename.
      asMock(existsSync).mockReturnValue(false);
      routeGit({ config: 'https://github.com/example/repo.git', revParse: 'winsha000000' });
      asMock(renameSync).mockImplementationOnce(() => {
        const err = new Error('rename failed') as NodeJS.ErrnoException;
        err.code = 'ENOTEMPTY';
        throw err;
      });

      // Act
      const sha = await new GitOperations().ensureClone('https://github.com/example/repo', '/tmp/clones/repo');

      // Assert: our temp is cleaned up and we return the existing clone's HEAD.
      const tempTarget = (cloneArgs()![1] as string[])[4];
      expect(rmSync).toHaveBeenCalledWith(tempTarget, { recursive: true, force: true });
      expect(sha).toBe('winsha000000');
    });

    it('rethrows a rename ENOTEMPTY when the existing origin does not match', async () => {
      // Arrange
      asMock(existsSync).mockReturnValue(false);
      routeGit({ config: 'https://github.com/attacker/evil.git' });
      asMock(renameSync).mockImplementationOnce(() => {
        const err = new Error('rename failed') as NodeJS.ErrnoException;
        err.code = 'ENOTEMPTY';
        throw err;
      });

      // Act / Assert
      await expect(
        new GitOperations().ensureClone('https://github.com/example/repo', '/tmp/clones/repo'),
      ).rejects.toThrow('rename failed');
    });
  });

  describe('getHeadSha', () => {
    it('returns the trimmed rev-parse output', async () => {
      // Arrange
      routeGit({ revParse: 'deadbeef1234' });

      // Act
      const sha = await new GitOperations().getHeadSha('/tmp/clones/repo');

      // Assert
      expect(sha).toBe('deadbeef1234');
    });
  });
});
