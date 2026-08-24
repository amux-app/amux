/**
 * Characterization tests for createPane's worktree-creation strategies.
 *
 * These pin the CURRENT behavior of the two worktree-creation paths in
 * src/utils/paneCreation.ts before any extraction refactor (Slices 0A-0D).
 * The integration suite (paneLifecycle.test.ts) leaves these branches at ~0%
 * line coverage, so every case here is net-new protection against a silent
 * regression during extraction.
 *
 * Harness mirrors paneLifecycle.test.ts: paneCreationGit helpers run for real,
 * steered through the mocked exec layers (execFileAsync / execAsyncWithStatus /
 * execAsync / child_process). No live git or tmux is required.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockExecFileAsync = vi.hoisted(() => vi.fn(async () => ''));
const mockExecAsync = vi.hoisted(() => vi.fn(async () => ''));
const mockExecAsyncWithStatus = vi.hoisted(() =>
  vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false })),
);
const mockIsValidBranchName = vi.hoisted(() => vi.fn(() => true));
const mockSetupSidebarLayout = vi.hoisted(() => vi.fn(() => '%1'));
const mockAtomicWriteJsonSync = vi.hoisted(() => vi.fn());
const mockWaitForAgentInputReady = vi.hoisted(() => vi.fn(async () => true));
const mockWorktreeDirExists = vi.hoisted(() => ({ value: false }));
const mockSettings = vi.hoisted(() => ({
  baseBranch: '',
  branchPrefix: '',
  claudeFullscreenRendering: false,
  defaultAgent: '',
  useTmuxHooks: false,
  useWorktree: true,
}));

const mockExecSync = vi.fn((command: string) => {
  const cmd = command.toString().trim();
  if (cmd.includes('rev-parse --verify')) {
    throw new Error('fatal: bad revision');
  }
  return '';
});
const mockExecFileSync = vi.fn((file: string, args?: readonly string[] | unknown) => {
  const normalizedArgs = Array.isArray(args) ? args : [];
  return mockExecSync([file, ...normalizedArgs].join(' '));
});

vi.mock('child_process', () => ({
  execFileSync: mockExecFileSync,
  execSync: mockExecSync,
}));

const mockTmuxInstance = {
  getCurrentPaneIdSync: vi.fn(() => '%0'),
  getPaneSessionName: vi.fn(async () => 'aumx-test'),
  getPaneSessionNameSync: vi.fn(() => 'aumx-test'),
  newWindowPane: vi.fn(async () => '%1'),
  newWindowPaneSync: vi.fn(() => '%1'),
  paneExists: vi.fn(async () => true),
  refreshClient: vi.fn(async () => {}),
  respawnPane: vi.fn(async () => {}),
  selectPane: vi.fn(async () => {}),
  sendShellCommand: vi.fn(async () => {}),
  sendTmuxKeys: vi.fn(async () => {}),
  setGlobalOptionSync: vi.fn(),
  setPaneTitle: vi.fn(async () => {}),
};
vi.mock('../../src/services/TmuxService.js', () => ({
  TmuxService: { getInstance: vi.fn(() => mockTmuxInstance) },
}));

vi.mock('../../src/utils/execAsync.js', () => ({
  execAsync: mockExecAsync,
  execAsyncWithStatus: mockExecAsyncWithStatus,
  execFileAsync: mockExecFileAsync,
}));

vi.mock('../../src/utils/claudeVersion.js', () => ({
  assertClaudeFullscreenSupported: vi.fn(async () => undefined),
}));

vi.mock('../../src/utils/tmux.js', () => ({
  ensureMinimumWindowSize: vi.fn(),
  getTerminalDimensions: vi.fn(() => ({ height: 50, width: 200 })),
  setupSidebarLayout: mockSetupSidebarLayout,
  splitPane: vi.fn(() => '%1'),
}));

vi.mock('../../src/utils/layoutManager.js', () => ({
  SIDEBAR_WIDTH: 40,
  recalculateAndApplyLayout: vi.fn(),
}));

vi.mock('../../src/utils/atomicWrite.js', () => ({
  atomicWriteJsonSync: mockAtomicWriteJsonSync,
}));

vi.mock('../../src/utils/paneTitle.js', () => ({
  buildWorktreePaneTitle: vi.fn(() => 'test-slug'),
}));

vi.mock('../../src/utils/paneCreationReadiness.js', () => ({
  waitForAgentInputReady: mockWaitForAgentInputReady,
  waitForPaneReady: vi.fn(async () => {}),
  waitForShellReady: vi.fn(async () => true),
}));

vi.mock('../../src/utils/agentLaunch.js', () => ({
  CLAUDE_TERMINAL_COLS: 100,
  appendSlugSuffix: vi.fn((slug: string, suffix?: string) => (suffix ? `${slug}-${suffix}` : slug)),
  claudeUsesFullscreen: (settings: { claudeFullscreenRendering?: boolean }) =>
    settings.claudeFullscreenRendering === true,
  getEffortFlags: vi.fn(() => ''),
  getModelFlags: vi.fn(() => ''),
  getPermissionFlags: vi.fn(() => '--permission-mode auto'),
  getReadOnlyFlags: vi.fn(() => ''),
}));

vi.mock('../../src/utils/paneAgentLaunch.js', () => ({
  launchAgentInPane: vi.fn(async () => {}),
}));

vi.mock('../../src/utils/paneAgentLifecycle.js', () => ({
  isAgentRunningInPane: vi.fn(async () => false),
  resumeAgentInPane: vi.fn(async () => {}),
}));

vi.mock('../../src/utils/git.js', () => ({
  isValidBranchName: mockIsValidBranchName,
}));

vi.mock('../../src/utils/slug.js', () => ({
  generateLocalSlug: vi.fn((prompt: string) => prompt.toLowerCase().replace(/\s+/g, '-').slice(0, 30)),
  sanitizeSlug: vi.fn((input: string) =>
    input
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 30),
  ),
}));

vi.mock('../../src/utils/settingsManager.js', () => ({
  SettingsManager: vi.fn(() => ({
    getSettings: vi.fn(() => ({ ...mockSettings })),
  })),
}));

vi.mock('../../src/constants/timing.js', () => ({
  TMUX_LAYOUT_APPLY_DELAY: 0,
}));

vi.mock('../../src/utils/hooks.js', () => ({
  initializeHooksDirectory: vi.fn(),
  triggerHook: vi.fn(async () => {}),
  triggerHookSync: vi.fn(async () => ({ success: true })),
}));

vi.mock('../../src/services/LogService.js', () => ({
  LogService: {
    getInstance: vi.fn(() => ({
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    })),
  },
}));

vi.mock('fs', () => {
  const readFileSync = vi.fn(() => JSON.stringify({ controlPaneId: '%0', panes: [] }));
  const writeFileSync = vi.fn();
  const mkdirSync = vi.fn();
  const existsSync = vi.fn((p: string) =>
    String(p).includes('worktrees') ? mockWorktreeDirExists.value : true,
  );
  const api = { existsSync, mkdirSync, readFileSync, writeFileSync };
  return { ...api, default: api };
});

const PROJECT_ROOT = '/target/repo';

const baseOptions = (overrides: Record<string, unknown>) => ({
  agent: 'claude' as const,
  existingPanes: [],
  projectName: 'test-project',
  projectRoot: PROJECT_ROOT,
  prompt: 'work',
  useWorktree: true,
  ...overrides,
});

async function importCreatePane() {
  const mod = await import('../../src/utils/paneCreation.js');
  return mod.createPane;
}

const worktreeAddCalls = () => mockExecFileAsync.mock.calls.filter(([file]) => file === 'git');

describe('createPane worktree strategies (characterization)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWorktreeDirExists.value = false;
    mockSettings.baseBranch = '';
    mockSettings.branchPrefix = '';
    mockSettings.useWorktree = true;
    mockIsValidBranchName.mockImplementation(() => true);
    mockSetupSidebarLayout.mockImplementation(() => '%1');
    mockAtomicWriteJsonSync.mockImplementation(() => {});
    mockExecAsync.mockImplementation(async () => '');
    mockExecAsyncWithStatus.mockImplementation(async () => ({
      exitCode: 0,
      stdout: '',
      stderr: '',
      timedOut: false,
    }));
    mockExecFileAsync.mockImplementation(async () => '');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Strategy A — directWorktreeCreation path', () => {
    it('A1: throws on an invalid baseBranch without attempting git worktree add', async () => {
      mockSettings.baseBranch = 'bad@@branch';
      mockIsValidBranchName.mockImplementation((name: string) => name !== 'bad@@branch');
      const createPane = await importCreatePane();

      await expect(
        createPane(baseOptions({ directWorktreeCreation: true, prompt: 'a1' }), ['claude']),
      ).rejects.toThrow('Invalid base branch name: bad@@branch');
      expect(worktreeAddCalls()).toHaveLength(0);
    });

    it('A2: throws when the configured baseBranch does not exist', async () => {
      mockSettings.baseBranch = 'develop';
      mockExecAsyncWithStatus.mockImplementation(async (cmd: string) => ({
        exitCode: cmd.includes('rev-parse --verify') ? 1 : 0,
        stdout: '',
        stderr: '',
        timedOut: false,
      }));
      const createPane = await importCreatePane();

      await expect(
        createPane(baseOptions({ directWorktreeCreation: true, prompt: 'a2' }), ['claude']),
      ).rejects.toThrow('Base branch "develop" does not exist');
    });

    it('A3: existing branch, no start point -> git worktree add WITHOUT -b (createBranch false)', async () => {
      mockExecAsyncWithStatus.mockImplementation(async () => ({
        exitCode: 0,
        stdout: '',
        stderr: '',
        timedOut: false,
      }));
      const createPane = await importCreatePane();

      await createPane(baseOptions({ directWorktreeCreation: true, prompt: 'a3' }), ['claude']);

      const args = worktreeAddCalls()[0]?.[1] as string[];
      expect(args).toContain('worktree');
      expect(args).not.toContain('-b');
    });

    it('A4: existing branch + worktreeStartPoint -> git worktree add WITH -b (createBranch true)', async () => {
      mockExecAsyncWithStatus.mockImplementation(async () => ({
        exitCode: 0,
        stdout: '',
        stderr: '',
        timedOut: false,
      }));
      const createPane = await importCreatePane();

      await createPane(
        baseOptions({ directWorktreeCreation: true, prompt: 'a4', worktreeStartPoint: 'abc123' }),
        ['claude'],
      );

      const args = worktreeAddCalls()[0]?.[1] as string[];
      expect(args).toContain('-b');
      expect(args).toContain('abc123');
    });

    it('A6: happy path creates the worktree once and skips the tmux-shell fallback', async () => {
      mockExecAsyncWithStatus.mockImplementation(async (cmd: string) => ({
        exitCode: cmd.includes('show-ref') ? 1 : 0,
        stdout: '',
        stderr: '',
        timedOut: false,
      }));
      const createPane = await importCreatePane();

      const result = await createPane(
        baseOptions({ directWorktreeCreation: true, prompt: 'a6' }),
        ['claude'],
      );

      expect(worktreeAddCalls()).toHaveLength(1);
      expect(result.pane?.worktreePath).toContain('worktrees');
      const shellWorktreeAdds = mockTmuxInstance.sendShellCommand.mock.calls.filter(([, cmd]) =>
        String(cmd).includes('git worktree add'),
      );
      expect(shellWorktreeAdds).toHaveLength(0);
    });

    it('A7: collision on the first attempt advances the slug and retries', async () => {
      mockExecAsyncWithStatus.mockImplementation(async (cmd: string) => ({
        exitCode: cmd.includes('show-ref') ? 1 : 0,
        stdout: '',
        stderr: '',
        timedOut: false,
      }));
      mockExecFileAsync
        .mockRejectedValueOnce(new Error("fatal: '/x' already exists"))
        .mockResolvedValueOnce('');
      const createPane = await importCreatePane();

      await createPane(baseOptions({ directWorktreeCreation: true, prompt: 'collide' }), ['claude']);

      const calls = worktreeAddCalls();
      expect(calls).toHaveLength(2);
      const firstArgs = (calls[0][1] as string[]).join(' ');
      const secondArgs = (calls[1][1] as string[]).join(' ');
      expect(firstArgs).not.toEqual(secondArgs);
      expect(secondArgs).toContain('collide-2');
    });

    it('A9: refuses the shell fallback when a start point is pinned (protects review panes)', async () => {
      mockExecFileAsync.mockRejectedValue(new Error('spawn git ENOENT'));
      const createPane = await importCreatePane();

      await expect(
        createPane(
          baseOptions({
            directWorktreeCreation: true,
            prompt: 'a9',
            worktreeStartPoint: 'deadbeef',
          }),
          ['claude'],
        ),
      ).rejects.toThrow(/without git in PATH/);

      const shellWorktreeAdds = mockTmuxInstance.sendShellCommand.mock.calls.filter(([, cmd]) =>
        String(cmd).includes('git worktree add'),
      );
      expect(shellWorktreeAdds).toHaveLength(0);
    });

    it('A11: a non-collision, non-fallback git error propagates as a failure', async () => {
      mockExecFileAsync.mockRejectedValue(new Error('fatal: unexpected git failure'));
      const createPane = await importCreatePane();

      await expect(
        createPane(baseOptions({ directWorktreeCreation: true, prompt: 'a11' }), ['claude']),
      ).rejects.toThrow(/Failed to create worktree/);
    });
  });

  describe('Strategy B — tmux-shell path', () => {
    it('B2: new branch -> shell "git worktree add" includes -b (createBranch true)', async () => {
      mockWorktreeDirExists.value = true;
      mockExecFileAsync.mockImplementation(async (_file: string, args: readonly string[]) => {
        if (args.includes('show-ref')) {
          throw new Error('branch missing');
        }
        return '';
      });
      const createPane = await importCreatePane();

      await createPane(baseOptions({ prompt: 'b2' }), ['claude']);

      const shellWorktreeAdd = mockTmuxInstance.sendShellCommand.mock.calls
        .map(([, cmd]) => String(cmd))
        .find((cmd) => cmd.includes('git worktree add'));
      expect(shellWorktreeAdd).toBeDefined();
      expect(shellWorktreeAdd).toContain('-b');
    });

    it('B9: shell-path failure is swallowed and the pane is returned WITHOUT a worktree', async () => {
      mockSettings.baseBranch = 'develop';
      mockExecFileAsync.mockImplementation(async (_file: string, args: readonly string[]) => {
        if (args[0] === 'rev-parse' && args[1] === '--verify') {
          throw new Error('fatal: bad revision develop');
        }
        return '';
      });
      const createPane = await importCreatePane();

      const result = await createPane(baseOptions({ prompt: 'b9' }), ['claude']);

      expect(result.needsAgentChoice).toBe(false);
      expect(result.pane).not.toBeNull();
      expect(result.pane?.worktreePath).toBeUndefined();
      expect(result.pane?.branchName).toBeUndefined();
      const advisories = mockTmuxInstance.sendShellCommand.mock.calls
        .map(([, cmd]) => String(cmd))
        .filter((cmd) => cmd.includes('Failed to create worktree') || cmd.includes('Tip: Try running'));
      expect(advisories.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('Self-healing sidebar split', () => {
    it('C1: "no space for new pane" falls back to a new tmux window', async () => {
      mockSetupSidebarLayout.mockImplementation(() => {
        throw new Error('no space for new pane');
      });
      const createPane = await importCreatePane();

      const result = await createPane(baseOptions({ prompt: 'c1', useWorktree: false }), ['claude']);

      expect(result.pane).not.toBeNull();
      expect(mockTmuxInstance.newWindowPane).toHaveBeenCalledTimes(1);
      expect(mockSetupSidebarLayout).toHaveBeenCalledTimes(1);
    });

    it('C2: stale control pane ("can\'t find pane") rewrites config and retries the split', async () => {
      mockSetupSidebarLayout
        .mockImplementationOnce(() => {
          throw new Error("can't find pane %0");
        })
        .mockImplementation(() => '%1');
      const createPane = await importCreatePane();

      const result = await createPane(baseOptions({ prompt: 'c2', useWorktree: false }), ['claude']);

      expect(result.pane).not.toBeNull();
      expect(mockSetupSidebarLayout).toHaveBeenCalledTimes(2);
      expect(mockTmuxInstance.newWindowPane).not.toHaveBeenCalled();
    });

    it('C4: config-write failure during self-heal re-throws the ORIGINAL split error', async () => {
      mockSetupSidebarLayout.mockImplementation(() => {
        throw new Error("can't find pane %0");
      });
      mockAtomicWriteJsonSync.mockImplementation(() => {
        throw new Error('disk full writing config');
      });
      const createPane = await importCreatePane();

      await expect(
        createPane(baseOptions({ prompt: 'c4', useWorktree: false }), ['claude']),
      ).rejects.toThrow(/can't find pane/);
    });

    it('C6: an unrelated split error propagates without a window fallback', async () => {
      mockSetupSidebarLayout.mockImplementation(() => {
        throw new Error('tmux server not running');
      });
      const createPane = await importCreatePane();

      await expect(
        createPane(baseOptions({ prompt: 'c6', useWorktree: false }), ['claude']),
      ).rejects.toThrow(/tmux server not running/);
      expect(mockTmuxInstance.newWindowPane).not.toHaveBeenCalled();
    });
  });

  describe('Fresh interactive agent readiness', () => {
    it.each(['claude', 'codex', 'opencode', 'pi'] as const)(
      'leaves a fresh unprompted %s pane without persisted runtime activity, including the optimistic early emit',
      async (agent) => {
        let earlyPane: AumxPane | undefined;
        const createPane = await importCreatePane();

        const result = await createPane(baseOptions({
          agent,
          agentPrompt: '',
          earlyEmit: {
            onReady: (pane) => { earlyPane = { ...pane }; },
            onRollback: vi.fn(),
          },
          prompt: '',
          useWorktree: false,
        }), [agent]);

        expect(earlyPane).toMatchObject({ startedWithoutInitialPrompt: true });
        expect(earlyPane).not.toHaveProperty('agentStatus');
        expect(earlyPane).not.toHaveProperty('lastAgentCheck');
        expect(result.pane).toMatchObject({ startedWithoutInitialPrompt: true });
        expect(result.pane).not.toHaveProperty('agentStatus');
        expect(result.pane).not.toHaveProperty('lastAgentCheck');
      },
    );

    it.each(['opencode', 'pi'] as const)(
      'keeps a fresh %s pane free of persisted runtime activity once its composer is ready',
      async (agent) => {
        const createPane = await importCreatePane();

        const result = await createPane(baseOptions({
          agent,
          agentPrompt: '',
          prompt: '',
          useWorktree: false,
        }), [agent]);

        expect(mockWaitForAgentInputReady).toHaveBeenCalledWith(
          mockTmuxInstance,
          '%1',
          agent,
        );
        expect(result.pane).toMatchObject({ startedWithoutInitialPrompt: true });
        expect(result.pane).not.toHaveProperty('agentStatus');
        expect(result.pane).not.toHaveProperty('lastAgentCheck');
      },
    );

    it('records a fresh launch independently of the display prompt', async () => {
      mockWaitForAgentInputReady.mockResolvedValueOnce(false);
      const createPane = await importCreatePane();

      const result = await createPane(baseOptions({
        agent: 'pi',
        agentPrompt: '',
        prompt: 'display-only task name',
        useWorktree: false,
      }), ['pi']);

      expect(mockWaitForAgentInputReady).toHaveBeenCalledWith(mockTmuxInstance, '%1', 'pi');
      expect(result.pane).toMatchObject({
        prompt: 'display-only task name',
        startedWithoutInitialPrompt: true,
      });
    });

    it('records prompt provenance after selecting the only available agent', async () => {
      mockWaitForAgentInputReady.mockResolvedValueOnce(false);
      const createPane = await importCreatePane();

      const result = await createPane(baseOptions({
        agent: undefined,
        agentPrompt: '',
        prompt: 'display-only task name',
        useWorktree: false,
      }), ['pi']);

      expect(mockWaitForAgentInputReady).toHaveBeenCalledWith(mockTmuxInstance, '%1', 'pi');
      expect(result.pane).toMatchObject({
        agent: 'pi',
        startedWithoutInitialPrompt: true,
      });
    });

    it('does not mark a prompted Pi launch idle from persistent UI chrome', async () => {
      const createPane = await importCreatePane();

      const result = await createPane(baseOptions({
        agent: 'pi',
        agentPrompt: 'fix the tests',
        prompt: 'fix the tests',
        useWorktree: false,
      }), ['pi']);

      expect(mockWaitForAgentInputReady).not.toHaveBeenCalled();
      expect(result.pane?.agentStatus).toBeUndefined();
      expect(result.pane?.startedWithoutInitialPrompt).toBe(false);
    });

    it('rolls back an early pane when it disappears during readiness polling', async () => {
      const onRollback = vi.fn();
      mockWaitForAgentInputReady.mockRejectedValueOnce(
        new Error('Pane %1 disappeared during agent startup'),
      );
      const createPane = await importCreatePane();

      await expect(createPane(baseOptions({
        agent: 'pi',
        agentPrompt: '',
        earlyEmit: { onReady: vi.fn(), onRollback },
        prompt: '',
        useWorktree: false,
      }), ['pi'])).rejects.toThrow('Pane %1 disappeared during agent startup');

      expect(onRollback).toHaveBeenCalledOnce();
    });
  });
});
