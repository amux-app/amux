import type { AgentName, AumxPane } from 'aumx/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const core = vi.hoisted(() => ({
  assertClaudeFullscreenSupported: vi.fn(),
  createPane: vi.fn(),
  settings: { initGitIfMissing: true, useWorktree: false },
  triggerHook: vi.fn(),
}));

const git = vi.hoisted(() => ({
  ensureGitRepository: vi.fn(),
}));

vi.mock('aumx/core', async () => {
  const actual = await vi.importActual<typeof import('aumx/core')>('aumx/core');
  return {
    ...actual,
    assertClaudeFullscreenSupported: core.assertClaudeFullscreenSupported,
    createPane: core.createPane,
    resolvePaneTerminalProfile: vi.fn((agent: AgentName | undefined) => (
      agent === 'claude' ? { claudeRenderer: 'fullscreen' } : {}
    )),
    SettingsManager: { getInstance: () => ({ getSettings: () => core.settings }) },
    triggerHook: core.triggerHook,
  };
});

vi.mock('../../src/main/services/GitRepositoryBootstrap.js', () => ({
  ensureGitRepository: git.ensureGitRepository,
}));

import { PaneLaunchWorkflow } from '../../src/main/services/bridge/PaneLaunchWorkflow.js';

function makePane(overrides: Partial<AumxPane> = {}): AumxPane {
  return {
    agent: 'codex',
    id: 'pane',
    paneId: '%1',
    projectRoot: '/project',
    slug: 'feature',
    ...overrides,
  };
}

function makeHarness(active = true, availableAgents: AgentName[] = ['codex']) {
  let panes: AumxPane[] = [];
  const dependencies = {
    createPaneCoordinated: vi.fn(async () => ({ success: true, pane: makePane() })),
    decorateCreatedPane: vi.fn((pane: AumxPane) => pane),
    detectAvailableAgents: vi.fn(async () => undefined),
    emitEarlyPane: vi.fn(),
    ensureValidControlPaneId: vi.fn(async () => false),
    getAvailableAgents: vi.fn(() => availableAgents),
    getConfigPath: vi.fn(() => '/project/.amux/aumx.config.json'),
    getControlPaneId: vi.fn(() => '%0'),
    getInitialTerminalSize: vi.fn(() => ({ cols: 120, rows: 40 })),
    getOtlpEndpoint: vi.fn(() => undefined),
    getPanes: vi.fn(() => panes),
    getProjectRoot: vi.fn(() => '/project'),
    getSessionName: vi.fn(() => 'aumx-project'),
    getTerminalTranscriptDir: vi.fn(() => '/logs'),
    hasAvailableAgentsCache: vi.fn(() => true),
    hasActiveProjectContext: vi.fn(() => active),
    killPane: vi.fn(async () => undefined),
    lifecycleAdaptersEnabled: vi.fn(() => true),
    maybeRequestExperimentalPaneTitle: vi.fn(async () => undefined),
    newWindowPane: vi.fn(async () => '%9'),
    publishSessionColorHint: vi.fn(async () => undefined),
    removeEarlyPane: vi.fn(),
    resumePaneWatcher: vi.fn(),
    savePane: vi.fn((pane: AumxPane) => { panes = [...panes, pane]; }),
    sendProgress: vi.fn(),
    sendToast: vi.fn(),
    setPaneTitleSafe: vi.fn(async () => undefined),
    setupTranscriptPiping: vi.fn(async () => '/logs/pane.log'),
    startPaneMonitor: vi.fn(async () => true),
    startSessionTracking: vi.fn(),
    suspendPaneWatcher: vi.fn(),
  };
  return { dependencies, getPanes: () => panes, workflow: new PaneLaunchWorkflow(dependencies) };
}

describe('PaneLaunchWorkflow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    core.settings.initGitIfMissing = true;
    core.settings.useWorktree = false;
    core.assertClaudeFullscreenSupported.mockResolvedValue(undefined);
    core.triggerHook.mockResolvedValue(undefined);
    git.ensureGitRepository.mockResolvedValue({ initialized: false, isReady: true });
    core.createPane.mockResolvedValue({ pane: makePane() });
  });

  it('rejects agent pane creation without an active project', async () => {
    const harness = makeHarness(false);

    await expect(harness.workflow.create('prompt', 'codex')).resolves.toEqual({
      success: false,
      error: 'Choose or create a project before starting panes.',
    });
    expect(core.createPane).not.toHaveBeenCalled();
  });

  it('fails before watcher suspension when fullscreen Claude is unsupported', async () => {
    const harness = makeHarness(true, ['claude']);
    core.assertClaudeFullscreenSupported.mockRejectedValue(new Error('upgrade Claude'));

    await expect(harness.workflow.create('prompt', 'claude')).resolves.toMatchObject({
      success: false,
      error: 'upgrade Claude',
      claudeFullscreenPreflightFailed: true,
    });
    expect(harness.dependencies.suspendPaneWatcher).not.toHaveBeenCalled();
  });

  it('blocks worktree launch when Git cannot be prepared', async () => {
    const harness = makeHarness();
    git.ensureGitRepository.mockResolvedValue({ initialized: false, isReady: false });

    await expect(harness.workflow.create('prompt', 'codex', { useWorktree: true }))
      .resolves.toMatchObject({ success: false, error: expect.stringContaining('Git') });
    expect(core.createPane).not.toHaveBeenCalled();
  });

  it('saves a successful pane before resuming watcher synchronization', async () => {
    const harness = makeHarness();
    harness.dependencies.resumePaneWatcher.mockImplementation(() => {
      expect(harness.getPanes()).toHaveLength(1);
    });

    await expect(harness.workflow.create('prompt', 'codex')).resolves.toMatchObject({
      success: true,
      pane: { id: 'pane' },
    });
    expect(harness.dependencies.suspendPaneWatcher).toHaveBeenCalledOnce();
    expect(harness.dependencies.resumePaneWatcher).toHaveBeenCalledOnce();
    expect(harness.dependencies.startSessionTracking).toHaveBeenCalledOnce();
  });

  it('forwards early pane lifecycle callbacks to the bridge boundary', async () => {
    const harness = makeHarness();

    await harness.workflow.create('prompt', 'codex');
    const createOptions = core.createPane.mock.calls[0]?.[0] as {
      earlyEmit: {
        onReady(pane: AumxPane): void;
        onRollback(paneId: string): void;
      };
    };
    const earlyPane = makePane({ id: 'early-pane' });

    createOptions.earlyEmit.onReady(earlyPane);
    createOptions.earlyEmit.onRollback('early-pane');

    expect(harness.dependencies.emitEarlyPane).toHaveBeenCalledWith(
      earlyPane,
      undefined,
      undefined,
      'Prompt',
    );
    expect(harness.dependencies.removeEarlyPane).toHaveBeenCalledWith('early-pane');
  });

  it('restores watcher state when core creation requires an agent choice', async () => {
    const harness = makeHarness(true, ['claude', 'codex']);
    core.createPane.mockResolvedValue({ needsAgentChoice: true });

    await expect(harness.workflow.create('prompt')).resolves.toEqual({
      success: false,
      needsAgentChoice: true,
      availableAgents: ['claude', 'codex'],
    });
    expect(harness.dependencies.resumePaneWatcher).toHaveBeenCalledOnce();
    expect(harness.dependencies.sendProgress).toHaveBeenLastCalledWith('Creating pane...', false);
    expect(harness.dependencies.savePane).not.toHaveBeenCalled();
  });

  it('restores watcher and progress state when core pane creation throws', async () => {
    const harness = makeHarness();
    core.createPane.mockRejectedValue(new Error('tmux failed'));

    await expect(harness.workflow.create('prompt', 'codex')).resolves.toEqual({
      success: false,
      error: 'tmux failed',
      claudeFullscreenPreflightFailed: false,
    });
    expect(harness.dependencies.resumePaneWatcher).toHaveBeenCalledOnce();
    expect(harness.dependencies.sendProgress).toHaveBeenLastCalledWith('Creating pane...', false);
  });

  it('clears progress when control-pane preparation fails before watcher suspension', async () => {
    const harness = makeHarness();
    harness.dependencies.ensureValidControlPaneId.mockRejectedValue(new Error('tmux unavailable'));

    await expect(harness.workflow.create('prompt', 'codex')).resolves.toEqual({
      success: false,
      error: 'tmux unavailable',
      claudeFullscreenPreflightFailed: false,
    });
    expect(harness.dependencies.suspendPaneWatcher).not.toHaveBeenCalled();
    expect(harness.dependencies.resumePaneWatcher).not.toHaveBeenCalled();
    expect(harness.dependencies.sendProgress).toHaveBeenLastCalledWith('Creating pane...', false);
  });

  it('clears progress when publishing the session color fails before watcher suspension', async () => {
    const harness = makeHarness();
    harness.dependencies.publishSessionColorHint.mockRejectedValue(new Error('tmux unavailable'));

    await expect(harness.workflow.create('prompt', 'codex')).resolves.toEqual({
      success: false,
      error: 'tmux unavailable',
      claudeFullscreenPreflightFailed: false,
    });
    expect(harness.dependencies.suspendPaneWatcher).not.toHaveBeenCalled();
    expect(harness.dependencies.resumePaneWatcher).not.toHaveBeenCalled();
    expect(harness.dependencies.sendProgress).toHaveBeenLastCalledWith('Creating pane...', false);
  });

  it('reports success when monitor refresh fails after an agent pane is persisted', async () => {
    const harness = makeHarness();
    harness.dependencies.startPaneMonitor.mockRejectedValue(new Error('monitor unavailable'));

    await expect(harness.workflow.create('prompt', 'codex')).resolves.toMatchObject({
      success: true,
      pane: { id: 'pane' },
    });
    expect(harness.getPanes()).toHaveLength(1);
    expect(harness.dependencies.resumePaneWatcher).toHaveBeenCalledOnce();
    expect(harness.dependencies.sendProgress).toHaveBeenLastCalledWith('Creating pane...', false);
  });

  it('creates and persists a terminal-only pane with transcript metadata', async () => {
    const harness = makeHarness();

    await expect(harness.workflow.createTerminal()).resolves.toMatchObject({
      success: true,
      pane: { projectRoot: '/project', terminalTranscriptPath: '/logs/pane.log', type: 'shell' },
    });
    expect(harness.dependencies.newWindowPane)
      .toHaveBeenCalledWith({ cwd: '/project', sessionName: 'aumx-project' });
    expect(harness.getPanes()).toHaveLength(1);
  });

  it('restores watcher and progress state when terminal creation fails', async () => {
    const harness = makeHarness();
    harness.dependencies.newWindowPane.mockRejectedValue(new Error('tmux unavailable'));

    await expect(harness.workflow.createTerminal()).resolves.toEqual({
      success: false,
      error: 'tmux unavailable',
    });
    expect(harness.dependencies.resumePaneWatcher).toHaveBeenCalledOnce();
    expect(harness.dependencies.sendProgress)
      .toHaveBeenLastCalledWith('Creating terminal...', false);
  });

  it('clears terminal progress when control-pane preparation fails', async () => {
    const harness = makeHarness();
    harness.dependencies.ensureValidControlPaneId.mockRejectedValue(new Error('tmux unavailable'));

    await expect(harness.workflow.createTerminal()).resolves.toEqual({
      success: false,
      error: 'tmux unavailable',
    });
    expect(harness.dependencies.suspendPaneWatcher).not.toHaveBeenCalled();
    expect(harness.dependencies.resumePaneWatcher).not.toHaveBeenCalled();
    expect(harness.dependencies.sendProgress)
      .toHaveBeenLastCalledWith('Creating terminal...', false);
  });

  it('kills an uncommitted terminal pane when post-allocation setup fails', async () => {
    const harness = makeHarness();
    harness.dependencies.setupTranscriptPiping.mockRejectedValue(new Error('pipe failed'));

    await expect(harness.workflow.createTerminal()).resolves.toEqual({
      success: false,
      error: 'pipe failed',
    });
    expect(harness.dependencies.killPane).toHaveBeenCalledWith('%9');
    expect(harness.getPanes()).toHaveLength(0);
  });

  it('reports success and retains a terminal pane when monitor refresh fails after persistence', async () => {
    const harness = makeHarness();
    harness.dependencies.startPaneMonitor.mockRejectedValue(new Error('monitor unavailable'));

    await expect(harness.workflow.createTerminal()).resolves.toMatchObject({
      success: true,
      pane: { paneId: '%9', type: 'shell' },
    });
    expect(harness.dependencies.killPane).not.toHaveBeenCalled();
    expect(harness.getPanes()).toHaveLength(1);
  });

  it('duplicates an existing pane through the coordinated facade and rejects missing panes', async () => {
    const harness = makeHarness();
    core.createPane.mockResolvedValue({ pane: makePane({ prompt: 'original prompt' }) });
    await harness.workflow.create('original prompt', 'codex');
    harness.dependencies.createPaneCoordinated.mockResolvedValue({
      success: true,
      pane: makePane({ id: 'duplicate' }),
    });

    await expect(harness.workflow.duplicate('pane')).resolves.toMatchObject({
      success: true,
      pane: { id: 'duplicate' },
    });
    expect(harness.dependencies.createPaneCoordinated)
      .toHaveBeenCalledWith('original prompt', 'codex');
    await expect(harness.workflow.duplicate('missing')).resolves.toEqual({
      success: false,
      error: 'Pane not found',
    });
  });
});
