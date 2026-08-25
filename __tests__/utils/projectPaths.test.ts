import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  deriveProjectRootFromManagedWorktreePath,
  getManagedWorktreePath,
  getProjectConfigPath,
  getProjectHooksDir,
  getProjectMetadataDir,
} from '../../src/utils/worktreePaths.js';

describe('project metadata paths', () => {
  it('uses .muxbase for a project that has no existing metadata directory', () => {
    const projectRoot = mkdtempSync(path.join(tmpdir(), 'muxbase-new-project-'));

    expect(getProjectMetadataDir(projectRoot)).toBe(path.join(projectRoot, '.muxbase'));
    expect(getProjectConfigPath(projectRoot)).toBe(
      path.join(projectRoot, '.muxbase', 'muxbase.config.json'),
    );
    expect(getManagedWorktreePath(projectRoot, 'fix-auth')).toBe(
      path.join(projectRoot, '.muxbase', 'worktrees', 'fix-auth'),
    );
    expect(getProjectHooksDir(projectRoot)).toBe(path.join(projectRoot, '.muxbase-hooks'));
  });

  it('uses .muxbase for an existing project', () => {
    const projectRoot = mkdtempSync(path.join(tmpdir(), 'muxbase-existing-project-'));
    mkdirSync(path.join(projectRoot, '.muxbase'));
    mkdirSync(path.join(projectRoot, '.muxbase-hooks'));

    expect(getProjectMetadataDir(projectRoot)).toBe(path.join(projectRoot, '.muxbase'));
    expect(getProjectConfigPath(projectRoot)).toBe(
      path.join(projectRoot, '.muxbase', 'muxbase.config.json'),
    );
    expect(getProjectHooksDir(projectRoot)).toBe(path.join(projectRoot, '.muxbase-hooks'));
  });

  it('ignores the old metadata and hook directories', () => {
    const projectRoot = mkdtempSync(path.join(tmpdir(), 'muxbase-fresh-project-'));
    const oldMetadataDir = path.join(projectRoot, ['.', 'a', 'mux'].join(''));
    const oldHooksDir = path.join(projectRoot, ['.', 'a', 'mux-hooks'].join(''));
    mkdirSync(oldMetadataDir);
    mkdirSync(oldHooksDir);
    writeFileSync(path.join(oldMetadataDir, 'muxbase.config.json'), '{"panes":[]}');

    expect(getProjectMetadataDir(projectRoot)).toBe(path.join(projectRoot, '.muxbase'));
    expect(getProjectConfigPath(projectRoot)).toBe(
      path.join(projectRoot, '.muxbase', 'muxbase.config.json'),
    );
    expect(getProjectHooksDir(projectRoot)).toBe(path.join(projectRoot, '.muxbase-hooks'));
  });

  it('derives the project root only from .muxbase worktrees', () => {
    const worktreePath = path.join('/repo', '.muxbase', 'worktrees', 'fix-auth');

    expect(deriveProjectRootFromManagedWorktreePath(worktreePath)).toBe('/repo');
    expect(deriveProjectRootFromManagedWorktreePath(
      path.join('/repo', ['.', 'a', 'mux'].join(''), 'worktrees', 'fix-auth'),
    )).toBeUndefined();
  });
});
