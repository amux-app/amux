import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveAuthorizedFileRoot, validateFilePath } from '../../src/main/utils/file-root-authorization';

describe('file root authorization', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots) {
      rmSync(root, { recursive: true, force: true });
    }
    roots.length = 0;
  });

  it('allows the active project root and pane worktree roots', () => {
    const projectRoot = '/workspace/app';
    const panes = [
      { projectRoot, worktreePath: '/workspace/app-worktrees/task-a' },
    ];

    expect(resolveAuthorizedFileRoot(projectRoot, panes, projectRoot)).toBe(projectRoot);
    expect(resolveAuthorizedFileRoot(projectRoot, panes, '/workspace/app-worktrees/task-a')).toBe('/workspace/app-worktrees/task-a');
  });

  it('rejects renderer supplied roots outside the active workspace set', () => {
    expect(() => resolveAuthorizedFileRoot('/workspace/app', [], '/')).toThrow('Unauthorized file root');
  });

  it('keeps relative file operations inside the authorized root', () => {
    expect(validateFilePath('/workspace/app', 'src/index.ts')).toBe('/workspace/app/src/index.ts');
    expect(() => validateFilePath('/workspace/app', '../secrets.txt')).toThrow('Path traversal blocked');
  });

  it('handles filesystem root containment without blocking valid descendants', () => {
    expect(validateFilePath('/', 'tmp/example.txt')).toBe('/tmp/example.txt');
  });

  it('compares authorized roots by their canonical filesystem path', () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'aumx-file-root-'));
    roots.push(tempRoot);
    const realProjectRoot = join(tempRoot, 'real-project');
    const linkedProjectRoot = join(tempRoot, 'linked-project');
    mkdirSync(realProjectRoot);
    symlinkSync(realProjectRoot, linkedProjectRoot);

    expect(resolveAuthorizedFileRoot(linkedProjectRoot, [], realProjectRoot)).toBe(realpathSync(realProjectRoot));
    expect(resolveAuthorizedFileRoot(linkedProjectRoot, [], linkedProjectRoot)).toBe(realpathSync(realProjectRoot));
  });

  it('blocks symlinks inside the root that escape outside', () => {
    const tempRoot = realpathSync(mkdtempSync(join(tmpdir(), 'aumx-file-root-')));
    roots.push(tempRoot);
    const projectRoot = join(tempRoot, 'project');
    const outsideDir = join(tempRoot, 'outside');
    mkdirSync(projectRoot);
    mkdirSync(outsideDir);
    symlinkSync(outsideDir, join(projectRoot, 'escape'));

    expect(() => validateFilePath(projectRoot, 'escape/secret.txt')).toThrow('Path traversal blocked');
  });

  it('blocks creates whose parent chain traverses an escape symlink', () => {
    const tempRoot = realpathSync(mkdtempSync(join(tmpdir(), 'aumx-file-root-')));
    roots.push(tempRoot);
    const projectRoot = join(tempRoot, 'project');
    const outsideDir = join(tempRoot, 'outside');
    mkdirSync(projectRoot);
    mkdirSync(outsideDir);
    symlinkSync(outsideDir, join(projectRoot, 'escape'));

    expect(() => validateFilePath(projectRoot, 'escape/new/file.txt')).toThrow('Path traversal blocked');
  });
});
