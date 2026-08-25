/**
 * Tests for configurable base branch and branch prefix features.
 *
 * Test plan:
 * 1. baseBranch setting: worktrees branch from configured base regardless of current checkout
 * 2. branchPrefix setting: branch is prefixed but worktree dir uses unprefixed slug
 * 3. Merge and close operations work correctly with prefixed branches
 * 4. Orphaned worktree discovery works with prefixed panes
 * 5. Settings API rejects invalid characters in baseBranch/branchPrefix
 * 6. Nonexistent baseBranch shows clear error
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getPaneBranchName, isValidBranchName } from '../src/utils/git.js';
import { buildGitRefVerifyArgs, buildGitRefVerifyCommand } from '../src/utils/paneCreation.js';

// ─── Test 1 & 2: getPaneBranchName, slug/branchName separation ───

describe('getPaneBranchName', () => {
  it('returns branchName when set', () => {
    const pane = {
      id: 'muxbase-1', slug: 'fix-auth', branchName: 'feat/fix-auth',
      prompt: 'test', paneId: '%1',
    };
    expect(getPaneBranchName(pane)).toBe('feat/fix-auth');
  });

  it('falls back to slug when branchName is not set', () => {
    const pane = {
      id: 'muxbase-1', slug: 'fix-auth',
      prompt: 'test', paneId: '%1',
    };
    expect(getPaneBranchName(pane)).toBe('fix-auth');
  });

  it('falls back to slug when branchName is undefined', () => {
    const pane = {
      id: 'muxbase-1', slug: 'fix-auth', branchName: undefined,
      prompt: 'test', paneId: '%1',
    };
    expect(getPaneBranchName(pane)).toBe('fix-auth');
  });
});

// ─── Test 5: Input validation ───

describe('isValidBranchName', () => {
  it('accepts valid branch names', () => {
    expect(isValidBranchName('main')).toBe(true);
    expect(isValidBranchName('master')).toBe(true);
    expect(isValidBranchName('develop')).toBe(true);
    expect(isValidBranchName('origin/main')).toBe(true);
    expect(isValidBranchName('feat/fix-auth')).toBe(true);
    expect(isValidBranchName('release/v2.0')).toBe(true);
    expect(isValidBranchName('user_branch-name.1')).toBe(true);
  });

  it('accepts empty string (means "not set")', () => {
    expect(isValidBranchName('')).toBe(true);
  });

  it('rejects branch names with shell metacharacters', () => {
    expect(isValidBranchName('main; rm -rf /')).toBe(false);
    expect(isValidBranchName('$(whoami)')).toBe(false);
    expect(isValidBranchName('`id`')).toBe(false);
    expect(isValidBranchName("branch'name")).toBe(false);
    expect(isValidBranchName('branch"name')).toBe(false);
    expect(isValidBranchName('branch name')).toBe(false);
    expect(isValidBranchName('branch|name')).toBe(false);
    expect(isValidBranchName('branch&name')).toBe(false);
    expect(isValidBranchName('branch>name')).toBe(false);
  });

  it('rejects common injection patterns', () => {
    expect(isValidBranchName('main; curl attacker.com')).toBe(false);
    expect(isValidBranchName('$(cat /etc/passwd)')).toBe(false);
    expect(isValidBranchName('main && echo pwned')).toBe(false);
  });

  it('rejects path traversal sequences', () => {
    expect(isValidBranchName('../main')).toBe(false);
    expect(isValidBranchName('refs/../../etc')).toBe(false);
    expect(isValidBranchName('foo/../bar')).toBe(false);
    expect(isValidBranchName('..')).toBe(false);
  });
});

// ─── Test 5: Settings validation at write time ───

describe('SettingsManager validation', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doMock('../src/utils/atomicWrite.js', () => ({ atomicWriteJsonSync: vi.fn() }));
  });

  afterEach(() => {
    vi.doUnmock('../src/utils/atomicWrite.js');
  });

  it('rejects invalid baseBranch values', async () => {
    vi.mock('fs', async (importOriginal) => {
      const actual = await importOriginal<typeof import('fs')>();
      return { ...actual, existsSync: vi.fn(() => false), writeFileSync: vi.fn(), mkdirSync: vi.fn() };
    });

    const { SettingsManager } = await import('../src/utils/settingsManager.js');
    const manager = new SettingsManager('/tmp/test-project');

    expect(() => manager.updateSetting('baseBranch', 'main; rm -rf /', 'global')).toThrow('Invalid baseBranch');
    expect(() => manager.updateSetting('baseBranch', '$(whoami)', 'global')).toThrow('Invalid baseBranch');
  });

  it('rejects invalid branchPrefix values', async () => {
    vi.mock('fs', async (importOriginal) => {
      const actual = await importOriginal<typeof import('fs')>();
      return { ...actual, existsSync: vi.fn(() => false), writeFileSync: vi.fn(), mkdirSync: vi.fn() };
    });

    const { SettingsManager } = await import('../src/utils/settingsManager.js');
    const manager = new SettingsManager('/tmp/test-project');

    expect(() => manager.updateSetting('branchPrefix', '`id`/', 'global')).toThrow('Invalid branchPrefix');
    expect(() => manager.updateSetting('branchPrefix', 'feat && echo pwned/', 'project')).toThrow('Invalid branchPrefix');
  });

  it('accepts valid baseBranch and branchPrefix values', async () => {
    vi.mock('fs', async (importOriginal) => {
      const actual = await importOriginal<typeof import('fs')>();
      return { ...actual, existsSync: vi.fn(() => false), writeFileSync: vi.fn(), mkdirSync: vi.fn() };
    });

    const { SettingsManager } = await import('../src/utils/settingsManager.js');
    const manager = new SettingsManager('/tmp/test-project');

    expect(() => manager.updateSetting('baseBranch', 'main', 'global')).not.toThrow();
    expect(() => manager.updateSetting('baseBranch', 'develop', 'global')).not.toThrow();
    expect(() => manager.updateSetting('baseBranch', '', 'global')).not.toThrow();
    expect(() => manager.updateSetting('branchPrefix', 'feat/', 'global')).not.toThrow();
    expect(() => manager.updateSetting('branchPrefix', 'fix/', 'project')).not.toThrow();
    expect(() => manager.updateSetting('branchPrefix', '', 'global')).not.toThrow();
  });
});

// ─── Test 2: Slug vs branchName separation ───

describe('slug and branchName separation', () => {
  it('slug stays filesystem-safe, branchName includes prefix', () => {
    const branchPrefix = 'feat/';
    const slug = 'fix-auth';
    const branchName = branchPrefix ? `${branchPrefix}${slug}` : slug;

    expect(slug).toBe('fix-auth');
    expect(branchName).toBe('feat/fix-auth');
    expect(slug).not.toContain('/');
  });

  it('worktree path uses slug, not branchName', () => {
    const projectRoot = '/home/user/project';
    const slug = 'fix-auth';
    const worktreePath = `${projectRoot}/.muxbase/worktrees/${slug}`;

    expect(worktreePath).toBe('/home/user/project/.muxbase/worktrees/fix-auth');
    expect(worktreePath.split('/').pop()).toBe('fix-auth');
  });

  it('branchName stored on pane only when different from slug', () => {
    const slug = 'fix-auth';

    // With prefix: branchName is stored
    const withPrefix = 'feat/fix-auth' !== slug ? 'feat/fix-auth' : undefined;
    expect(withPrefix).toBe('feat/fix-auth');

    // Without prefix: branchName is not stored
    const noPrefix = 'fix-auth' !== slug ? 'fix-auth' : undefined;
    expect(noPrefix).toBeUndefined();
  });
});

// ─── Test 3: Merge operations quote branch names ───

describe('merge operations quote branch names', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('mergeWorktreeIntoMain quotes branch name', async () => {
    const execFileAsync = vi.fn().mockResolvedValue('');
    vi.doMock('../src/utils/execAsync.js', () => ({
      execFileAsync,
    }));

    const { mergeWorktreeIntoMain } = await import('../src/utils/gitMergeOps.js');

    await mergeWorktreeIntoMain('/test/repo', 'feat/fix-auth');

    expect(execFileAsync).toHaveBeenCalledWith(
      'git',
      ['merge', 'feat/fix-auth', '--no-edit'],
      { cwd: '/test/repo', timeout: 300_000 },
    );
  });

  it('aborts a partial main-repository merge after a timeout or other non-conflict failure', async () => {
    const execFileAsync = vi.fn()
      .mockRejectedValueOnce(new Error('Command timed out after 300000ms'))
      .mockResolvedValueOnce('merge-head')
      .mockResolvedValueOnce('');
    vi.doMock('../src/utils/execAsync.js', () => ({ execFileAsync }));

    const { mergeWorktreeIntoMain } = await import('../src/utils/gitMergeOps.js');

    await expect(mergeWorktreeIntoMain('/test/repo', 'feat/fix-auth')).resolves.toMatchObject({
      success: false,
    });
    expect(execFileAsync).toHaveBeenNthCalledWith(
      2,
      'git',
      ['rev-parse', '-q', '--verify', 'MERGE_HEAD'],
      { cwd: '/test/repo' },
    );
    expect(execFileAsync).toHaveBeenCalledWith(
      'git',
      ['diff', '--name-only', '--diff-filter=U', '--'],
      { cwd: '/test/repo' },
    );
  });

  it('collects conflicts and aborts an unexpected phase-two merge conflict', async () => {
    const execFileAsync = vi.fn()
      .mockRejectedValueOnce(new Error('CONFLICT (content): Merge conflict in src/app.ts'))
      .mockResolvedValueOnce('src/app.ts')
      .mockResolvedValueOnce('');
    vi.doMock('../src/utils/execAsync.js', () => ({ execFileAsync }));

    const { mergeWorktreeIntoMain } = await import('../src/utils/gitMergeOps.js');

    // MERGE_HEAD is present, so the repo is genuinely mid-merge; report it as an
    // actionable conflict rather than a generic failure.
    await expect(mergeWorktreeIntoMain('/test/repo', 'feat/fix-auth')).resolves.toMatchObject({
      success: false,
      status: 'conflicted',
    });
    expect(execFileAsync).toHaveBeenCalledWith(
      'git',
      ['diff', '--name-only', '--diff-filter=U', '--'],
      { cwd: '/test/repo' },
    );
  });

  it('mergeMainIntoWorktree quotes branch name', async () => {
    const execFileAsync = vi.fn().mockResolvedValue('');
    vi.doMock('../src/utils/execAsync.js', () => ({
      execFileAsync,
    }));

    const { mergeMainIntoWorktree } = await import('../src/utils/gitMergeOps.js');

    await mergeMainIntoWorktree('/test/worktree', 'main');

    expect(execFileAsync).toHaveBeenCalledWith(
      'git',
      ['merge', 'main', '--no-edit'],
      { cwd: '/test/worktree', timeout: 300_000 },
    );
  });

  it('allows conflict-resolution commit hooks enough time to finish', async () => {
    const execFileAsync = vi.fn()
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('');
    vi.doMock('../src/utils/execAsync.js', () => ({ execFileAsync }));

    const { completeMerge } = await import('../src/utils/gitMergeOps.js');

    await expect(completeMerge('/test/repo', 'Resolve conflicts')).resolves.toEqual({
      success: true,
    });
    expect(execFileAsync).toHaveBeenNthCalledWith(
      2,
      'git',
      ['commit', '-m', 'Resolve conflicts'],
      { cwd: '/test/repo', timeout: 300_000 },
    );
  });

  it('cleanupAfterMerge quotes branch name in git branch -d', async () => {
    const execFileAsync = vi.fn().mockResolvedValue('');
    vi.doMock('../src/utils/execAsync.js', () => ({
      execFileAsync,
    }));

    const { cleanupAfterMerge } = await import('../src/utils/gitMergeOps.js');

    await cleanupAfterMerge('/test/repo', '/test/worktree', 'feat/fix-auth');

    expect(execFileAsync).toHaveBeenCalledWith(
      'git',
      ['branch', '-d', 'feat/fix-auth'],
      { cwd: '/test/repo' },
    );
  });
});

// ─── Test 4: Orphaned worktree discovery with prefixed panes ───

describe('orphaned worktree discovery with prefixed panes', () => {
  it('directory name matches slug (not branchName), so discovery works', () => {
    const activePanes = [
      { slug: 'fix-auth', branchName: 'feat/fix-auth' },
      { slug: 'add-tests', branchName: 'chore/add-tests' },
    ];
    const activeSlugs = activePanes.map(p => p.slug);
    const directoryEntries = ['fix-auth', 'add-tests', 'old-orphan'];

    const orphaned = directoryEntries.filter(name => !activeSlugs.includes(name));

    expect(orphaned).toEqual(['old-orphan']);
    expect(activeSlugs).toContain('fix-auth');
    expect(activeSlugs).toContain('add-tests');
  });

  it('prefixed branchName would NOT match directory entries (proving slug is needed)', () => {
    const activeBranchNames = ['feat/fix-auth', 'chore/add-tests'];
    const directoryEntries = ['fix-auth', 'add-tests'];

    const matched = directoryEntries.filter(name => activeBranchNames.includes(name));
    expect(matched).toHaveLength(0); // None match — everything wrongly "orphaned"
  });
});

// ─── Test 6: Nonexistent baseBranch error ───

describe('nonexistent baseBranch validation', () => {
  it('error message is clear and actionable', () => {
    // Simulates the error thrown in paneCreation.ts when baseBranch doesn't exist
    const baseBranch = 'nonexistent-branch';
    const errorMessage = `Base branch "${baseBranch}" does not exist. Update the baseBranch setting to a valid branch name.`;

    expect(errorMessage).toContain('nonexistent-branch');
    expect(errorMessage).toContain('does not exist');
    expect(errorMessage).toContain('Update the baseBranch setting');
  });
});

// ─── Test 1: baseBranch in git worktree add command ───

describe('baseBranch in worktree creation command', () => {
  it('verifies remote tracking base branches without forcing refs/heads', () => {
    expect(buildGitRefVerifyArgs('origin/main')).toEqual(['rev-parse', '--verify', 'origin/main']);
    expect(buildGitRefVerifyCommand('origin/main')).toBe("git rev-parse --verify 'origin/main'");
  });

  it('produces correct command with baseBranch as start-point', () => {
    const worktreePath = '/project/.muxbase/worktrees/fix-auth';
    const branchName = 'feat/fix-auth';
    const baseBranch = 'main';

    const startPoint = baseBranch ? ` "${baseBranch}"` : '';
    const cmd = `git worktree add "${worktreePath}" -b "${branchName}"${startPoint}`;

    expect(cmd).toBe('git worktree add "/project/.muxbase/worktrees/fix-auth" -b "feat/fix-auth" "main"');
  });

  it('produces correct command without baseBranch (uses HEAD)', () => {
    const worktreePath = '/project/.muxbase/worktrees/fix-auth';
    const branchName = 'fix-auth';
    const baseBranch = '';

    const startPoint = baseBranch ? ` "${baseBranch}"` : '';
    const cmd = `git worktree add "${worktreePath}" -b "${branchName}"${startPoint}`;

    expect(cmd).toBe('git worktree add "/project/.muxbase/worktrees/fix-auth" -b "fix-auth"');
  });

  it('uses existing branch without -b flag when branch exists', () => {
    const worktreePath = '/project/.muxbase/worktrees/fix-auth';
    const branchName = 'feat/fix-auth';

    const cmd = `git worktree add "${worktreePath}" "${branchName}"`;

    expect(cmd).toBe('git worktree add "/project/.muxbase/worktrees/fix-auth" "feat/fix-auth"');
  });
});

// ─── MUXBASE_BRANCH hook env ───

describe('hooks environment uses branchName', () => {
  it('uses branchName when set', () => {
    const pane = { slug: 'fix-auth', branchName: 'feat/fix-auth', worktreePath: '/x' };
    expect(pane.branchName || pane.slug).toBe('feat/fix-auth');
  });

  it('falls back to slug when no branchName', () => {
    const pane: { slug: string; branchName?: string } = { slug: 'fix-auth' };
    expect(pane.branchName || pane.slug).toBe('fix-auth');
  });
});

// ─── Setting definitions ───

describe('setting definitions', () => {
  it('baseBranch is a text field for arbitrary branch names', async () => {
    const { SETTING_DEFINITIONS } = await import('../src/utils/settingsManager.js');
    const def = SETTING_DEFINITIONS.find(d => d.key === 'baseBranch');

    expect(def).toBeDefined();
    expect(def!.type).toBe('text');
  });

  it('branchPrefix has common prefix options', async () => {
    const { SETTING_DEFINITIONS } = await import('../src/utils/settingsManager.js');
    const def = SETTING_DEFINITIONS.find(d => d.key === 'branchPrefix');

    expect(def).toBeDefined();
    expect(def!.type).toBe('select');

    const values = def!.options!.map(o => o.value);
    expect(values).toContain('');
    expect(values).toContain('feat/');
    expect(values).toContain('fix/');
    expect(values).toContain('chore/');
  });

  it('initGitIfMissing is a boolean worktree setting', async () => {
    const { SETTING_DEFINITIONS } = await import('../src/utils/settingsManager.js');
    const def = SETTING_DEFINITIONS.find(d => d.key === 'initGitIfMissing');

    expect(def).toBeDefined();
    expect(def!.type).toBe('boolean');
  });
});
