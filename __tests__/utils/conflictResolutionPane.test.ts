import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createConflictResolutionPane,
  disposeConflictResolutionPane,
} from '../../src/utils/conflictResolutionPane.js';
import { assertClaudeFullscreenSupported } from '../../src/utils/claudeVersion.js';
import { execAsync, execAsyncWithStatus } from '../../src/utils/execAsync.js';
import { launchAgentInPane } from '../../src/utils/paneAgentLaunch.js';
import { resizePaneBeforeAgentLaunch } from '../../src/utils/paneTerminalGeometry.js';
import { removePaneTranscript, setupPaneTranscript } from '../../src/utils/tmuxTranscript.js';

const mockTmuxInstance = vi.hoisted(() => ({
  getPaneSessionName: vi.fn(async () => 'muxbase-project'),
  killPane: vi.fn(async () => undefined),
  newWindowPane: vi.fn(async () => '%9'),
  setPaneTitle: vi.fn(async () => undefined),
}));

const mockSettings = vi.hoisted(() => ({
  current: {
    permissionMode: 'auto' as const,
    claudeFullscreenRendering: false,
    claudeModel: 'opus',
    claudeEffort: 'high',
  },
}));

const settingsRoots = vi.hoisted(() => [] as string[]);

vi.mock('../../src/utils/execAsync.js', () => ({
  execAsync: vi.fn(async () => 'src/conflicted.ts'),
  execAsyncWithStatus: vi.fn(),
}));

vi.mock('../../src/services/LogService.js', () => ({
  LogService: { getInstance: () => ({ info: vi.fn(), warn: vi.fn() }) },
}));

vi.mock('../../src/services/TmuxService.js', () => ({
  TmuxService: { getInstance: () => mockTmuxInstance },
}));

vi.mock('../../src/utils/settingsManager.js', () => ({
  SettingsManager: class {
    constructor(projectRoot: string) {
      settingsRoots.push(projectRoot);
    }

    getSettings() {
      return mockSettings.current;
    }
  },
}));

vi.mock('../../src/utils/paneAgentLaunch.js', () => ({
  launchAgentInPane: vi.fn(async () => undefined),
}));

vi.mock('../../src/utils/claudeVersion.js', () => ({
  assertClaudeFullscreenSupported: vi.fn(async () => undefined),
}));

vi.mock('../../src/utils/paneTerminalGeometry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/utils/paneTerminalGeometry.js')>();
  return {
    ...actual,
    resizePaneBeforeAgentLaunch: vi.fn(async () => undefined),
  };
});

vi.mock('../../src/utils/tmuxTranscript.js', () => ({
  removePaneTranscript: vi.fn(),
  setupPaneTranscript: vi.fn(async () => '/logs/terminal/tmux-9-conflict.ansi'),
}));

function baseOptions() {
  return {
    sourceTmuxPaneId: '%3',
    sourceBranch: 'feature',
    targetBranch: 'main',
    targetRepoPath: '/tmp/repo',
    projectRoot: '/workspace/main-project',
    terminalTranscriptDir: '/logs/terminal',
    agent: 'claude' as const,
    otlpEndpoint: 'http://127.0.0.1:4318',
  };
}

describe('createConflictResolutionPane', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    settingsRoots.length = 0;
    vi.mocked(execAsync).mockResolvedValue('src/conflicted.ts');
    vi.mocked(execAsyncWithStatus).mockImplementation(async (command) => ({
      stdout: command.includes("'HEAD'")
        ? 'source-commit'
        : command.includes("'main^{commit}'") || command.includes('MERGE_HEAD')
          ? 'target-commit'
          : '',
      stderr: command.includes("-- 'main'") ? 'CONFLICT' : '',
      exitCode: command.includes("-- 'main'") ? 1 : 0,
      timedOut: false,
    }));
    mockSettings.current = {
      permissionMode: 'auto',
      claudeFullscreenRendering: false,
      claudeModel: 'opus',
      claudeEffort: 'high',
    };
  });

  it('creates an isolated window in the source pane session', async () => {
    const { pane } = await createConflictResolutionPane(baseOptions());

    expect(mockTmuxInstance.getPaneSessionName).toHaveBeenCalledWith('%3');
    expect(mockTmuxInstance.newWindowPane).toHaveBeenCalledWith({
      cwd: '/tmp/repo',
      name: 'merge-feature-into-main',
      sessionName: 'muxbase-project',
    });
    expect(pane.paneId).toBe('%9');
  });

  it('prepares the merge and fixed geometry before the shared launch pipeline', async () => {
    const { pane, preparation } = await createConflictResolutionPane(baseOptions());

    expect(execAsyncWithStatus).toHaveBeenCalledWith('git merge --abort', expect.objectContaining({
      cwd: '/tmp/repo',
    }));
    expect(execAsyncWithStatus).toHaveBeenCalledWith(
      "git merge --no-commit --no-ff --no-edit -- 'main'",
      expect.objectContaining({
      cwd: '/tmp/repo',
      }),
    );
    expect(resizePaneBeforeAgentLaunch).toHaveBeenCalledWith('%9', { cols: 100 });
    expect(setupPaneTranscript).toHaveBeenCalledWith({
      filenamePrefix: 'merge-feature-into-main',
      paneId: '%9',
      transcriptDir: '/logs/terminal',
    });
    expect(vi.mocked(setupPaneTranscript).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(launchAgentInPane).mock.invocationCallOrder[0]);
    expect(vi.mocked(resizePaneBeforeAgentLaunch).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(launchAgentInPane).mock.invocationCallOrder[0]);

    expect(launchAgentInPane).toHaveBeenCalledWith({
      agent: 'claude',
      agentPrompt: pane.prompt,
      muxbasePaneId: pane.id,
      cwd: '/tmp/repo',
      paneId: '%9',
      otlpEndpoint: 'http://127.0.0.1:4318',
      projectRoot: '/workspace/main-project',
      promptMode: 'argument',
      settings: mockSettings.current,
      slug: 'merge-feature-into-main',
      terminalProfile: { claudeRenderer: 'classic', terminalFixedCols: 100 },
      tmuxService: mockTmuxInstance,
    });
    expect(pane).toMatchObject({
      agent: 'claude',
      claudeRenderer: 'classic',
      terminalTranscriptPath: '/logs/terminal/tmux-9-conflict.ansi',
      terminalFixedCols: 100,
    });
    expect(preparation).toEqual({
      repoPath: '/tmp/repo',
      sourceCommit: 'source-commit',
      targetCommit: 'target-commit',
    });
    expect(execAsyncWithStatus).toHaveBeenCalledWith(
      "git rev-parse --verify 'HEAD'",
      expect.objectContaining({ cwd: '/tmp/repo' }),
    );
    expect(execAsyncWithStatus).toHaveBeenCalledWith(
      "git rev-parse --verify 'main^{commit}'",
      expect.objectContaining({ cwd: '/tmp/repo' }),
    );
    expect(settingsRoots).toEqual(['/workspace/main-project']);
  });

  it('keeps fullscreen Claude and non-Claude conflict panes fluid-width', async () => {
    mockSettings.current.claudeFullscreenRendering = true;
    const { pane: fullscreen } = await createConflictResolutionPane(baseOptions());

    expect(fullscreen).toMatchObject({ claudeRenderer: 'fullscreen' });
    expect(fullscreen.terminalFixedCols).toBeUndefined();
    expect(resizePaneBeforeAgentLaunch).not.toHaveBeenCalled();

    vi.clearAllMocks();
    const { pane: codex } = await createConflictResolutionPane({ ...baseOptions(), agent: 'codex' });

    expect(codex.claudeRenderer).toBeUndefined();
    expect(codex.terminalFixedCols).toBeUndefined();
    expect(resizePaneBeforeAgentLaunch).not.toHaveBeenCalled();
    expect(launchAgentInPane).toHaveBeenCalledWith(expect.objectContaining({
      agent: 'codex',
      settings: mockSettings.current,
    }));
  });

  it('rejects unsupported fullscreen Claude before preparing the merge or creating a window', async () => {
    mockSettings.current.claudeFullscreenRendering = true;
    vi.mocked(assertClaudeFullscreenSupported).mockRejectedValueOnce(new Error('unsupported Claude'));

    await expect(createConflictResolutionPane(baseOptions())).rejects.toThrow('unsupported Claude');

    expect(execAsyncWithStatus).not.toHaveBeenCalled();
    expect(mockTmuxInstance.newWindowPane).not.toHaveBeenCalled();
    expect(launchAgentInPane).not.toHaveBeenCalled();
  });

  it('kills the isolated pane when launch fails', async () => {
    vi.mocked(launchAgentInPane).mockRejectedValueOnce(new Error('launch failed'));

    await expect(createConflictResolutionPane(baseOptions())).rejects.toThrow('launch failed');
    expect(mockTmuxInstance.killPane).toHaveBeenCalledWith('%9');
    expect(removePaneTranscript).toHaveBeenCalledWith('/logs/terminal/tmux-9-conflict.ansi');
    expect(vi.mocked(execAsyncWithStatus).mock.calls.filter((call) => (
      call[0] === 'git merge --abort'
    ))).toHaveLength(2);
  });

  it('releases the pane, merge transaction, and transcript after managed setup fails', async () => {
    const creation = await createConflictResolutionPane(baseOptions());

    await disposeConflictResolutionPane(creation);

    expect(mockTmuxInstance.killPane).toHaveBeenCalledWith('%9');
    expect(removePaneTranscript).toHaveBeenCalledWith('/logs/terminal/tmux-9-conflict.ansi');
    expect(vi.mocked(execAsyncWithStatus).mock.calls.filter((call) => (
      call[0] === 'git merge --abort'
    ))).toHaveLength(2);
  });

  it('aborts the prepared merge when isolated window creation fails', async () => {
    mockTmuxInstance.newWindowPane.mockRejectedValueOnce(new Error('window failed'));

    await expect(createConflictResolutionPane(baseOptions())).rejects.toThrow('window failed');
    expect(mockTmuxInstance.killPane).not.toHaveBeenCalled();
    expect(vi.mocked(execAsyncWithStatus).mock.calls.filter((call) => (
      call[0] === 'git merge --abort'
    ))).toHaveLength(2);
  });

  it('rejects merge failures that do not leave unresolved files', async () => {
    vi.mocked(execAsync).mockResolvedValueOnce('');

    await expect(createConflictResolutionPane(baseOptions()))
      .rejects.toThrow('failed without unresolved files');
    expect(mockTmuxInstance.newWindowPane).not.toHaveBeenCalled();
    expect(vi.mocked(execAsyncWithStatus).mock.calls.filter((call) => (
      call[0] === 'git merge --abort'
    ))).toHaveLength(2);
  });

  it('aborts a clean non-committing merge instead of leaving a merge commit behind', async () => {
    vi.mocked(execAsyncWithStatus).mockImplementation(async (command) => ({
      stdout: command.includes('rev-parse') ? 'resolved-commit' : '',
      stderr: '',
      exitCode: 0,
      timedOut: false,
    }));

    await expect(createConflictResolutionPane(baseOptions()))
      .rejects.toThrow('completed without conflicts');

    expect(execAsyncWithStatus).toHaveBeenCalledWith(
      "git merge --no-commit --no-ff --no-edit -- 'main'",
      expect.any(Object),
    );
    expect(vi.mocked(execAsyncWithStatus).mock.calls.filter((call) => (
      call[0] === 'git merge --abort'
    ))).toHaveLength(2);
    expect(mockTmuxInstance.newWindowPane).not.toHaveBeenCalled();
  });

  it('does not start a new merge when an existing merge cannot be reset', async () => {
    vi.mocked(execAsyncWithStatus).mockImplementation(async (command) => ({
      stdout: command.includes('rev-parse') ? 'existing-merge-head' : '',
      stderr: command === 'git merge --abort' ? 'cannot abort' : '',
      exitCode: command === 'git merge --abort' ? 1 : 0,
      timedOut: false,
    }));

    await expect(createConflictResolutionPane(baseOptions()))
      .rejects.toThrow('Cannot reset existing merge');

    expect(execAsyncWithStatus).not.toHaveBeenCalledWith(
      expect.stringContaining('git merge --no-commit'),
      expect.any(Object),
    );
    expect(mockTmuxInstance.newWindowPane).not.toHaveBeenCalled();
  });

  it('fails before creating a window when the source pane session is unavailable', async () => {
    mockTmuxInstance.getPaneSessionName.mockResolvedValueOnce('');

    await expect(createConflictResolutionPane(baseOptions()))
      .rejects.toThrow('Cannot resolve tmux session');
    expect(mockTmuxInstance.newWindowPane).not.toHaveBeenCalled();
  });
});
