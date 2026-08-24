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
  it('uses .amux for a project that has no existing metadata directory', () => {
    const projectRoot = mkdtempSync(path.join(tmpdir(), 'amux-new-project-'));

    expect(getProjectMetadataDir(projectRoot)).toBe(path.join(projectRoot, '.amux'));
    expect(getProjectConfigPath(projectRoot)).toBe(
      path.join(projectRoot, '.amux', 'aumx.config.json'),
    );
    expect(getManagedWorktreePath(projectRoot, 'fix-auth')).toBe(
      path.join(projectRoot, '.amux', 'worktrees', 'fix-auth'),
    );
    expect(getProjectHooksDir(projectRoot)).toBe(path.join(projectRoot, '.amux-hooks'));
  });

  it('keeps using .aumx for an existing legacy project', () => {
    const projectRoot = mkdtempSync(path.join(tmpdir(), 'amux-legacy-project-'));
    mkdirSync(path.join(projectRoot, '.aumx'));
    mkdirSync(path.join(projectRoot, '.aumx-hooks'));

    expect(getProjectMetadataDir(projectRoot)).toBe(path.join(projectRoot, '.aumx'));
    expect(getProjectConfigPath(projectRoot)).toBe(
      path.join(projectRoot, '.aumx', 'aumx.config.json'),
    );
    expect(getProjectHooksDir(projectRoot)).toBe(path.join(projectRoot, '.aumx-hooks'));
  });

  it('prefers .amux when both current and legacy metadata directories exist', () => {
    const projectRoot = mkdtempSync(path.join(tmpdir(), 'amux-current-project-'));
    mkdirSync(path.join(projectRoot, '.aumx'));
    mkdirSync(path.join(projectRoot, '.amux'));

    expect(getProjectMetadataDir(projectRoot)).toBe(path.join(projectRoot, '.amux'));
  });

  it('keeps using a populated legacy config when an empty .amux directory exists', () => {
    const projectRoot = mkdtempSync(path.join(tmpdir(), 'amux-partial-migration-'));
    const legacyDir = path.join(projectRoot, '.aumx');
    mkdirSync(legacyDir);
    mkdirSync(path.join(projectRoot, '.amux'));
    writeFileSync(path.join(legacyDir, 'aumx.config.json'), '{"panes":[]}');

    expect(getProjectMetadataDir(projectRoot)).toBe(legacyDir);
    expect(getProjectConfigPath(projectRoot)).toBe(path.join(legacyDir, 'aumx.config.json'));
  });

  it('prefers the current config after both metadata locations are populated', () => {
    const projectRoot = mkdtempSync(path.join(tmpdir(), 'amux-complete-migration-'));
    const currentDir = path.join(projectRoot, '.amux');
    const legacyDir = path.join(projectRoot, '.aumx');
    mkdirSync(currentDir);
    mkdirSync(legacyDir);
    writeFileSync(path.join(currentDir, 'aumx.config.json'), '{"panes":[]}');
    writeFileSync(path.join(legacyDir, 'aumx.config.json'), '{"panes":[]}');

    expect(getProjectMetadataDir(projectRoot)).toBe(currentDir);
  });

  it.each(['.amux', '.aumx'])('derives the project root from %s worktrees', (metadataDir) => {
    const worktreePath = path.join('/repo', metadataDir, 'worktrees', 'fix-auth');

    expect(deriveProjectRootFromManagedWorktreePath(worktreePath)).toBe('/repo');
  });
});
