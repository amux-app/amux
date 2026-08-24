import { mkdirSync, mkdtempSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  approveProjectRoot,
  authorizeProjectRoot,
} from '../../src/main/services/projectRootAuthorization';
import { normalizeRootPath } from '../../src/main/utils/file-root-authorization';

const ACTIVE_ROOT = mkdtempSync(path.join(tmpdir(), 'aumx-active-'));
const SECONDARY_ROOT = mkdtempSync(path.join(tmpdir(), 'aumx-secondary-'));
const WORKTREE_ROOT = mkdtempSync(path.join(tmpdir(), 'aumx-worktree-'));

describe('renderer project-root authorization', () => {
  it.each([
    ['active root', ACTIVE_ROOT, [{ projectRoot: ACTIVE_ROOT }], ACTIVE_ROOT],
    ['approved secondary project', SECONDARY_ROOT, [], SECONDARY_ROOT],
    ['live worktree', WORKTREE_ROOT, [{ worktreePath: WORKTREE_ROOT }], WORKTREE_ROOT],
  ])('allows %s', async (_label, requested, panes, expected) => {
    if (requested === SECONDARY_ROOT) approveProjectRoot(requested);
    await expect(authorizeProjectRoot(requested, ACTIVE_ROOT, panes)).resolves.toBe(normalizeRootPath(expected));
  });

  it('rejects an arbitrary existing directory', async () => {
    const arbitrary = mkdtempSync(path.join(tmpdir(), 'aumx-arbitrary-'));
    await expect(authorizeProjectRoot(arbitrary, ACTIVE_ROOT, [])).rejects.toThrow('Unauthorized project root');
  });

  it('accepts a symlink alias only when its canonical target is authorized', async () => {
    const parent = mkdtempSync(path.join(tmpdir(), 'aumx-alias-'));
    const alias = path.join(parent, 'alias');
    symlinkSync(ACTIVE_ROOT, alias, 'dir');
    await expect(authorizeProjectRoot(alias, ACTIVE_ROOT, [])).resolves.toBe(normalizeRootPath(alias));
  });

  it('rejects a removed pane root and nested Kanban target root', async () => {
    const removed = mkdtempSync(path.join(tmpdir(), 'aumx-removed-'));
    const nested = mkdtempSync(path.join(tmpdir(), 'aumx-kanban-target-'));
    mkdirSync(path.join(nested, 'child'));

    await expect(authorizeProjectRoot(removed, ACTIVE_ROOT, [])).rejects.toThrow('Unauthorized project root');
    await expect(authorizeProjectRoot(nested, ACTIVE_ROOT, [])).rejects.toThrow('Unauthorized project root');
  });
});
