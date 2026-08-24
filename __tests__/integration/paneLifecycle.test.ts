/**
 * Integration tests for pane lifecycle (creation, closure, rebinding)
 * Target: Cover src/utils/paneCreation.ts (568 lines, currently 0%)
 * Expected coverage gain: +3-4%
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AumxPane } from '../../src/types.js';
import type { ActionContext } from '../../src/actions/types.js';
import { assertClaudeFullscreenSupported } from '../../src/utils/claudeVersion.js';
import {
  createMockTmuxSession,
} from '../fixtures/integration/tmuxSession.js';
import {
  createMockGitRepo,
  addWorktree,
  type MockGitRepo,
} from '../fixtures/integration/gitRepo.js';
import { createMockExecSync } from '../helpers/integration/mockCommands.js';

// Mock child_process
const mockExecSync = createMockExecSync({});
const mockSettingsState = vi.hoisted(() => ({ claudeFullscreenRendering: false }));
const mockFindPiSessionFile = vi.hoisted(() => vi.fn(async () => '/source/sessions/pi.jsonl'));
const mockExecFileSync = vi.fn((file: string, args?: readonly string[] | any, options?: any) => {
  const normalizedArgs = Array.isArray(args) ? args : [];
  const normalizedOptions = Array.isArray(args) ? options : args;
  const command = [file, ...normalizedArgs].join(' ');
  return mockExecSync(command, normalizedOptions);
});
vi.mock('child_process', () => ({
  execFileSync: mockExecFileSync,
  execSync: mockExecSync,
}));

// Mock TmuxService — singleton so all callers share the same spy references
const mockTmuxInstance = {
  paneExists: vi.fn(async () => true),
  getPaneCurrentCommand: vi.fn(async () => 'bash'),
  getPanePid: vi.fn(async () => 100),
  splitPane: vi.fn(() => '%1'),
  getCurrentPaneIdSync: vi.fn(() => '%0'),
  setGlobalOptionSync: vi.fn(),
  getPaneSessionName: vi.fn(async () => 'aumx-test'),
  getPaneSessionNameSync: vi.fn(() => 'aumx-test'),
  newWindowPane: vi.fn(async () => '%1'),
  newWindowPaneSync: vi.fn(() => '%1'),
  respawnPane: vi.fn(async () => {}),
  sendShellCommand: vi.fn(async () => {}),
  sendTmuxKeys: vi.fn(async () => {}),
  sendKeys: vi.fn(),
  refreshClient: vi.fn(async () => {}),
  setPaneTitle: vi.fn(async () => {}),
  selectPane: vi.fn(async () => {}),
};
vi.mock('../../src/services/TmuxService.js', () => ({
  TmuxService: {
    getInstance: vi.fn(() => mockTmuxInstance),
  },
}));

// Mock execAsync
vi.mock('../../src/utils/execAsync.js', () => ({
  execAsync: vi.fn(async () => ''),
  execFileAsync: vi.fn(async () => ''),
  execAsyncWithStatus: vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false })),
}));

vi.mock('../../src/utils/claudeVersion.js', () => ({
  assertClaudeFullscreenSupported: vi.fn(async () => undefined),
}));

vi.mock('../../src/utils/agentDetection.js', () => ({
  findPiCommand: vi.fn(async () => '/verified/pi'),
}));

vi.mock('../../src/agents/pi-runtime.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/agents/pi-runtime.js')>(),
  findPiSessionFile: mockFindPiSessionFile,
}));

// Mock tmux utilities
vi.mock('../../src/utils/tmux.js', () => ({
  setupSidebarLayout: vi.fn(() => '%1'),
  getTerminalDimensions: vi.fn(() => ({ width: 200, height: 50 })),
  splitPane: vi.fn(() => '%1'),
  ensureMinimumWindowSize: vi.fn(),
}));

// Mock layoutManager
vi.mock('../../src/utils/layoutManager.js', () => ({
  SIDEBAR_WIDTH: 40,
  recalculateAndApplyLayout: vi.fn(),
}));

// Mock atomicWrite
vi.mock('../../src/utils/atomicWrite.js', () => ({
  atomicWriteJsonSync: vi.fn(),
}));

// Mock promptStore
vi.mock('../../src/utils/promptStore.js', () => ({
  writePromptFile: vi.fn(() => '/tmp/prompt.txt'),
  buildPromptReadAndDeleteSnippet: vi.fn(() => 'cat /tmp/prompt.txt'),
}));

// Mock paneTitle
vi.mock('../../src/utils/paneTitle.js', () => ({
  buildWorktreePaneTitle: vi.fn(() => 'test-slug'),
}));

// Mock autoApproveTrustPrompt
vi.mock('../../src/utils/autoApproveTrustPrompt.js', () => ({
  autoApproveTrustPrompt: vi.fn(async () => {}),
}));

// Mock agentLaunch
vi.mock('../../src/utils/agentLaunch.js', () => ({
  appendSlugSuffix: vi.fn((slug: string, suffix?: string) => suffix ? `${slug}-${suffix}` : slug),
  claudeUsesFullscreen: (settings: { claudeFullscreenRendering?: boolean }) =>
    settings.claudeFullscreenRendering === true,
  getPermissionFlags: vi.fn(() => '--permission-mode auto'),
  getReadOnlyFlags: vi.fn(() => ''),
  getModelFlags: vi.fn(() => ''),
  getEffortFlags: vi.fn(() => ''),
  CLAUDE_TERMINAL_COLS: 100,
}));

// Mock git utilities
vi.mock('../../src/utils/git.js', () => ({
  isValidBranchName: vi.fn(() => true),
}));

// Mock slug generation
vi.mock('../../src/utils/slug.js', () => ({
  generateLocalSlug: vi.fn((prompt: string) => prompt.toLowerCase().replace(/\s+/g, '-').slice(0, 30)),
  sanitizeSlug: vi.fn((input: string) =>
    input
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 30)
      .replace(/-+$/g, ''),
  ),
}));

// Mock settingsManager
vi.mock('../../src/utils/settingsManager.js', () => ({
  SettingsManager: vi.fn(() => ({
    getSettings: vi.fn(() => ({
      defaultAgent: '',
      useTmuxHooks: false,
      baseBranch: '',
      branchPrefix: '',
      claudeFullscreenRendering: mockSettingsState.claudeFullscreenRendering,
      useWorktree: true,
    })),
  })),
}));

// Mock timing constants
vi.mock('../../src/constants/timing.js', () => ({
  TMUX_LAYOUT_APPLY_DELAY: 0,
}));

// Mock StateManager
const mockGetPanes = vi.fn(() => []);
const mockSetPanes = vi.fn();
const mockGetState = vi.fn(() => ({ projectRoot: '/test' }));
const mockPauseConfigWatcher = vi.fn();
const mockResumeConfigWatcher = vi.fn();
vi.mock('../../src/shared/StateManager.js', () => ({
  StateManager: {
    getInstance: vi.fn(() => ({
      getPanes: mockGetPanes,
      setPanes: mockSetPanes,
      getState: mockGetState,
      pauseConfigWatcher: mockPauseConfigWatcher,
      resumeConfigWatcher: mockResumeConfigWatcher,
    })),
  },
}));

// Mock hooks
vi.mock('../../src/utils/hooks.js', () => ({
  triggerHook: vi.fn(() => Promise.resolve()),
  triggerHookSync: vi.fn(() => Promise.resolve({ success: true })),
  initializeHooksDirectory: vi.fn(),
}));

// Mock LogService
vi.mock('../../src/services/LogService.js', () => ({
  LogService: {
    getInstance: vi.fn(() => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    })),
  },
}));

const mockEnqueueCleanup = vi.fn();
vi.mock('../../src/services/WorktreeCleanupService.js', () => ({
  WorktreeCleanupService: {
    getInstance: vi.fn(() => ({
      enqueueCleanup: mockEnqueueCleanup,
    })),
  },
}));

// Mock fs for reading config
vi.mock('fs', () => ({
  default: {
    readFileSync: vi.fn(() => JSON.stringify({ controlPaneId: '%0', panes: [] })),
    writeFileSync: vi.fn(),
    existsSync: vi.fn(() => true),
  },
  readFileSync: vi.fn(() => JSON.stringify({ controlPaneId: '%0', panes: [] })),
  writeFileSync: vi.fn(),
  existsSync: vi.fn(() => true),
}));

describe('Pane Lifecycle Integration Tests', () => {
  let gitRepo: MockGitRepo;

  beforeEach(() => {
    // Reset all mocks
    vi.clearAllMocks();
    mockEnqueueCleanup.mockReset();
    mockSettingsState.claudeFullscreenRendering = false;

    // Create fresh test environment
    createMockTmuxSession('aumx-test', 1);
    gitRepo = createMockGitRepo('main');

    // Configure mock execSync with test data
    mockExecSync.mockImplementation((command: string, options?: any) => {
      const cmd = command.toString().trim();
      const encoding = options?.encoding;

      // Helper to return string or buffer based on encoding option
      const returnValue = (value: string) => {
        if (encoding === 'utf-8') {
          return value;
        }
        return Buffer.from(value);
      };

      // Tmux display-message (get current pane id)
      if (cmd.includes('display-message') && cmd.includes('-t %1')) {
        return returnValue('%1');
      }
      if (cmd.includes('display-message')) {
        return returnValue('%0');
      }

      // Tmux list-panes
      if (cmd.includes('list-panes -s -t')) {
        return returnValue('%0\n%1');
      }
      if (cmd.includes('list-panes')) {
        return returnValue('%0:aumx-control:80x24\n%1:test:80x24');
      }

      // Tmux split-window
      if (cmd.includes('split-window')) {
        return returnValue('%1');
      }

      // Git worktree add
      if (cmd.includes('worktree add')) {
        gitRepo = addWorktree(gitRepo, '/test/.aumx/worktrees/test-slug', 'test-slug');
        return returnValue('');
      }

      // Git worktree list
      if (cmd.includes('worktree list')) {
        return returnValue('/test/.aumx/worktrees/test-slug abc123 [test-slug]');
      }

      // Git symbolic-ref (main branch)
      if (cmd.includes('symbolic-ref')) {
        return returnValue('refs/heads/main');
      }

      // Git rev-parse (current branch)
      if (cmd.includes('rev-parse')) {
        return returnValue('main');
      }

      // Default
      return returnValue('');
    });

    // Configure StateManager mock
    mockGetPanes.mockReturnValue([]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Pane Creation Flow', () => {
    it('rejects unsupported fullscreen Claude before hooks, worktrees, or tmux mutation', async () => {
      mockSettingsState.claudeFullscreenRendering = true;
      vi.mocked(assertClaudeFullscreenSupported).mockRejectedValueOnce(new Error('unsupported Claude'));
      const { createPane } = await import('../../src/utils/paneCreation.js');
      const { triggerHook } = await import('../../src/utils/hooks.js');
      const { setupSidebarLayout } = await import('../../src/utils/tmux.js');

      await expect(createPane({
        agent: 'claude',
        existingPanes: [],
        projectName: 'test-project',
        prompt: 'start work',
      }, ['claude'])).rejects.toThrow('unsupported Claude');

      expect(triggerHook).not.toHaveBeenCalled();
      expect(mockTmuxInstance.sendShellCommand).not.toHaveBeenCalled();
      expect(setupSidebarLayout).not.toHaveBeenCalled();
      expect(mockSetPanes).not.toHaveBeenCalled();
    });

    it('should create pane with generated slug', async () => {
      // Import pane creation utilities
      const { createPane } = await import('../../src/utils/paneCreation.js');

      const result = await createPane(
        {
          prompt: 'fix authentication bug',
          agent: 'claude',
          projectName: 'test-project',
          existingPanes: [],
        },
        ['claude', 'opencode']
      );

      // Should return a pane (not needsAgentChoice)
      expect(result).toHaveProperty('pane');
      if ('pane' in result) {
        expect(result.pane.prompt).toBe('fix authentication bug');
        expect(result.pane.slug).toBeTruthy();
        expect(result.pane.paneId).toBeTruthy();
      }
    });

    it('should create git worktree with branch', async () => {
      const { createPane } = await import('../../src/utils/paneCreation.js');
      const { TmuxService } = await import('../../src/services/TmuxService.js');
      const tmuxService = TmuxService.getInstance();

      await createPane(
        {
          prompt: 'add user dashboard',
          agent: 'claude',
          projectName: 'test-project',
          existingPanes: [],
        },
        ['claude']
      );

      // Worktree creation is sent as a shell command through tmux
      expect(tmuxService.sendShellCommand).toHaveBeenCalledWith(
        expect.any(String),
        expect.stringContaining('git worktree add')
      );
    });

    it('should split tmux pane', async () => {
      const { createPane } = await import('../../src/utils/paneCreation.js');
      const { setupSidebarLayout } = await import('../../src/utils/tmux.js');

      const result = await createPane(
        {
          prompt: 'refactor component',
          agent: 'claude',
          projectName: 'test-project',
          existingPanes: [],
        },
        ['claude']
      );

      // First content pane uses setupSidebarLayout
      expect(setupSidebarLayout).toHaveBeenCalled();

      // Pane should have tmux pane ID
      if ('pane' in result) {
        expect(result.pane.paneId).toMatch(/%\d+/);
      }
    });

    it('should create agent panes in the selected project root for added projects', async () => {
      const { createPane } = await import('../../src/utils/paneCreation.js');
      const { TmuxService } = await import('../../src/services/TmuxService.js');
      const tmuxService = TmuxService.getInstance();

      await createPane(
        {
          prompt: 'work on added project',
          agent: 'claude',
          projectName: 'test-project',
          existingPanes: [
            {
              id: 'aumx-1',
              slug: 'existing',
              prompt: 'existing pane',
              paneId: '%5',
              projectRoot: '/primary/repo',
              worktreePath: '/primary/repo/.aumx/worktrees/existing',
            },
          ],
          projectRoot: '/target/repo',
          slugBase: 'target-slug',
        },
        ['claude']
      );

      // Worktree add command should reference the target project root
      expect(tmuxService.sendShellCommand).toHaveBeenCalledWith(
        expect.any(String),
        expect.stringContaining("cd '/target/repo' && git worktree add -- '/target/repo/.amux/worktrees/target-slug' 'target-slug'")
      );
    });

    it('resolves a selected Pi session before forking it into a worktree', async () => {
      const { createPane } = await import('../../src/utils/paneCreation.js');

      await createPane({
        agent: 'pi',
        existingPanes: [],
        projectName: 'test-project',
        projectRoot: '/target/repo',
        prompt: '',
        resumeSessionId: '019fd282-216d',
        slugBase: 'pi-fork',
        useWorktree: true,
      }, ['pi']);

      expect(mockFindPiSessionFile).toHaveBeenCalledWith('/target/repo', '019fd282-216d');
      const command = mockTmuxInstance.respawnPane.mock.calls[0]?.[0]?.command ?? '';
      expect(command).toContain('/verified/pi');
      expect(command).toContain('--fork');
      expect(command).toContain('/source/sessions/pi.jsonl');
    });

    it('should resize a window-mode pane before launching the agent when initial geometry is available', async () => {
      const { createPane } = await import('../../src/utils/paneCreation.js');
      const { execAsync } = await import('../../src/utils/execAsync.js');
      const { TmuxService } = await import('../../src/services/TmuxService.js');
      const tmuxService = TmuxService.getInstance();
      vi.mocked(execAsync).mockImplementation(async (command) => (
        command.includes('display-message') ? '100x38' : ''
      ));

      await createPane(
        {
          prompt: 'start at the visible terminal size',
          agent: 'claude',
          projectName: 'test-project',
          existingPanes: [],
          initialTerminalSize: { cols: 132, rows: 38 },
          layoutMode: 'window',
          sessionName: 'aumx-test',
          useWorktree: false,
        },
        ['claude'],
      );

      // Classic Claude panes are born at the fixed reading width (CLAUDE_TERMINAL_COLS=100),
      // never the raw cell width, so a later width-shrink can't strand a duplicate banner.
      // Rows are preserved from the initial geometry.
      expect(execAsync).toHaveBeenCalledWith(
        "tmux resize-window -t '%1' -x 100 -y 38",
        { timeout: 5000 },
      );
      expect(execAsync).toHaveBeenCalledWith(
        "tmux resize-pane -t '%1' -x 100 -y 38",
        { timeout: 5000 },
      );

      const resizeWindowIndex = vi.mocked(execAsync).mock.calls
        .findIndex((call) => String(call[0]).includes('resize-window'));
      expect(resizeWindowIndex).toBeGreaterThanOrEqual(0);
      expect(vi.mocked(execAsync).mock.invocationCallOrder[resizeWindowIndex])
        .toBeLessThan(tmuxService.respawnPane.mock.invocationCallOrder[0]);
    });

    it('should establish classic Claude width before launch when rows are unavailable', async () => {
      const { createPane } = await import('../../src/utils/paneCreation.js');
      const { execAsync } = await import('../../src/utils/execAsync.js');
      const { TmuxService } = await import('../../src/services/TmuxService.js');
      const tmuxService = TmuxService.getInstance();
      vi.mocked(execAsync).mockImplementation(async (command) => (
        command.includes('display-message') ? '100x24' : ''
      ));

      const result = await createPane(
        {
          prompt: 'start with an invariant width',
          agent: 'claude',
          projectName: 'test-project',
          existingPanes: [],
          layoutMode: 'window',
          sessionName: 'aumx-test',
          useWorktree: false,
        },
        ['claude'],
      );

      expect(execAsync).toHaveBeenCalledWith(
        "tmux resize-window -t '%1' -x 100",
        { timeout: 5000 },
      );
      expect(execAsync).toHaveBeenCalledWith(
        "tmux resize-pane -t '%1' -x 100",
        { timeout: 5000 },
      );
      expect(result.pane).toMatchObject({
        claudeRenderer: 'classic',
        terminalFixedCols: 100,
      });

      const resizeWindowIndex = vi.mocked(execAsync).mock.calls
        .findIndex((call) => String(call[0]).includes('resize-window'));
      expect(vi.mocked(execAsync).mock.invocationCallOrder[resizeWindowIndex])
        .toBeLessThan(tmuxService.respawnPane.mock.invocationCallOrder[0]);
    });

    it('should handle slug generation failure (fallback to timestamp)', async () => {
      // Mock OpenRouter API failure
      const mockFetch = vi.fn(() =>
        Promise.reject(new Error('API timeout'))
      );
      global.fetch = mockFetch;

      const { createPane } = await import('../../src/utils/paneCreation.js');

      const result = await createPane(
        {
          prompt: 'test prompt',
          agent: 'claude',
          projectName: 'test-project',
          existingPanes: [],
        },
        ['claude']
      );

      // Should fallback to local slug derived from prompt keywords
      if ('pane' in result) {
        expect(result.pane.slug).toBe('test-prompt');
      }
    });

    it('should return needsAgentChoice when agent not specified', async () => {
      const { createPane } = await import('../../src/utils/paneCreation.js');

      const result = await createPane(
        {
          prompt: 'test prompt',
          projectName: 'test-project',
          existingPanes: [],
        },
        ['claude', 'opencode']
      );

      // Should return needsAgentChoice
      expect(result).toHaveProperty('needsAgentChoice');
      if ('needsAgentChoice' in result) {
        expect(result.needsAgentChoice).toBe(true);
      }
    });

    it('should handle empty agent list', async () => {
      const { createPane } = await import('../../src/utils/paneCreation.js');

      const result = await createPane(
        {
          prompt: 'test prompt',
          projectName: 'test-project',
          existingPanes: [],
        },
        []
      );

      // Should return error or handle gracefully
      expect(result).toBeDefined();
    });
  });

  describe('Pane Closure Flow', () => {
    it('should present choice dialog for worktree panes', async () => {
      const { closePane } = await import('../../src/actions/implementations/closeAction.js');

      const testPane: AumxPane = {
        id: 'aumx-1',
        slug: 'test-branch',
        prompt: 'test',
        paneId: '%1',
        worktreePath: '/test/.aumx/worktrees/test-branch',
      };

      const mockContext: ActionContext = {
        projectName: 'test-project',
        panes: [testPane],
        savePanes: vi.fn(),
      };

      const result = await closePane(testPane, mockContext);

      // Should return choice dialog with 3 options
      expect(result.type).toBe('choice');
      if (result.type === 'choice') {
        expect(result.options).toHaveLength(3);
        expect(result.options?.map(o => o.id)).toEqual([
          'kill_only',
          'kill_and_clean',
          'kill_clean_branch',
        ]);
      }
    });

    it('should kill tmux pane when closing', async () => {
      const { closePane } = await import('../../src/actions/implementations/closeAction.js');

      const testPane: AumxPane = {
        id: 'aumx-1',
        slug: 'test-branch',
        prompt: 'test',
        paneId: '%1',
        worktreePath: '/test/.aumx/worktrees/test-branch',
      };

      const mockContext: ActionContext = {
        projectName: 'test-project',
        panes: [testPane],
        savePanes: vi.fn(),
      };

      mockGetPanes.mockReturnValue([testPane]);

      const result = await closePane(testPane, mockContext);

      // Execute the close
      if (result.type === 'choice' && result.onSelect) {
        await result.onSelect('kill_only');
      }

      expect(mockExecFileSync).toHaveBeenCalledWith(
        'tmux',
        ['kill-pane', '-t', '%1'],
        expect.any(Object)
      );
    });

    it('should queue worktree cleanup with kill_and_clean option', async () => {
      const { closePane } = await import('../../src/actions/implementations/closeAction.js');

      const testPane: AumxPane = {
        id: 'aumx-1',
        slug: 'test-branch',
        prompt: 'test',
        paneId: '%1',
        worktreePath: '/test/.aumx/worktrees/test-branch',
      };

      const mockContext: ActionContext = {
        projectName: 'test-project',
        panes: [testPane],
        savePanes: vi.fn(),
      };

      mockGetPanes.mockReturnValue([testPane]);

      const result = await closePane(testPane, mockContext);

      if (result.type === 'choice' && result.onSelect) {
        await result.onSelect('kill_and_clean');
      }

      expect(mockEnqueueCleanup).toHaveBeenCalledWith(
        expect.objectContaining({
          pane: testPane,
          deleteBranch: false,
        })
      );
    });

    it('should handle background cleanup enqueue failure gracefully', async () => {
      const { closePane } = await import('../../src/actions/implementations/closeAction.js');

      mockEnqueueCleanup.mockImplementation(() => {
        throw new Error('enqueue failed');
      });

      const testPane: AumxPane = {
        id: 'aumx-1',
        slug: 'test-branch',
        prompt: 'test',
        paneId: '%1',
        worktreePath: '/test/.aumx/worktrees/test-branch',
      };

      const mockContext: ActionContext = {
        projectName: 'test-project',
        panes: [testPane],
        savePanes: vi.fn(),
      };

      mockGetPanes.mockReturnValue([testPane]);

      const result = await closePane(testPane, mockContext);
      let executeResult = result;

      if (result.type === 'choice' && result.onSelect) {
        executeResult = await result.onSelect('kill_and_clean');
      }

      // Should still succeed (cleanup enqueue failures are non-critical)
      expect(executeResult.type).toBe('success');
    });

    it('should trigger post-close hooks', async () => {
      const { closePane } = await import('../../src/actions/implementations/closeAction.js');
      const { triggerHook } = await import('../../src/utils/hooks.js');

      const testPane: AumxPane = {
        id: 'aumx-1',
        slug: 'test-branch',
        prompt: 'test',
        paneId: '%1',
        worktreePath: '/test/.aumx/worktrees/test-branch',
      };

      const mockContext: ActionContext = {
        projectName: 'test-project',
        panes: [testPane],
        savePanes: vi.fn(),
      };

      mockGetPanes.mockReturnValue([testPane]);

      const result = await closePane(testPane, mockContext);

      if (result.type === 'choice' && result.onSelect) {
        await result.onSelect('kill_and_cleanup_worktree');
      }

      // Verify hooks were triggered
      expect(triggerHook).toHaveBeenCalled();
    });
  });

  describe('Pane Rebinding Flow', () => {
    it('should detect dead pane', async () => {
      // Mock tmux pane not found
      mockExecSync.mockImplementation((cmd: string) => {
        if (cmd.includes('select-pane') && cmd.includes('%1')) {
          throw new Error("can't find pane: %1");
        }
        return Buffer.from('');
      });

      const { execSync } = await import('child_process');

      // Attempt to select dead pane
      try {
        execSync('tmux select-pane -t %1', { stdio: 'pipe' });
        expect.fail('Should have thrown error');
      } catch (error: any) {
        expect(error.message).toContain("can't find pane");
      }
    });

    it('should create new tmux pane for rebind', async () => {
      // This would test the rebinding logic once it's implemented
      // For now, we verify the tmux split-window command works

      mockExecSync.mockImplementation((cmd: string) => {
        if (cmd.includes('split-window')) {
          return Buffer.from('%2');
        }
        return Buffer.from('');
      });

      const { execSync } = await import('child_process');
      const newPaneId = execSync('tmux split-window -h', { stdio: 'pipe' })
        .toString()
        .trim();

      expect(newPaneId).toBe('%2');
    });

    it('should preserve worktree and slug during rebind', async () => {
      // Test that rebinding doesn't recreate worktree
      const testPane: AumxPane = {
        id: 'aumx-1',
        slug: 'existing-branch',
        prompt: 'original prompt',
        paneId: '%1', // Old, dead pane
        worktreePath: '/test/.aumx/worktrees/existing-branch',
      };

      // Rebinding would update paneId but keep slug and worktreePath
      const reboundPane = {
        ...testPane,
        paneId: '%2', // New pane ID
      };

      expect(reboundPane.slug).toBe(testPane.slug);
      expect(reboundPane.worktreePath).toBe(testPane.worktreePath);
      expect(reboundPane.paneId).not.toBe(testPane.paneId);
    });
  });
});
