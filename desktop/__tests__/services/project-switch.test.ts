/**
 * Integration test for the project-switch race surface.
 *
 * AumxBridge.switchProject() tears down per-project services, swaps the action
 * callback registry, and purges StateManager panes before booting the new
 * project. These tests exercise that lifecycle and the concurrency guards that
 * protect it when an operation (e.g. a pane creation) is in flight.
 */
import {
  assertClaudeFullscreenSupported,
  atomicWriteJsonSync,
  createPane as coreCreatePane,
  execAsync as coreExecAsync,
  getAvailableAgents as coreGetAvailableAgents,
  isAgentRunningInPane,
  readRegisteredSession,
  resumeAgentInPane,
  type AgentName,
  triggerHook,
} from 'aumx/core';
import type { BrowserWindow } from 'electron';
import { accessSync, constants, existsSync, mkdirSync, readFileSync, statSync } from 'fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_EVENT } from '../../src/shared/ipc-channels';
import type { PaneActivity, PaneActivityChangedEvent } from '../../src/shared/pane-activity';

const coreState = vi.hoisted(() => {
  const panes: unknown[] = [];
  return {
    panes,
    updatePanes: vi.fn((next: unknown[]) => {
      panes.length = 0;
      panes.push(...next);
    }),
    updateProjectInfo: vi.fn(),
    getPanes: vi.fn(() => panes),
    getPaneById: vi.fn((id: string) => panes.find((pane) => (
      pane as { id?: string }
    ).id === id)),
    getRunningAgentPanes: vi.fn().mockResolvedValue(new Set<string>()),
    listConflictMergeTransactions: vi.fn().mockReturnValue([]),
    logService: {
      setSuppressConsole: vi.fn(),
      on: vi.fn(),
      off: vi.fn(),
      removeListener: vi.fn(),
    },
    inspectPreservedWorktreeAsync: vi.fn(),
    listPreservedWorktreesAsync: vi.fn(),
    removePreservedWorktreeAsync: vi.fn(),
    tmuxService: {
      getPaneCurrentCommand: vi.fn().mockResolvedValue('zsh'),
      listAllPanes: vi.fn().mockResolvedValue([]),
      newWindowPane: vi.fn().mockResolvedValue('%42'),
      newWindowPaneSync: vi.fn(() => '%42'),
      paneExists: vi.fn().mockResolvedValue(true),
      setPaneTitle: vi.fn().mockResolvedValue(undefined),
    },
    statusDetector: {
      removePane: vi.fn(),
    },
  };
});

vi.mock('electron', () => ({
  BrowserWindow: class {},
}));

vi.mock('@electron-toolkit/utils', () => ({
  is: { dev: false },
}));

vi.mock('aumx/core', () => ({
  assertClaudeFullscreenSupported: vi.fn().mockResolvedValue(undefined),
  LogService: { getInstance: () => coreState.logService },
  SettingsManager: { getInstance: () => ({ getSettings: () => ({ claudeFullscreenRendering: true }) }) },
  TmuxService: { getInstance: () => coreState.tmuxService },
  StateManager: {
    getInstance: () => ({
      updatePanes: coreState.updatePanes,
      updateProjectInfo: coreState.updateProjectInfo,
      getPanes: coreState.getPanes,
      getPaneById: coreState.getPaneById,
    }),
  },
  getAvailableAgents: vi.fn().mockResolvedValue(['claude']),
  generateLocalSlug: vi.fn(() => 'compare-implementations'),
  condenseTitleLocally: condenseTitleLocallyMock,
  normalizeAutomaticPaneTitle: normalizeAutomaticPaneTitleMock,
  parseAumxConfig: vi.fn((value: unknown) => value),
  inspectPreservedWorktreeAsync: coreState.inspectPreservedWorktreeAsync,
  listPreservedWorktreesAsync: coreState.listPreservedWorktreesAsync,
  removePreservedWorktreeAsync: coreState.removePreservedWorktreeAsync,
  getRunningAgentPanes: coreState.getRunningAgentPanes,
  listConflictMergeTransactions: coreState.listConflictMergeTransactions,
  getProjectConfigPath: (projectRoot: string) => `${projectRoot}/.amux/aumx.config.json`,
  getPaneActivityJournalPath: (incarnationId: string) => `/tmp/aumx-activity-${incarnationId}.ndjson`,
  getProjectMetadataDir: (projectRoot: string) => `${projectRoot}/.amux`,
  getProjectMetadataPath: (projectRoot: string, ...segments: string[]) => (
    [projectRoot, '.amux', ...segments].join('/')
  ),
  reconcilePaneWorktrees: vi.fn().mockImplementation(async (panes: unknown) => ({ panes, attached: 0 })),
  createPane: vi.fn(),
  createWorktreeForPane: vi.fn(),
  closePane: vi.fn(),
  mergePane: vi.fn(),
  renamePane: vi.fn(),
  resolvePaneTerminalProfile: vi.fn((agent: string | undefined, settings: { claudeFullscreenRendering?: boolean }) => (
    agent === 'claude'
      ? settings.claudeFullscreenRendering === false
        ? { claudeRenderer: 'classic', terminalFixedCols: 100 }
        : { claudeRenderer: 'fullscreen' }
      : {}
  )),
  isAgentRunningInPane: vi.fn(),
  isShellCommand: vi.fn((command: string) => ['bash', 'zsh', 'sh'].includes(command)),
  readRegisteredSession: vi.fn(() => ({
    paneId: 'pane-classic',
    sessionId: 'session-exact',
    transcriptPath: '/tmp/session.jsonl',
    updatedAt: 1,
  })),
  resumeAgentInPane: vi.fn().mockResolvedValue(true),
  execAsync: vi.fn().mockResolvedValue(''),
  shQuote: (s: string) => `'${s}'`,
  atomicWriteJsonSync: vi.fn(),
  triggerHook: vi.fn().mockResolvedValue(undefined),
  ensureAumxGitignore: vi.fn().mockResolvedValue(undefined),
  getStatusDetector: () => coreState.statusDetector,
  TMUX_SHELL_READY_DELAY: 0,
}));

vi.mock('../../src/main/services/Logger.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), getLogDir: () => null },
}));

const condenseTitleLocallyMock = vi.hoisted(() => vi.fn((text: string) => `condensed:${text.slice(0, 12)}`));
const normalizeAutomaticPaneTitleMock = vi.hoisted(() => vi.fn((text: string) => {
  const normalized = text.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').replace(/^[✳\s"]+|[✳\s".]+$/g, '');
  return normalized && !/^new session\b/i.test(normalized) ? normalized : null;
}));
const requestExperimentalOpenRouterTitleMock = vi.hoisted(() => vi.fn().mockResolvedValue(null));

const displayPaneFormatMock = vi.hoisted(() => vi.fn().mockResolvedValue(''));
const paneMonitorState = vi.hoisted(() => ({
  onStatusDetected: null as ((event: { paneId: string; status: string }) => void) | null,
}));
const paneMonitorSpies = { start: vi.fn().mockResolvedValue(undefined), stop: vi.fn().mockResolvedValue(undefined), setWindow: vi.fn() };
const configBridgeSpies = { start: vi.fn().mockResolvedValue(undefined), stop: vi.fn(), setWindow: vi.fn() };
const agentSessionSpies = { shutdown: vi.fn(), setWindow: vi.fn(), onPaneCreated: vi.fn().mockResolvedValue(undefined), onPaneDestroyed: vi.fn() };
const fileBrowserWatchSpies = { stop: vi.fn().mockResolvedValue(undefined), setWindow: vi.fn() };
const terminalStreamSpies = vi.hoisted(() => ({
  detachPane: vi.fn(),
  getPreferredSize: vi.fn(() => null),
  reset: vi.fn(),
  submitCommand: vi.fn().mockResolvedValue(true),
}));
const sweepTranscriptRolloversMock = vi.hoisted(() => vi.fn().mockResolvedValue(0));

// PaneWatcher returns a fresh instance per `new` so tests can distinguish the
// watcher an in-flight createPane is holding from the one a switch boots.
interface PaneWatcherInstance {
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  setWindow: ReturnType<typeof vi.fn>;
  suspendSync: ReturnType<typeof vi.fn>;
  resumeSync: ReturnType<typeof vi.fn>;
}
const paneWatcherInstances: PaneWatcherInstance[] = [];
function makePaneWatcherInstance(): PaneWatcherInstance {
  const instance: PaneWatcherInstance = {
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    setWindow: vi.fn(),
    suspendSync: vi.fn(),
    resumeSync: vi.fn(),
  };
  paneWatcherInstances.push(instance);
  return instance;
}

vi.mock('../../src/main/services/PaneMonitor.js', () => ({
  PaneMonitor: vi.fn().mockImplementation((
    onStatusDetected: (event: { paneId: string; status: string }) => void,
  ) => {
    paneMonitorState.onStatusDetected = onStatusDetected;
    return paneMonitorSpies;
  }),
}));
vi.mock('../../src/main/services/PaneWatcher.js', () => ({
  PaneWatcher: vi.fn().mockImplementation(() => makePaneWatcherInstance()),
}));
vi.mock('../../src/main/services/ConfigBridge.js', () => ({
  ConfigBridge: vi.fn().mockImplementation(() => configBridgeSpies),
}));
vi.mock('../../src/main/services/agent-session/AgentSessionService.js', () => ({
  AgentSessionService: vi.fn().mockImplementation(() => agentSessionSpies),
}));
vi.mock('../../src/main/services/terminal-stream-state.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/main/services/terminal-stream-state')>(),
  displayPaneFormat: displayPaneFormatMock,
}));
vi.mock('../../src/main/services/FileBrowserWatchService.js', () => ({
  FileBrowserWatchService: vi.fn().mockImplementation(() => fileBrowserWatchSpies),
}));
vi.mock('../../src/main/services/TerminalStreamService.js', () => ({
  detachTerminalPane: terminalStreamSpies.detachPane,
  getPreferredTerminalLaunchSize: terminalStreamSpies.getPreferredSize,
  getTerminalManager: vi.fn(() => ({ submitCommand: terminalStreamSpies.submitCommand })),
  resetTerminalManager: terminalStreamSpies.reset,
}));
vi.mock('../../src/main/services/transcript-rollover.js', () => ({
  sweepTranscriptRollovers: sweepTranscriptRolloversMock,
}));
vi.mock('../../src/main/services/KanbanPersistenceService.js', () => ({
  KanbanPersistenceService: vi.fn(),
}));
vi.mock('../../src/main/services/title/ExperimentalOpenRouterTitle.js', () => ({
  requestExperimentalOpenRouterTitle: requestExperimentalOpenRouterTitleMock,
}));
vi.mock('../../src/main/services/ProjectDiscovery.js', () => ({
  discoverCurrentProject: vi.fn().mockResolvedValue(null),
}));
vi.mock('../../src/main/utils/tmuxSession.js', () => ({
  ensureTmuxSession: vi.fn().mockResolvedValue({ paneId: '%0', sessionName: 'aumx-test', created: false }),
  publishSessionColorHint: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../src/main/services/GitRepositoryBootstrap.js', () => ({
  ensureGitRepository: vi.fn().mockResolvedValue({ isReady: true, initialized: false }),
}));
vi.mock('fs', () => ({
  readFileSync: vi.fn(() => { throw new Error('no config'); }),
  existsSync: vi.fn(() => false),
  mkdirSync: vi.fn(),
  accessSync: vi.fn(),
  constants: { W_OK: 2 },
  statSync: vi.fn(() => ({ isDirectory: () => true })),
}));

import { AumxBridge } from '../../src/main/services/AumxBridge';
import { ActionCallbackRegistry } from '../../src/main/services/ActionCallbackRegistry';
import { AgentSessionService } from '../../src/main/services/agent-session/AgentSessionService.js';
import { ensureGitRepository } from '../../src/main/services/GitRepositoryBootstrap.js';
import { PaneActivityService } from '../../src/main/services/PaneActivityService.js';
import { PaneWatcher } from '../../src/main/services/PaneWatcher.js';
import { ensureTmuxSession, publishSessionColorHint } from '../../src/main/utils/tmuxSession.js';

interface BridgeInternals {
  agentCatalog: { getCached: () => string[] };
  backfillMissingPaneTitles: (
    panes: Array<{ id: string; paneId: string; prompt: string; slug: string; title?: string; titleLocked?: boolean }>,
  ) => Array<{ id: string; paneId: string; prompt: string; slug: string; title?: string; titleLocked?: boolean }>;
  buildActionContext: () => {
    onPaneRemove: (paneId: string) => void;
    otlpEndpoint?: string;
    savePanes: (panes: Array<{ id: string; paneId: string; prompt: string; slug: string }>) => Promise<void>;
  };
  callbackRegistry: ActionCallbackRegistry;
  configBridge: unknown | null;
  agentSessionService: unknown | null;
  handlePaneActivityChanged: (event: PaneActivityChangedEvent) => void;
  otlpReceiver: { getPort: () => number | null } | null;
  worktreeMutationPaths: Set<string>;
  switching: boolean;
  paneWatcher: PaneWatcherInstance | null;
  maybeRequestExperimentalPaneTitle: (paneId: string, sourceText: string) => Promise<void>;
  paneStreamStatusWatchers: Map<string, unknown>;
  paneActivityService: PaneActivityService | null;
  paneSummaryService: unknown | null;
  rolloverOversizedTranscripts: () => Promise<void>;
  savePaneToConfig: (pane: {
    agent: AgentName;
    agentStatus: 'idle' | 'working';
    id: string;
    lastAgentCheck: number;
    paneId: string;
    prompt: string;
    slug: string;
  }) => void;
  untrackablePanes: Set<string>;
  transcriptRolloverInterval: ReturnType<typeof setInterval> | null;
}

function resetSingleton(): void {
  // AumxBridge is a singleton with a private constructor — clear it so each
  // test starts from a clean instance.
  (AumxBridge as unknown as { instance: AumxBridge | undefined }).instance = undefined;
}

function asInternals(bridge: AumxBridge): BridgeInternals {
  return bridge as unknown as BridgeInternals;
}

function getStatusUpdatedHandler(): (event: { paneId: string; status: string }) => void {
  if (!paneMonitorState.onStatusDetected) {
    throw new Error('pane monitor status callback was never registered');
  }
  return paneMonitorState.onStatusDetected;
}

describe('AumxBridge.switchProject — project switch race surface', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(existsSync).mockReturnValue(false);
    vi.mocked(readFileSync).mockImplementation(() => { throw new Error('no config'); });
    vi.mocked(accessSync).mockReturnValue(undefined);
    vi.mocked(statSync).mockReturnValue({ isDirectory: () => true } as ReturnType<typeof statSync>);
    coreState.panes.length = 0;
    coreState.inspectPreservedWorktreeAsync.mockRejectedValue(new Error('not found'));
    coreState.listPreservedWorktreesAsync.mockResolvedValue([]);
    coreState.getRunningAgentPanes.mockResolvedValue(new Set());
    coreState.listConflictMergeTransactions.mockReturnValue([]);
    coreState.removePreservedWorktreeAsync.mockResolvedValue(undefined);
    coreState.tmuxService.listAllPanes.mockResolvedValue([]);
    coreState.tmuxService.getPaneCurrentCommand.mockResolvedValue('zsh');
    coreState.tmuxService.newWindowPaneSync.mockReturnValue('%42');
    coreState.tmuxService.newWindowPane.mockResolvedValue('%42');
    coreState.tmuxService.paneExists.mockResolvedValue(true);
    coreState.tmuxService.setPaneTitle.mockResolvedValue(undefined);
    paneMonitorState.onStatusDetected = null;
    paneWatcherInstances.length = 0;
    vi.mocked(isAgentRunningInPane).mockResolvedValue(false);
    vi.mocked(resumeAgentInPane).mockResolvedValue(true);
    fileBrowserWatchSpies.stop.mockResolvedValue(undefined);
    delete process.env.AUMX_EXPERIMENTAL_OPENROUTER_TITLES;
    delete process.env.AUMX_EXPERIMENTAL_OPENROUTER_TITLE_MODEL;
    delete process.env.OPENROUTER_API_KEY;
    resetSingleton();
  });

  it('injects the active OTLP receiver endpoint into action contexts', () => {
    const bridge = AumxBridge.getInstance();
    const internals = asInternals(bridge);
    internals.otlpReceiver = { getPort: () => 4318 };

    expect(internals.buildActionContext().otlpEndpoint).toBe('http://127.0.0.1:4318');
  });

  it('starts the transcript rollover interval and clears it during project teardown', async () => {
    const bridge = AumxBridge.getInstance();
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');

    try {
      await bridge.switchProject('/tmp/project-a');
      const firstInterval = asInternals(bridge).transcriptRolloverInterval;
      expect(firstInterval).not.toBeNull();

      await bridge.switchProject('/tmp/project-b');

      expect(clearIntervalSpy).toHaveBeenCalledWith(firstInterval);
      expect(asInternals(bridge).transcriptRolloverInterval).not.toBe(firstInterval);
    } finally {
      clearIntervalSpy.mockRestore();
    }
  });

  it('coalesces overlapping transcript rollover sweeps', async () => {
    const bridge = AumxBridge.getInstance();
    await bridge.switchProject('/tmp/project-a');
    coreState.panes.push({
      id: 'pane-a',
      paneId: '%7',
      terminalTranscriptPath: '/tmp/pane-a.ansi',
    });
    let finishSweep: () => void = () => {};
    sweepTranscriptRolloversMock.mockReturnValueOnce(new Promise<number>((resolve) => {
      finishSweep = () => resolve(1);
    }));

    const first = asInternals(bridge).rolloverOversizedTranscripts();
    const overlapping = asInternals(bridge).rolloverOversizedTranscripts();

    expect(overlapping).toBe(first);
    expect(sweepTranscriptRolloversMock).toHaveBeenCalledOnce();
    const [, options] = sweepTranscriptRolloversMock.mock.calls[0];
    await expect(options.isPaneAlive('%7')).resolves.toBe(true);
    expect(coreState.tmuxService.paneExists).toHaveBeenCalledWith('%7');

    finishSweep();
    await Promise.all([first, overlapping]);
  });

  it('rejects action persistence before exposing an uncommitted pane in memory', async () => {
    const bridge = AumxBridge.getInstance();
    await bridge.switchProject('/tmp/project-a');
    const existingPane = { id: 'existing', paneId: '%1', prompt: '', slug: 'existing' };
    const conflictPane = { id: 'conflict', paneId: '%9', prompt: 'resolve', slug: 'conflict' };
    coreState.panes.push(existingPane);
    coreState.updatePanes.mockClear();
    vi.mocked(atomicWriteJsonSync).mockImplementationOnce(() => {
      throw new Error('disk full');
    });

    await expect(asInternals(bridge).buildActionContext().savePanes([
      existingPane,
      conflictPane,
    ])).rejects.toThrow('disk full');

    expect(coreState.panes).toEqual([existingPane]);
    expect(coreState.updatePanes).not.toHaveBeenCalled();
  });

  it('switches project root and purges StateManager panes before booting the new project', async () => {
    // Arrange
    const bridge = AumxBridge.getInstance();
    coreState.panes.push({ id: 'stale-pane', slug: 'stale', prompt: '', paneId: '%1' });

    // Act
    await bridge.switchProject('/tmp/project-a');

    // Assert
    expect(bridge.getProjectRoot()).toBe('/tmp/project-a');
    expect(bridge.getProjectName()).toBe('project-a');
    // panes are wiped with updatePanes([]) before the new project's config loads
    expect(coreState.updatePanes).toHaveBeenCalledWith([]);
  });

  it('refuses to switch projects while a conflict merge is active', async () => {
    const bridge = AumxBridge.getInstance();
    await bridge.switchProject('/tmp/project-a');
    coreState.listConflictMergeTransactions.mockReturnValue([{
      id: 'conflict-1',
      repoPath: '/tmp/project-a/.amux/worktrees/feature',
      state: 'active',
    }]);
    terminalStreamSpies.reset.mockClear();

    await expect(bridge.switchProject('/tmp/project-b')).rejects.toThrow(
      'Resolve or abort active conflict merges before switching projects',
    );

    expect(bridge.getProjectRoot()).toBe('/tmp/project-a');
    expect(terminalStreamSpies.reset).not.toHaveBeenCalled();
    expect(asInternals(bridge).switching).toBe(false);
  });

  it('clears a partially booted project so the same switch can be retried', async () => {
    const bridge = AumxBridge.getInstance();
    vi.mocked(ensureTmuxSession).mockRejectedValueOnce(new Error('tmux unavailable'));

    await expect(bridge.switchProject('/tmp/project-a')).rejects.toThrow('tmux unavailable');

    expect(bridge.getProjectRoot()).toBe('');
    expect(bridge.getProjectName()).toBe('');
    expect(bridge.getSessionName()).toBe('');
    expect(coreState.panes).toEqual([]);

    await expect(bridge.switchProject('/tmp/project-a')).resolves.toBeUndefined();
    expect(bridge.getProjectRoot()).toBe('/tmp/project-a');
  });

  it('does not send renderer events after the window has been destroyed', () => {
    const send = vi.fn();
    const bridge = AumxBridge.getInstance();
    bridge.setWindow({
      isDestroyed: () => true,
      webContents: { send },
    } as unknown as BrowserWindow);

    bridge.sendToast('must not send', 'error');

    expect(send).not.toHaveBeenCalled();
  });

  it('shutdown clears every owned project service and runtime tracking collection', async () => {
    const bridge = AumxBridge.getInstance();
    await bridge.switchProject('/tmp/project-a');
    const internals = asInternals(bridge);
    internals.worktreeMutationPaths.add('/tmp/project-a/wt');
    internals.untrackablePanes.add('pane-1');

    await bridge.shutdown();

    expect(internals.paneWatcher).toBeNull();
    expect(internals.configBridge).toBeNull();
    expect(internals.agentSessionService).toBeNull();
    expect(internals.paneSummaryService).toBeNull();
    expect(internals.worktreeMutationPaths.size).toBe(0);
    expect(internals.untrackablePanes.size).toBe(0);
    expect(paneMonitorSpies.stop).toHaveBeenCalled();
    expect(agentSessionSpies.shutdown).toHaveBeenCalled();
    expect(fileBrowserWatchSpies.stop).toHaveBeenCalled();
  });

  it('resolves a pane working directory as tmux arguments rather than a shell string', async () => {
    // Arrange: a pane id that would break out of a quoted shell command.
    const hostilePaneId = "%1'; touch /tmp/aumx-pwn; #";
    const bridge = AumxBridge.getInstance();
    displayPaneFormatMock.mockResolvedValue('/tmp/worktree\n');
    await bridge.switchProject('/tmp/project-a');
    const resolvePaneCwd = vi.mocked(AgentSessionService).mock.calls.at(-1)?.[1];

    // Act
    const cwd = await resolvePaneCwd?.({ id: 'p1', paneId: hostilePaneId, prompt: '', slug: 'p1' });

    // Assert
    const shellCommands = vi.mocked(coreExecAsync).mock.calls.map(([command]) => command);
    expect(shellCommands.some((command) => command.includes('display-message'))).toBe(false);
    expect(displayPaneFormatMock).toHaveBeenCalledWith(hostilePaneId, '#{pane_current_path}');
    expect(cwd).toBe('/tmp/worktree');
  });

  it('creates an initial config before booting a first-time project', async () => {
    // Arrange
    const bridge = AumxBridge.getInstance();
    const projectRoot = '/tmp/example-rag';

    // Act
    await bridge.switchProject(projectRoot);

    // Assert
    expect(mkdirSync).toHaveBeenCalledWith('/tmp/example-rag/.amux', { recursive: true });
    expect(atomicWriteJsonSync).toHaveBeenCalledWith(
      '/tmp/example-rag/.amux/aumx.config.json',
      expect.objectContaining({
        controlPaneSize: 40,
        panes: [],
        projectName: 'example-rag',
        projectRoot,
        settings: {},
      }),
    );
  });

  it('starts fresh without resurrecting saved panes when requested', async () => {
    // Arrange
    const bridge = AumxBridge.getInstance();
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockImplementation(() => JSON.stringify({
      controlPaneSize: 40,
      panes: [
        {
          agent: 'claude',
          id: 'saved-pane',
          paneId: '%7',
          prompt: 'old task',
          slug: 'saved-pane',
        },
      ],
      projectName: 'project-a',
      projectRoot: '/tmp/project-a',
      settings: {},
    }));
    const freshSwitch = bridge.switchProject as unknown as (
      projectRoot: string,
      options: { fresh: boolean },
    ) => Promise<void>;

    // Act
    await freshSwitch.call(bridge, '/tmp/project-a', { fresh: true });

    // Assert
    expect(coreState.panes).toEqual([]);
    expect(coreExecAsync).toHaveBeenCalledWith("tmux kill-session -t 'aumx-project-a'", { silent: true });
    expect(atomicWriteJsonSync).toHaveBeenCalledWith(
      '/tmp/project-a/.amux/aumx.config.json',
      expect.objectContaining({
        panes: [],
        projectName: 'project-a',
        projectRoot: '/tmp/project-a',
      }),
    );
    expect(agentSessionSpies.onPaneCreated).not.toHaveBeenCalledWith(expect.objectContaining({ id: 'saved-pane' }));
    expect(paneMonitorSpies.start).not.toHaveBeenCalledWith([
      expect.objectContaining({ id: 'saved-pane' }),
    ]);
  });

  it('persists all legacy title backfills in one write and sends one pane-list notification', async () => {
    const send = vi.fn();
    const bridge = AumxBridge.getInstance();
    bridge.setWindow({
      isDestroyed: () => false,
      webContents: { send },
    } as unknown as BrowserWindow);
    const panes = [
      {
        agent: 'claude' as const,
        agentStatus: 'working' as const,
        id: 'missing-a',
        paneId: '%1',
        prompt: 'Please fix auth',
        slug: 'fix-auth',
        terminalTranscriptPath: '/tmp/a.jsonl',
      },
      {
        agent: 'claude' as const,
        agentStatus: 'working' as const,
        id: 'missing-b',
        paneId: '%2',
        prompt: 'Please update docs',
        slug: 'update-docs',
        terminalTranscriptPath: '/tmp/b.jsonl',
      },
      {
        agent: 'claude' as const,
        agentStatus: 'working' as const,
        id: 'refined',
        paneId: '%3',
        prompt: 'Raw first prompt',
        slug: 'raw-prompt',
        terminalTranscriptPath: '/tmp/c.jsonl',
        title: 'Native refined title',
      },
    ];
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({
      controlPaneId: '%0',
      panes,
      projectName: 'project-a',
      projectRoot: '/tmp/project-a',
      settings: {},
    }));
    coreState.tmuxService.listAllPanes.mockResolvedValueOnce(panes.map((pane) => ({
      currentCommand: 'node',
      paneId: pane.paneId,
      pid: 100,
    })));
    coreState.getRunningAgentPanes.mockResolvedValueOnce(new Set(panes.map((pane) => pane.paneId)));
    vi.mocked(atomicWriteJsonSync).mockClear();
    send.mockClear();

    await bridge.switchProject('/tmp/project-a');

    expect(atomicWriteJsonSync).toHaveBeenCalledOnce();
    expect(atomicWriteJsonSync).toHaveBeenCalledWith(
      '/tmp/project-a/.amux/aumx.config.json',
      expect.objectContaining({
        panes: [
          expect.objectContaining({ id: 'missing-a', title: 'condensed:Please fix a' }),
          expect.objectContaining({ id: 'missing-b', title: 'condensed:Please updat' }),
          expect.objectContaining({ id: 'refined', title: 'Native refined title' }),
        ],
      }),
    );
    const paneListSends = send.mock.calls.filter(([channel]) => channel === IPC_EVENT.PANE_LIST_CHANGED);
    expect(paneListSends).toHaveLength(1);
    expect(paneListSends[0]).toEqual([IPC_EVENT.PANE_LIST_CHANGED, expect.any(Array)]);
  });

  it('defers service boot when no project is discovered and cwd is not a project root', async () => {
    // Arrange
    const bridge = AumxBridge.getInstance();
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue('/');

    try {
      // Act
      await bridge.initialize();

      // Assert
      expect(bridge.getProjectRoot()).toBe('');
      expect(bridge.getProjectName()).toBe('');
      expect(bridge.getSessionName()).toBe('');
      expect(bridge.getConfigPath()).toBe('');
      expect(atomicWriteJsonSync).not.toHaveBeenCalled();
      expect(mkdirSync).not.toHaveBeenCalled();
      expect(coreState.updateProjectInfo).not.toHaveBeenCalled();
    } finally {
      cwdSpy.mockRestore();
    }
  });

  it('reuses agents detected by startup preflight during initial service boot', async () => {
    const bridge = AumxBridge.getInstance();
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue('/tmp/project-a');
    vi.mocked(existsSync).mockImplementation((path) => String(path) === '/tmp/project-a');

    try {
      await bridge.initialize({ availableAgents: ['codex'] });

      expect(asInternals(bridge).agentCatalog.getCached()).toEqual(['codex']);
      expect(coreGetAvailableAgents).not.toHaveBeenCalled();
    } finally {
      cwdSpy.mockRestore();
    }
  });

  it('finishes initial service boot while optional agent discovery continues in the background', async () => {
    const bridge = AumxBridge.getInstance();
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue('/tmp/project-a');
    vi.mocked(existsSync).mockImplementation((path) => String(path) === '/tmp/project-a');
    let resolveAgents: (agents: AgentName[]) => void = () => {};
    vi.mocked(coreGetAvailableAgents).mockReturnValueOnce(
      new Promise((resolve) => { resolveAgents = resolve; }),
    );

    const initialization = bridge.initialize();
    try {
      await vi.waitFor(() => expect(configBridgeSpies.start).toHaveBeenCalled(), { timeout: 200 });
      await initialization;
      expect(asInternals(bridge).agentCatalog.getCached()).toEqual([]);

      resolveAgents(['claude', 'codex']);
      await vi.waitFor(() => expect(asInternals(bridge).agentCatalog.getCached()).toEqual(['claude', 'codex']));
    } finally {
      resolveAgents(['claude', 'codex']);
      await initialization;
      cwdSpy.mockRestore();
    }
  });

  it('waits for deferred discovery before creating a pane without an explicit agent', async () => {
    const bridge = AumxBridge.getInstance();
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue('/tmp/project-a');
    vi.mocked(existsSync).mockImplementation((path) => String(path) === '/tmp/project-a');
    let resolveAgents: (agents: AgentName[]) => void = () => {};
    vi.mocked(coreGetAvailableAgents).mockReturnValueOnce(
      new Promise((resolve) => { resolveAgents = resolve; }),
    );
    vi.mocked(coreCreatePane).mockResolvedValueOnce({ pane: null, needsAgentChoice: true });

    try {
      await bridge.initialize();

      const creation = bridge.createPane('start work');
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(coreCreatePane).not.toHaveBeenCalled();

      resolveAgents(['claude', 'codex']);
      await expect(creation).resolves.toMatchObject({
        availableAgents: ['claude', 'codex'],
        needsAgentChoice: true,
        success: false,
      });
      expect(coreCreatePane).toHaveBeenCalledWith(
        expect.objectContaining({ agent: undefined, prompt: 'start work' }),
        ['claude', 'codex'],
      );
    } finally {
      resolveAgents(['claude', 'codex']);
      cwdSpy.mockRestore();
    }
  });

  it('does not begin bridge discovery when startup is already cancelled', async () => {
    const bridge = AumxBridge.getInstance();
    const controller = new AbortController();
    controller.abort();

    await expect(bridge.initialize({ signal: controller.signal }))
      .rejects.toMatchObject({ name: 'AbortError' });
    expect(coreState.updateProjectInfo).not.toHaveBeenCalled();
    expect(coreGetAvailableAgents).not.toHaveBeenCalled();
  });

  it('serves agent-list requests from the startup cache', async () => {
    const bridge = AumxBridge.getInstance();
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue('/tmp/project-a');
    vi.mocked(existsSync).mockImplementation((path) => String(path) === '/tmp/project-a');

    try {
      await bridge.initialize({ availableAgents: ['codex'] });
      vi.mocked(coreGetAvailableAgents).mockClear();

      await expect(bridge.getAvailableAgents()).resolves.toEqual(['codex']);
      await expect(bridge.getAvailableAgents()).resolves.toEqual(['codex']);
      expect(coreGetAvailableAgents).not.toHaveBeenCalled();
    } finally {
      cwdSpy.mockRestore();
    }
  });

  it('coalesces concurrent explicit agent refreshes into one executable probe', async () => {
    const bridge = AumxBridge.getInstance();
    let resolveAgents: (agents: AgentName[]) => void = () => {};
    vi.mocked(coreGetAvailableAgents).mockImplementationOnce(
      () => new Promise((resolve) => { resolveAgents = resolve; }),
    );

    const first = bridge.refreshAvailableAgents();
    const second = bridge.refreshAvailableAgents();
    expect(coreGetAvailableAgents).toHaveBeenCalledOnce();
    expect(coreGetAvailableAgents).toHaveBeenCalledWith({ refreshIdentity: true });

    resolveAgents(['claude', 'codex']);
    await expect(Promise.all([first, second])).resolves.toEqual([
      ['claude', 'codex'],
      ['claude', 'codex'],
    ]);
  });

  it('defers service boot when launch cwd is not writable', async () => {
    // Arrange
    const bridge = AumxBridge.getInstance();
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue('/System');
    vi.mocked(existsSync).mockImplementation((path) => String(path) === '/System');
    vi.mocked(accessSync).mockImplementation(() => {
      throw new Error('read-only');
    });

    try {
      // Act
      await bridge.initialize();

      // Assert
      expect(bridge.getProjectRoot()).toBe('');
      expect(bridge.getConfigPath()).toBe('');
      expect(atomicWriteJsonSync).not.toHaveBeenCalled();
      expect(mkdirSync).not.toHaveBeenCalled();
      expect(accessSync).toHaveBeenCalledWith('/System', constants.W_OK);
    } finally {
      cwdSpy.mockRestore();
    }
  });

  it('blocks pane creation while waiting for a project selection', async () => {
    // Arrange
    const bridge = AumxBridge.getInstance();
    const send = vi.fn();
    bridge.setWindow({
      isDestroyed: () => false,
      webContents: { send },
    } as unknown as BrowserWindow);
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue('/');

    try {
      await bridge.initialize();

      // Act
      const result = await bridge.createPane('start work', 'claude');

      // Assert
      expect(result).toEqual({
        success: false,
        error: 'Choose or create a project before starting panes.',
      });
      expect(coreCreatePane).not.toHaveBeenCalled();
      expect(send).not.toHaveBeenCalledWith(
        IPC_EVENT.TOAST,
        expect.objectContaining({ message: result.error }),
      );
    } finally {
      cwdSpy.mockRestore();
    }
  });

  it('blocks terminal creation without also emitting a duplicate toast', async () => {
    // Arrange
    const bridge = AumxBridge.getInstance();
    const send = vi.fn();
    bridge.setWindow({
      isDestroyed: () => false,
      webContents: { send },
    } as unknown as BrowserWindow);
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue('/');

    try {
      await bridge.initialize();

      // Act
      const result = await bridge.createTerminalPane('/tmp/project-a');

      // Assert
      expect(result).toEqual({
        success: false,
        error: 'Choose or create a project before starting panes.',
      });
      expect(coreState.tmuxService.newWindowPane).not.toHaveBeenCalled();
      expect(send).not.toHaveBeenCalledWith(
        IPC_EVENT.TOAST,
        expect.objectContaining({ message: result.error }),
      );
    } finally {
      cwdSpy.mockRestore();
    }
  });

  it('returns an actionable Git validation error without emitting a duplicate toast', async () => {
    // Arrange
    const bridge = AumxBridge.getInstance();
    const send = vi.fn();
    bridge.setWindow({
      isDestroyed: () => false,
      webContents: { send },
    } as unknown as BrowserWindow);
    await bridge.switchProject('/tmp/project-a');
    vi.mocked(ensureGitRepository).mockResolvedValueOnce({
      initialized: false,
      isReady: false,
    });

    // Act
    const result = await bridge.createPane('start work', 'claude', { useWorktree: true });

    // Assert
    expect(result).toEqual({
      success: false,
      error: 'Failed to initialize Git repository in "/tmp/project-a". Disable worktree or initialize Git manually.',
    });
    expect(coreCreatePane).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalledWith(
      IPC_EVENT.TOAST,
      expect.objectContaining({ message: result.error }),
    );
  });

  it('rejects an unsupported fullscreen Claude before Git or pane mutation', async () => {
    const bridge = AumxBridge.getInstance();
    await bridge.switchProject('/tmp/project-a');
    vi.mocked(assertClaudeFullscreenSupported).mockRejectedValueOnce(
      new Error('Claude Code 2.1.219 is unsupported. Update Claude or Use classic compatibility mode.'),
    );
    vi.mocked(ensureGitRepository).mockClear();
    vi.mocked(coreCreatePane).mockClear();

    const result = await bridge.createPane('start work', 'claude', { useWorktree: true });

    expect(result).toEqual({
      success: false,
      error: 'Claude Code 2.1.219 is unsupported. Update Claude or Use classic compatibility mode.',
      claudeFullscreenPreflightFailed: true,
    });
    expect(ensureGitRepository).not.toHaveBeenCalled();
    expect(coreCreatePane).not.toHaveBeenCalled();
  });

  it('preflights every Duel side before creating a non-Claude survivor', async () => {
    const bridge = AumxBridge.getInstance();
    await bridge.switchProject('/tmp/project-a');
    vi.mocked(assertClaudeFullscreenSupported).mockRejectedValueOnce(
      new Error('Claude Code 2.1.219 is unsupported. Update Claude or Use classic compatibility mode.'),
    );
    vi.mocked(coreCreatePane).mockClear();

    const result = await bridge.createDuelPanes({
      prompt: 'compare implementations',
      sides: [{ agent: 'codex' }, { agent: 'claude' }],
    });

    expect(result).toEqual({
      success: false,
      error: 'Claude Code 2.1.219 is unsupported. Update Claude or Use classic compatibility mode.',
      claudeFullscreenPreflightFailed: true,
    });
    expect(coreCreatePane).not.toHaveBeenCalled();
  });

  it('persists one fullscreen profile write before resuming the exact registered session', async () => {
    const bridge = AumxBridge.getInstance();
    await bridge.switchProject('/tmp/project-a');
    const pane = {
      agent: 'claude' as const,
      claudeRenderer: 'classic' as const,
      id: 'pane-classic',
      paneId: '%12',
      prompt: 'keep this conversation',
      slug: 'classic-pane',
      terminalFixedCols: 100,
    };
    coreState.panes.push(pane);
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({
      panes: [pane],
      projectName: 'project-a',
      projectRoot: '/tmp/project-a',
      settings: {},
    }));
    vi.mocked(atomicWriteJsonSync).mockClear();

    const confirmation = await bridge.resumePaneInFullscreenAction(pane.id);
    expect(confirmation).toMatchObject({
      type: 'confirm',
      confirmLabel: 'Resume in fullscreen',
      cancelLabel: 'Cancel',
    });
    expect(confirmation.message).toContain('unsent text');

    const result = await bridge.getCallbackRegistry().execute(confirmation.callbackId!);

    expect(result).toMatchObject({ type: 'success' });
    expect(atomicWriteJsonSync).toHaveBeenCalledTimes(1);
    expect(atomicWriteJsonSync).toHaveBeenCalledWith(
      '/tmp/project-a/.amux/aumx.config.json',
      expect.objectContaining({
        panes: [expect.objectContaining({
          claudeRenderer: 'fullscreen',
          id: 'pane-classic',
        })],
      }),
    );
    const persistedPane = vi.mocked(atomicWriteJsonSync).mock.calls[0][1] as {
      panes: Array<{ terminalFixedCols?: number }>;
    };
    expect(persistedPane.panes[0].terminalFixedCols).toBeUndefined();
    expect(readRegisteredSession).toHaveBeenCalledWith('pane-classic');
    expect(resumeAgentInPane).toHaveBeenCalledWith(
      '%12',
      'claude',
      expect.any(Object),
      'session-exact',
      'fullscreen',
      { aumxPaneId: 'pane-classic' },
    );
  });

  it('never interrupts a running Claude pane for a fullscreen resume', async () => {
    const bridge = AumxBridge.getInstance();
    await bridge.switchProject('/tmp/project-a');
    coreState.panes.push({
      agent: 'claude',
      claudeRenderer: 'classic',
      id: 'pane-classic',
      paneId: '%12',
      prompt: 'active',
      slug: 'classic-pane',
      terminalFixedCols: 100,
    });
    vi.mocked(isAgentRunningInPane).mockResolvedValueOnce(true);

    const result = await bridge.resumePaneInFullscreenAction('pane-classic');

    expect(result).toEqual({
      type: 'info',
      message: 'Exit Claude first; Amux will not interrupt a live conversation.',
    });
    expect(resumeAgentInPane).not.toHaveBeenCalled();
  });

  it('rejects a fullscreen resume when the pane is missing from canonical state', async () => {
    const bridge = AumxBridge.getInstance();
    await bridge.switchProject('/tmp/project-a');

    const result = await bridge.resumePaneInFullscreenAction('missing-pane');

    expect(result).toEqual({
      type: 'info',
      message: 'Resume in fullscreen is available only for registered Claude panes.',
    });
    expect(coreState.tmuxService.paneExists).not.toHaveBeenCalled();
    expect(resumeAgentInPane).not.toHaveBeenCalled();
  });

  it('rejects a fullscreen resume when the persisted tmux pane is stale', async () => {
    const bridge = AumxBridge.getInstance();
    await bridge.switchProject('/tmp/project-a');
    coreState.panes.push({
      agent: 'claude', claudeRenderer: 'classic', id: 'pane-classic', paneId: '%12',
      prompt: 'session', slug: 'classic-pane', terminalFixedCols: 100,
    });
    coreState.tmuxService.paneExists.mockResolvedValueOnce(false);

    const result = await bridge.resumePaneInFullscreenAction('pane-classic');

    expect(result).toEqual({ type: 'info', message: 'This pane no longer exists.' });
    expect(isAgentRunningInPane).not.toHaveBeenCalled();
    expect(resumeAgentInPane).not.toHaveBeenCalled();
  });

  it('rejects a fullscreen resume until the pane returns to a shell prompt', async () => {
    const bridge = AumxBridge.getInstance();
    await bridge.switchProject('/tmp/project-a');
    coreState.panes.push({
      agent: 'claude', claudeRenderer: 'classic', id: 'pane-classic', paneId: '%12',
      prompt: 'session', slug: 'classic-pane', terminalFixedCols: 100,
    });
    coreState.tmuxService.getPaneCurrentCommand.mockResolvedValueOnce('node');

    const result = await bridge.resumePaneInFullscreenAction('pane-classic');

    expect(result).toEqual({
      type: 'info',
      message: 'Wait until the pane is at a shell prompt before resuming.',
    });
    expect(readRegisteredSession).not.toHaveBeenCalled();
    expect(resumeAgentInPane).not.toHaveBeenCalled();
  });

  it('requires an exact registered session and never falls back to continue', async () => {
    const bridge = AumxBridge.getInstance();
    await bridge.switchProject('/tmp/project-a');
    coreState.panes.push({
      agent: 'claude', claudeRenderer: 'classic', id: 'pane-classic', paneId: '%12',
      prompt: 'session', slug: 'classic-pane', terminalFixedCols: 100,
    });
    vi.mocked(readRegisteredSession).mockReturnValueOnce(null);

    const result = await bridge.resumePaneInFullscreenAction('pane-classic');

    expect(result).toEqual({
      type: 'info',
      message: 'Amux could not find an exact registered Claude session for this pane.',
    });
    expect(resumeAgentInPane).not.toHaveBeenCalled();
  });

  it('rechecks shell eligibility after confirmation before persisting', async () => {
    const bridge = AumxBridge.getInstance();
    await bridge.switchProject('/tmp/project-a');
    coreState.panes.push({
      agent: 'claude', claudeRenderer: 'classic', id: 'pane-classic', paneId: '%12',
      prompt: 'session', slug: 'classic-pane', terminalFixedCols: 100,
    });
    const confirmation = await bridge.resumePaneInFullscreenAction('pane-classic');
    vi.mocked(isAgentRunningInPane).mockResolvedValueOnce(true);
    vi.mocked(atomicWriteJsonSync).mockClear();

    const result = await bridge.getCallbackRegistry().execute(confirmation.callbackId!);

    expect(result).toEqual({
      type: 'info',
      message: 'Exit Claude first; Amux will not interrupt a live conversation.',
    });
    expect(atomicWriteJsonSync).not.toHaveBeenCalled();
    expect(resumeAgentInPane).not.toHaveBeenCalled();
  });

  it('keeps classic state when the atomic profile write fails', async () => {
    const bridge = AumxBridge.getInstance();
    await bridge.switchProject('/tmp/project-a');
    const pane = {
      agent: 'claude' as const, claudeRenderer: 'classic' as const, id: 'pane-classic', paneId: '%12',
      prompt: 'session', slug: 'classic-pane', terminalFixedCols: 100,
    };
    coreState.panes.push(pane);
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ panes: [pane], settings: {} }));
    const confirmation = await bridge.resumePaneInFullscreenAction('pane-classic');
    vi.mocked(atomicWriteJsonSync).mockImplementationOnce(() => { throw new Error('disk full'); });

    const result = await bridge.getCallbackRegistry().execute(confirmation.callbackId!);

    expect(result).toMatchObject({ type: 'error' });
    expect(coreState.panes[0]).toMatchObject({ claudeRenderer: 'classic', terminalFixedCols: 100 });
    expect(resumeAgentInPane).not.toHaveBeenCalled();
  });

  it('keeps the fullscreen profile and offers retry when resume fails', async () => {
    const bridge = AumxBridge.getInstance();
    await bridge.switchProject('/tmp/project-a');
    const pane = {
      agent: 'claude' as const, claudeRenderer: 'classic' as const, id: 'pane-classic', paneId: '%12',
      prompt: 'session', slug: 'classic-pane', terminalFixedCols: 100,
    };
    coreState.panes.push(pane);
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ panes: [pane], settings: {} }));
    vi.mocked(resumeAgentInPane).mockRejectedValueOnce(new Error('launch failed'));
    const confirmation = await bridge.resumePaneInFullscreenAction('pane-classic');

    const failed = await bridge.getCallbackRegistry().execute(confirmation.callbackId!);
    const retry = await bridge.resumePaneInFullscreenAction('pane-classic');

    expect(failed).toMatchObject({ type: 'error' });
    expect(coreState.panes[0]).toMatchObject({ claudeRenderer: 'fullscreen' });
    expect((coreState.panes[0] as { terminalFixedCols?: number }).terminalFixedCols).toBeUndefined();
    expect(retry).toMatchObject({ type: 'confirm' });
  });

  it('serializes duplicate confirmed resumes per pane', async () => {
    const bridge = AumxBridge.getInstance();
    await bridge.switchProject('/tmp/project-a');
    const pane = {
      agent: 'claude' as const, claudeRenderer: 'classic' as const, id: 'pane-classic', paneId: '%12',
      prompt: 'session', slug: 'classic-pane', terminalFixedCols: 100,
    };
    coreState.panes.push(pane);
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ panes: [pane], settings: {} }));
    let finishResume!: (value: boolean) => void;
    vi.mocked(resumeAgentInPane).mockReturnValueOnce(new Promise((resolve) => { finishResume = resolve; }));
    const confirmation = await bridge.resumePaneInFullscreenAction('pane-classic');
    const first = bridge.getCallbackRegistry().execute(confirmation.callbackId!);
    await vi.waitFor(() => expect(resumeAgentInPane).toHaveBeenCalledTimes(1));

    const duplicate = await bridge.resumePaneInFullscreenAction('pane-classic');
    finishResume(true);
    await first;

    expect(duplicate).toEqual({
      type: 'info',
      message: 'A fullscreen resume is already in progress for this pane.',
    });
    expect(resumeAgentInPane).toHaveBeenCalledTimes(1);
  });

  it('abandons a confirmed resume if the active project changed', async () => {
    const bridge = AumxBridge.getInstance();
    await bridge.switchProject('/tmp/project-a');
    coreState.panes.push({
      agent: 'claude', claudeRenderer: 'classic', id: 'pane-classic', paneId: '%12',
      prompt: 'session', slug: 'classic-pane', terminalFixedCols: 100,
    });
    const confirmation = await bridge.resumePaneInFullscreenAction('pane-classic');
    await bridge.switchProject('/tmp/project-b');
    vi.mocked(atomicWriteJsonSync).mockClear();

    const result = await bridge.getCallbackRegistry().execute(confirmation.callbackId!);

    expect(result).toMatchObject({ type: 'error', message: 'Callback expired or not found' });
    expect(atomicWriteJsonSync).not.toHaveBeenCalled();
    expect(resumeAgentInPane).not.toHaveBeenCalled();
  });

  it('republishes COLORFGBG on the createPane fast path that skips ensureTmuxSession', async () => {
    // Arrange — boot project-a so the control pane is already valid, then let
    // the next createPane take the fast path (tmuxService.paneExists stays true).
    const bridge = AumxBridge.getInstance();
    await bridge.switchProject('/tmp/project-a');
    vi.mocked(ensureTmuxSession).mockClear();
    vi.mocked(publishSessionColorHint).mockClear();
    vi.mocked(coreCreatePane).mockResolvedValueOnce({ pane: null, needsAgentChoice: true });

    // Act
    await bridge.createPane('start work', 'claude');

    // Assert — fast path skipped ensureTmuxSession but still republished the hint
    expect(ensureTmuxSession).not.toHaveBeenCalled();
    expect(publishSessionColorHint).toHaveBeenCalledTimes(1);
    expect(publishSessionColorHint).toHaveBeenCalledWith('aumx-test');
  });

  it('attaches the same local title to the early and final pane objects', async () => {
    const bridge = AumxBridge.getInstance();
    await bridge.switchProject('/tmp/project-a');
    condenseTitleLocallyMock.mockClear();
    let earlyTitle: string | undefined;
    vi.mocked(coreCreatePane).mockImplementationOnce(async (input) => {
      const pane = {
        agent: 'claude' as const,
        id: 'pane-local',
        paneId: '%12',
        prompt: 'Please fix the authentication timeout',
        slug: 'authentication-timeout',
      };
      input.earlyEmit?.onReady(pane);
      earlyTitle = (coreState.panes.find((candidate) => (
        candidate as { id?: string }
      ).id === pane.id) as { title?: string } | undefined)?.title;
      return { needsAgentChoice: false, pane };
    });

    const result = await bridge.createPane('Please fix the authentication timeout', 'claude');

    expect(condenseTitleLocallyMock).toHaveBeenCalledOnce();
    expect(earlyTitle).toBe('condensed:Please fix t');
    expect(result.pane).toMatchObject({ title: earlyTitle });
    expect(result.pane).not.toHaveProperty('titleLocked', true);
    expect(requestExperimentalOpenRouterTitleMock).not.toHaveBeenCalled();
  });

  it('strips legacy runtime activity from the final pane config write', async () => {
    const bridge = AumxBridge.getInstance();
    await bridge.switchProject('/tmp/project-a');
    let config = {
      controlPaneSize: 40,
      panes: [{
        agent: 'pi' as const,
        agentStatus: 'working' as const,
        id: 'pane-pi',
        lastAgentCheck: 100,
        paneId: '%12',
        prompt: 'No initial prompt',
        slug: 'fresh-pi',
      }],
      projectName: 'project-a',
      projectRoot: '/tmp/project-a',
      settings: {},
    };
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockImplementation(() => JSON.stringify(config));
    vi.mocked(atomicWriteJsonSync).mockImplementation((_path, value) => {
      config = value as typeof config;
    });

    asInternals(bridge).savePaneToConfig({
      ...config.panes[0],
      agentStatus: 'idle',
      lastAgentCheck: 200,
    });

    expect(config.panes[0]).not.toHaveProperty('agentStatus');
    expect(config.panes[0]).not.toHaveProperty('lastAgentCheck');
    expect(coreState.panes[0]).not.toHaveProperty('agentStatus');
    expect(coreState.panes[0]).not.toHaveProperty('lastAgentCheck');
  });

  it('never writes config for activity-only transitions but still writes for a genuine metadata mutation', async () => {
    const bridge = AumxBridge.getInstance();
    await bridge.switchProject('/tmp/project-a');
    let config = {
      controlPaneSize: 40,
      panes: [{
        agent: 'claude' as const,
        agentStatus: 'idle' as const,
        id: 'pane-1',
        paneId: '%12',
        prompt: 'keep working',
        slug: 'pane-1',
        title: 'Original title',
      }],
      projectName: 'project-a',
      projectRoot: '/tmp/project-a',
      settings: {},
    };
    coreState.panes.push({ ...config.panes[0] });
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockImplementation(() => JSON.stringify(config));
    vi.mocked(atomicWriteJsonSync).mockImplementation((_path, value) => {
      config = value as typeof config;
    });
    vi.mocked(atomicWriteJsonSync).mockClear();

    const dispatchActivity = asInternals(bridge).handlePaneActivityChanged;
    const buildActivity = (state: PaneActivity['state'], revision: number): PaneActivity => ({
      activityRevision: revision,
      adapterHealth: 'healthy',
      certainty: 'confirmed',
      liveness: 'running',
      openBackgroundWork: [],
      origin: 'adapter',
      paneIncarnationId: 'incarnation-1',
      sinceWallMs: revision,
      state,
    });
    const transitions: PaneActivity['state'][] =
      ['starting', 'working', 'waiting', 'idle', 'working', 'idle', 'unknown', 'stopped'];

    transitions.forEach((state, index) => {
      dispatchActivity({
        changes: [{ activity: buildActivity(state, index + 1), paneId: 'pane-1' }],
        epochId: 'epoch-1',
        revision: index + 1,
      });
    });

    expect(atomicWriteJsonSync).not.toHaveBeenCalled();

    asInternals(bridge).savePaneToConfig({
      ...config.panes[0],
      title: 'Renamed by user',
    });

    expect(atomicWriteJsonSync).toHaveBeenCalledTimes(1);
    expect(config.panes[0]).toMatchObject({ title: 'Renamed by user' });
  });

  it('backfills only missing unlocked legacy titles without downgrading persisted titles', () => {
    const bridge = AumxBridge.getInstance();
    condenseTitleLocallyMock.mockClear();

    const panes = asInternals(bridge).backfillMissingPaneTitles([
      { id: 'missing', paneId: '%1', prompt: 'Please fix auth', slug: 'fix-auth' },
      { id: 'refined', paneId: '%2', prompt: 'First raw prompt', slug: 'raw', title: 'Native refined title' },
      { id: 'locked', paneId: '%3', prompt: 'Rename me', slug: 'locked', titleLocked: true },
    ]);

    expect(panes).toEqual([
      expect.objectContaining({ id: 'missing', title: 'condensed:Please fix a' }),
      expect.objectContaining({ id: 'refined', title: 'Native refined title' }),
      expect.not.objectContaining({ id: 'locked', title: expect.anything() }),
    ]);
    expect(condenseTitleLocallyMock).toHaveBeenCalledOnce();
  });

  it.each([
    { flag: undefined, key: undefined, model: undefined },
    { flag: undefined, key: 'key', model: 'model' },
    { flag: '1', key: undefined, model: 'model' },
    { flag: '1', key: 'key', model: undefined },
  ])('does not invoke the title experiment without all three opt-in values: %j', async ({ flag, key, model }) => {
    const bridge = AumxBridge.getInstance();
    coreState.panes.push({ id: 'pane-1', paneId: '%1', prompt: 'Fix auth', slug: 'fix-auth', title: 'Fix auth' });
    if (flag) process.env.AUMX_EXPERIMENTAL_OPENROUTER_TITLES = flag;
    if (key) process.env.OPENROUTER_API_KEY = key;
    if (model) process.env.AUMX_EXPERIMENTAL_OPENROUTER_TITLE_MODEL = model;

    await asInternals(bridge).maybeRequestExperimentalPaneTitle('pane-1', 'Fix auth');

    expect(requestExperimentalOpenRouterTitleMock).not.toHaveBeenCalled();
  });

  it('invokes the experiment once when all three explicit opt-in values are present', async () => {
    const bridge = AumxBridge.getInstance();
    coreState.panes.push({ id: 'pane-1', paneId: '%1', prompt: 'Fix auth', slug: 'fix-auth', title: 'Fix auth' });
    process.env.AUMX_EXPERIMENTAL_OPENROUTER_TITLES = '1';
    process.env.OPENROUTER_API_KEY = 'key';
    process.env.AUMX_EXPERIMENTAL_OPENROUTER_TITLE_MODEL = 'openai/explicit-model';

    await asInternals(bridge).maybeRequestExperimentalPaneTitle('pane-1', 'Fix auth');

    expect(requestExperimentalOpenRouterTitleMock).toHaveBeenCalledOnce();
    expect(requestExperimentalOpenRouterTitleMock).toHaveBeenCalledWith({
      apiKey: 'key',
      model: 'openai/explicit-model',
      sourceText: 'Fix auth',
    });
  });

  it('preserves an explicit pane title against automatic session title harvesting', async () => {
    // Arrange
    const bridge = AumxBridge.getInstance();
    await bridge.switchProject('/tmp/project-a');
    vi.mocked(coreCreatePane).mockResolvedValueOnce({
      needsAgentChoice: false,
      pane: {
        agent: 'claude',
        id: 'pane-named',
        paneId: '%12',
        prompt: 'Polish the left sidebar',
        slug: 'sidebar-polish',
      },
    });
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({
      panes: [{
        agent: 'claude',
        id: 'pane-named',
        paneId: '%12',
        prompt: 'Polish the left sidebar',
        slug: 'sidebar-polish',
      }],
      projectName: 'project-a',
      projectRoot: '/tmp/project-a',
      settings: {},
    }));
    vi.mocked(atomicWriteJsonSync).mockClear();

    // Act
    const result = await bridge.createPane(
      'Polish the left sidebar',
      'claude',
      { paneTitle: 'Sidebar polish' },
    );

    // Assert
    expect(result.pane).toMatchObject({
      title: 'Sidebar polish',
      titleLocked: true,
    });
    expect(condenseTitleLocallyMock).not.toHaveBeenCalledWith('Polish the left sidebar');
    expect(atomicWriteJsonSync).toHaveBeenCalledWith(
      '/tmp/project-a/.amux/aumx.config.json',
      expect.objectContaining({
        panes: [expect.objectContaining({
          id: 'pane-named',
          title: 'Sidebar polish',
          titleLocked: true,
        })],
      }),
    );
  });

  it('is a no-op when switching to the project root that is already active', async () => {
    // Arrange
    const bridge = AumxBridge.getInstance();
    await bridge.switchProject('/tmp/project-a');
    const watcherCountAfterFirstSwitch = paneWatcherInstances.length;

    // Act
    await bridge.switchProject('/tmp/project-a');

    // Assert — no teardown/boot work happened on the redundant switch
    expect(paneWatcherInstances.length).toBe(watcherCountAfterFirstSwitch);
  });

  it('queues a second project switch while the first switch is in progress', async () => {
    // Arrange — hang the first teardown step so the first switch stays in flight
    const bridge = AumxBridge.getInstance();
    let releaseFirstSwitch: () => void = () => {};
    fileBrowserWatchSpies.stop.mockImplementationOnce(
      () => new Promise<void>((resolve) => { releaseFirstSwitch = resolve; }),
    );

    // Act — fire two switches concurrently
    const first = bridge.switchProject('/tmp/project-a');
    const second = bridge.switchProject('/tmp/project-b');
    let secondCompleted = false;
    void second.then(() => { secondCompleted = true; });
    await Promise.resolve();
    const switchingDuringFirst = asInternals(bridge).switching;
    expect(secondCompleted).toBe(false);
    releaseFirstSwitch();
    await Promise.all([first, second]);

    // Assert — both requests completed in order, without overlapping teardown.
    expect(switchingDuringFirst).toBe(true);
    expect(bridge.getProjectRoot()).toBe('/tmp/project-b');
    expect(asInternals(bridge).switching).toBe(false);
  });

  it('swaps the action callback registry so stale callbacks from the old project cannot fire', async () => {
    // Arrange
    const bridge = AumxBridge.getInstance();
    await bridge.switchProject('/tmp/project-a');
    const registryBeforeSwitch = asInternals(bridge).callbackRegistry;
    // Register a callback that belongs to project-a
    const staleCallbackId = registryBeforeSwitch.register(async () => ({
      type: 'success',
      message: 'stale callback fired',
    }));

    // Act — switch to a different project
    await bridge.switchProject('/tmp/project-b');

    // Assert — the registry instance was replaced, and the stale id no longer resolves
    const registryAfterSwitch = asInternals(bridge).callbackRegistry;
    expect(registryAfterSwitch).not.toBe(registryBeforeSwitch);
    const result = await registryAfterSwitch.execute(staleCallbackId);
    expect(result.type).toBe('error');
  });

  it('clears per-project transient pane tracking on project switch', async () => {
    // Arrange
    const bridge = AumxBridge.getInstance();
    await bridge.switchProject('/tmp/project-a');
    asInternals(bridge).worktreeMutationPaths.add('/tmp/project-a/.aumx/worktrees/closed-worktree');
    asInternals(bridge).untrackablePanes.add('project-a-pane');

    // Act
    await bridge.switchProject('/tmp/project-b');

    // Assert
    expect(asInternals(bridge).worktreeMutationPaths.size).toBe(0);
    expect(asInternals(bridge).untrackablePanes.size).toBe(0);
  });

  it('re-probes a previously untrackable pane once a working/analyzing status is delivered for it', async () => {
    // Arrange — a pane was marked untrackable (e.g. a launch-fail first-idle edge)
    const bridge = AumxBridge.getInstance();
    await bridge.switchProject('/tmp/project-a');
    asInternals(bridge).untrackablePanes.add('pane-1');
    const handler = getStatusUpdatedHandler();

    // Act — the user manually launches the agent; tmux now reports it working
    handler({ paneId: 'pane-1', status: 'working' });

    // Assert — the pane is eligible for auto-tracking again
    expect(asInternals(bridge).untrackablePanes.has('pane-1')).toBe(false);
  });

  it('leaves an untrackable pane alone on an idle status delivery', async () => {
    // Arrange
    const bridge = AumxBridge.getInstance();
    await bridge.switchProject('/tmp/project-a');
    asInternals(bridge).untrackablePanes.add('pane-1');
    const handler = getStatusUpdatedHandler();

    // Act
    handler({ paneId: 'pane-1', status: 'idle' });

    // Assert — idle carries no evidence anything is running; stays untrackable
    expect(asInternals(bridge).untrackablePanes.has('pane-1')).toBe(true);
  });

  it('removes a pane\'s terminal stream status watcher when the pane is destroyed', async () => {
    // Arrange — a live terminal stream lazily added an entry for this pane
    const bridge = AumxBridge.getInstance();
    await bridge.switchProject('/tmp/project-a');
    asInternals(bridge).paneStreamStatusWatchers.set('pane-1', {});
    const onPaneDestroyed = vi.mocked(PaneWatcher).mock.calls[0][3];

    // Act
    onPaneDestroyed?.('pane-1');

    // Assert — the leaked watcher entry is torn down alongside the other per-pane state
    expect(asInternals(bridge).paneStreamStatusWatchers.has('pane-1')).toBe(false);
  });

  it('removes runtime activity immediately when an action closes a pane', async () => {
    const bridge = AumxBridge.getInstance();
    await bridge.switchProject('/tmp/project-a');
    const internals = asInternals(bridge);
    internals.paneActivityService!.registerPane('pane-1', 'incarnation-1');
    internals.paneStreamStatusWatchers.set('pane-1', {});

    internals.buildActionContext().onPaneRemove('pane-1');

    expect(() => internals.paneActivityService!.getSnapshot('pane-1')).toThrow(/No activity is registered/);
    expect(internals.paneStreamStatusWatchers.has('pane-1')).toBe(false);
  });

  it('tears down per-project services in order when switching away from a booted project', async () => {
    // Arrange
    const bridge = AumxBridge.getInstance();
    await bridge.switchProject('/tmp/project-a');
    const projectAWatcher = paneWatcherInstances[0];

    // Act
    await bridge.switchProject('/tmp/project-b');

    // Assert — old project's services were stopped, new project's were started
    const projectBWatcher = paneWatcherInstances[1];
    expect(projectAWatcher.stop).toHaveBeenCalled();
    expect(configBridgeSpies.stop).toHaveBeenCalled();
    expect(agentSessionSpies.shutdown).toHaveBeenCalled();
    expect(fileBrowserWatchSpies.stop).toHaveBeenCalled();
    expect(projectBWatcher.start).toHaveBeenCalled();
    expect(configBridgeSpies.start).toHaveBeenCalled();
  });

  it('waits for an in-flight pane creation before switching projects', async () => {
    const bridge = AumxBridge.getInstance();
    await bridge.switchProject('/tmp/project-a');
    terminalStreamSpies.reset.mockClear();
    const watcherDuringCreate = asInternals(bridge).paneWatcher;
    expect(watcherDuringCreate).not.toBeNull();
    let finishCreate: ((result: Awaited<ReturnType<typeof coreCreatePane>>) => void) | undefined;
    vi.mocked(coreCreatePane).mockImplementationOnce(() => new Promise((resolve) => {
      finishCreate = resolve;
    }));

    const createPromise = bridge.createPane('finish project-a work', 'claude');
    await vi.waitFor(() => expect(coreCreatePane).toHaveBeenCalledOnce());
    const switchPromise = bridge.switchProject('/tmp/project-b');
    await Promise.resolve();

    expect(watcherDuringCreate?.stop).not.toHaveBeenCalled();
    expect(terminalStreamSpies.reset).not.toHaveBeenCalled();
    expect(bridge.getProjectRoot()).toBe('/tmp/project-a');

    finishCreate?.({
      needsAgentChoice: false,
      pane: {
        agent: 'claude',
        id: 'project-a-pane',
        paneId: '%12',
        prompt: 'finish project-a work',
        slug: 'finish-project-a-work',
      },
    });
    await expect(createPromise).resolves.toMatchObject({ success: true });
    await switchPromise;

    expect(terminalStreamSpies.reset).toHaveBeenCalledOnce();
    expect(watcherDuringCreate?.stop).toHaveBeenCalled();
    expect(asInternals(bridge).paneWatcher).not.toBe(watcherDuringCreate);
    expect(bridge.getProjectRoot()).toBe('/tmp/project-b');
    expect(coreState.panes).toEqual([]);
  });

  it('drops a pane-id rebind that resolves after its project was switched away from', async () => {
    // Arrange — boot project-a and capture the rebind-persist callback wired for it
    const bridge = AumxBridge.getInstance();
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockImplementation(() => JSON.stringify({
      controlPaneSize: 40,
      panes: [],
      projectName: 'project-b',
      projectRoot: '/tmp/project-b',
      settings: {},
    }));
    await bridge.switchProject('/tmp/project-a');
    const persistProjectARebind = vi.mocked(PaneWatcher).mock.calls[0][4];
    await bridge.switchProject('/tmp/project-b');
    vi.mocked(atomicWriteJsonSync).mockClear();

    // Act — project-a's in-flight sync rebinds a pane id after the switch
    persistProjectARebind?.([{ id: 'pane-a', paneId: '%9', prompt: '', slug: 'task' }]);

    // Assert — project-a's panes never reach project-b's config
    expect(atomicWriteJsonSync).not.toHaveBeenCalled();
  });

  it('reopens a preserved worktree by attaching a new tmux pane to the existing directory', async () => {
    const bridge = AumxBridge.getInstance();
    const worktreePath = '/tmp/project-a/.aumx/worktrees/closed-worktree';
    coreState.inspectPreservedWorktreeAsync.mockResolvedValue({
      branch: 'feature/closed-worktree',
      gitStatus: 'dirty',
      lastModified: new Date(1_700_000_000_000),
      path: worktreePath,
      registration: 'registered',
      slug: 'closed-worktree',
    });
    coreState.tmuxService.listAllPanes.mockResolvedValueOnce([
      { paneId: '%7', pid: '7007', currentCommand: 'zsh' },
      { paneId: '%8', pid: '8008', currentCommand: 'zsh' },
    ]);

    await bridge.switchProject('/tmp/project-a');
    const result = await bridge.reopenWorktreePane(worktreePath);

    expect(result.success).toBe(true);
    expect(result.pane).toMatchObject({
      branchName: 'feature/closed-worktree',
      paneId: '%42',
      projectRoot: '/tmp/project-a',
      slug: 'closed-worktree',
      type: 'worktree',
      worktreePath,
    });
    expect(coreState.tmuxService.newWindowPane).toHaveBeenCalledWith({
      cwd: worktreePath,
      sessionName: 'aumx-test',
    });
    expect(coreState.tmuxService.setPaneTitle).toHaveBeenCalledWith('%42', 'closed-worktree');
    expect(triggerHook).toHaveBeenCalledWith('pane_reopened', '/tmp/project-a', result.pane);
  });

  it('keeps reopened panes visible and warns when config persistence fails', async () => {
    // Arrange
    const bridge = AumxBridge.getInstance();
    const send = vi.fn();
    bridge.setWindow({
      isDestroyed: () => false,
      webContents: { send },
    } as unknown as BrowserWindow);
    const worktreePath = '/tmp/project-a/.aumx/worktrees/closed-worktree';
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockImplementation(() => JSON.stringify({
      controlPaneSize: 40,
      panes: [],
      projectName: 'project-a',
      projectRoot: '/tmp/project-a',
      settings: {},
    }));
    coreState.inspectPreservedWorktreeAsync.mockResolvedValue({
      branch: 'feature/closed-worktree',
      gitStatus: 'dirty',
      lastModified: new Date(1_700_000_000_000),
      path: worktreePath,
      registration: 'registered',
      slug: 'closed-worktree',
    });
    await bridge.switchProject('/tmp/project-a');
    vi.mocked(atomicWriteJsonSync).mockImplementationOnce(() => {
      throw new Error('disk full');
    });

    // Act
    const result = await bridge.reopenWorktreePane(worktreePath);

    // Assert
    expect(result.success).toBe(true);
    expect(coreState.panes).toContainEqual(expect.objectContaining({ worktreePath }));
    expect(send).toHaveBeenCalledWith(IPC_EVENT.TOAST, {
      message: 'Reopened "closed-worktree" but failed to save to disk. Restart will not restore it.',
      severity: 'warning',
    });
  });

  it('replaces stale config entries for the same worktree when reopening a pane', async () => {
    // Arrange
    const bridge = AumxBridge.getInstance();
    const worktreePath = '/tmp/project-a/.aumx/worktrees/closed-worktree';
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockImplementation(() => JSON.stringify({
      controlPaneSize: 40,
      panes: [
        {
          id: 'stale-pane',
          paneId: '%7',
          prompt: '',
          slug: 'closed-worktree',
          type: 'worktree',
          worktreePath,
        },
        {
          id: 'other-pane',
          paneId: '%8',
          prompt: '',
          slug: 'other-worktree',
          type: 'worktree',
          worktreePath: '/tmp/project-a/.aumx/worktrees/other-worktree',
        },
      ],
      projectName: 'project-a',
      projectRoot: '/tmp/project-a',
      settings: {},
    }));
    coreState.inspectPreservedWorktreeAsync.mockResolvedValue({
      branch: 'feature/closed-worktree',
      gitStatus: 'dirty',
      lastModified: new Date(1_700_000_000_000),
      path: worktreePath,
      registration: 'registered',
      slug: 'closed-worktree',
    });

    await bridge.switchProject('/tmp/project-a');

    // Act
    const result = await bridge.reopenWorktreePane(worktreePath);

    // Assert
    expect(result.success).toBe(true);
    expect(atomicWriteJsonSync).toHaveBeenLastCalledWith(
      '/tmp/project-a/.amux/aumx.config.json',
      expect.objectContaining({
        panes: [
          expect.objectContaining({ id: 'other-pane' }),
          expect.objectContaining({ id: result.pane?.id, worktreePath }),
        ],
      }),
    );
    expect(coreState.panes).toHaveLength(2);
    expect(coreState.panes).not.toContainEqual(expect.objectContaining({ id: 'stale-pane' }));
  });

  it('serializes duplicate reopen requests for the same preserved worktree', async () => {
    const bridge = AumxBridge.getInstance();
    const worktreePath = '/tmp/project-a/.aumx/worktrees/closed-worktree';
    coreState.inspectPreservedWorktreeAsync.mockResolvedValue({
      branch: 'feature/closed-worktree',
      gitStatus: 'dirty',
      lastModified: new Date(1_700_000_000_000),
      path: worktreePath,
      registration: 'registered',
      slug: 'closed-worktree',
    });

    await bridge.switchProject('/tmp/project-a');

    const [first, second] = await Promise.all([
      bridge.reopenWorktreePane(worktreePath),
      bridge.reopenWorktreePane(worktreePath),
    ]);

    expect(first.success).toBe(true);
    expect(second).toMatchObject({
      success: false,
      error: 'Worktree is already reopening',
    });
    expect(coreState.tmuxService.newWindowPane).toHaveBeenCalledTimes(1);
  });

  it('lists preserved worktree metadata without inspecting every Git worktree', async () => {
    const bridge = AumxBridge.getInstance();
    const activePath = '/tmp/project-a/.aumx/worktrees/active';
    coreState.listPreservedWorktreesAsync.mockResolvedValue([{
      branch: null,
      gitStatus: 'unchecked',
      lastModified: new Date(1_700_000_000_000),
      path: '/tmp/project-a/.aumx/worktrees/preserved',
      registration: 'unchecked',
      slug: 'preserved',
    }]);

    await bridge.switchProject('/tmp/project-a');
    coreState.panes.push({
      id: 'active-pane',
      paneId: '%9',
      prompt: '',
      slug: 'active',
      worktreePath: activePath,
    });
    const result = await bridge.listOrphanedWorktrees();

    expect(coreState.listPreservedWorktreesAsync).toHaveBeenCalledWith(
      '/tmp/project-a',
      [activePath],
    );
    expect(coreState.inspectPreservedWorktreeAsync).not.toHaveBeenCalled();
    expect(result).toEqual({
      success: true,
      worktrees: [{
        branch: null,
        gitStatus: 'unchecked',
        lastModifiedMs: 1_700_000_000_000,
        path: '/tmp/project-a/.aumx/worktrees/preserved',
        registration: 'unchecked',
        slug: 'preserved',
      }],
    });
  });

  it('revalidates active worktrees and data-loss consent when removing a preserved worktree', async () => {
    const bridge = AumxBridge.getInstance();
    const activePath = '/tmp/project-a/.aumx/worktrees/active';
    const preservedPath = '/tmp/project-a/.aumx/worktrees/preserved';
    await bridge.switchProject('/tmp/project-a');
    coreState.panes.push({
      id: 'active-pane',
      paneId: '%9',
      prompt: '',
      slug: 'active',
      worktreePath: activePath,
    });
    const expectedState = {
      branch: 'feature/preserved',
      gitStatus: 'dirty' as const,
      registration: 'registered' as const,
    };

    const result = await bridge.removePreservedWorktree(preservedPath, true, expectedState);

    expect(result).toEqual({ success: true });
    expect(coreState.removePreservedWorktreeAsync).toHaveBeenCalledWith({
      activeWorktreePaths: [activePath],
      allowDataLoss: true,
      expectedState,
      projectRoot: '/tmp/project-a',
      worktreePath: preservedPath,
    });
  });

  it('opens a terminal pane in the requested project root instead of the session root', async () => {
    // Arrange — session is booted on project-a, but the request targets project-b
    const bridge = AumxBridge.getInstance();
    await bridge.switchProject('/tmp/project-a');

    // Act
    const result = await bridge.createTerminalPane('/tmp/project-b');

    // Assert — tmux pane is spawned in the requested root and the pane records it
    expect(result.success).toBe(true);
    expect(coreState.tmuxService.newWindowPane).toHaveBeenCalledWith({
      cwd: '/tmp/project-b',
      sessionName: 'aumx-test',
    });
    expect(result.pane).toMatchObject({
      paneId: '%42',
      projectName: 'project-b',
      projectRoot: '/tmp/project-b',
      type: 'shell',
    });
  });

  it('falls back to the session project root when no terminal root is requested', async () => {
    // Arrange
    const bridge = AumxBridge.getInstance();
    await bridge.switchProject('/tmp/project-a');

    // Act
    const result = await bridge.createTerminalPane();

    // Assert
    expect(result.success).toBe(true);
    expect(coreState.tmuxService.newWindowPane).toHaveBeenCalledWith({
      cwd: '/tmp/project-a',
      sessionName: 'aumx-test',
    });
    expect(result.pane).toMatchObject({
      projectName: 'project-a',
      projectRoot: '/tmp/project-a',
      type: 'shell',
    });
  });
});

describe('AumxBridge.applyHarvestedPaneTitle — native title guards', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(existsSync).mockReturnValue(false);
    vi.mocked(readFileSync).mockImplementation(() => { throw new Error('no config'); });
    vi.mocked(accessSync).mockReturnValue(undefined);
    vi.mocked(statSync).mockReturnValue({ isDirectory: () => true } as ReturnType<typeof statSync>);
    coreState.panes.length = 0;
    resetSingleton();
  });

  interface HarvestedTitleInput {
    title: string;
  }

  function applyHarvestedTitle(bridge: AumxBridge, paneId: string, harvested: HarvestedTitleInput): void {
    (bridge as unknown as { applyHarvestedPaneTitle(paneId: string, harvested: HarvestedTitleInput): void })
      .applyHarvestedPaneTitle(paneId, harvested);
  }

  it('normalizes and writes a native title onto the matching pane', () => {
    // Arrange
    const bridge = AumxBridge.getInstance();
    coreState.panes.push({ id: 'pane-1', paneId: '%1', prompt: '', slug: 'task' });
    coreState.updatePanes.mockClear();

    // Act
    applyHarvestedTitle(bridge, 'pane-1', { title: '✳  Fix the sidebar\nrename bug  ' });

    // Assert
    expect(coreState.panes[0]).toMatchObject({ id: 'pane-1', title: 'Fix the sidebar rename bug' });
  });

  it('never overwrites a title the user locked', () => {
    // Arrange
    const bridge = AumxBridge.getInstance();
    coreState.panes.push({ id: 'pane-1', paneId: '%1', prompt: '', slug: 'task', title: 'Manual name', titleLocked: true });
    coreState.updatePanes.mockClear();

    // Act
    applyHarvestedTitle(bridge, 'pane-1', { title: 'Harvested name' });

    // Assert
    expect(coreState.updatePanes).not.toHaveBeenCalled();
    expect(coreState.panes[0]).toMatchObject({ title: 'Manual name' });
  });

  it('skips persistence and notification when normalized titles are identical', () => {
    // Arrange
    const bridge = AumxBridge.getInstance();
    coreState.panes.push({ id: 'pane-1', paneId: '%1', prompt: '', slug: 'task', title: 'Same title' });
    coreState.updatePanes.mockClear();

    // Act
    applyHarvestedTitle(bridge, 'pane-1', { title: '✳ "Same title."' });

    // Assert
    expect(coreState.updatePanes).not.toHaveBeenCalled();
  });

  it('rejects placeholders and malformed automatic candidates', () => {
    const bridge = AumxBridge.getInstance();
    coreState.panes.push({ id: 'pane-1', paneId: '%1', prompt: '', slug: 'task', title: 'Local title' });
    coreState.updatePanes.mockClear();

    applyHarvestedTitle(bridge, 'pane-1', { title: 'New session - 2026-08-03T10:15:00.000Z' });

    expect(coreState.updatePanes).not.toHaveBeenCalled();
    expect(coreState.panes[0]).toMatchObject({ title: 'Local title' });
  });

  it('allows a later valid native title to refine an unlocked local title', () => {
    const bridge = AumxBridge.getInstance();
    coreState.panes.push({ id: 'pane-1', paneId: '%1', prompt: '', slug: 'task', title: 'Local title' });

    applyHarvestedTitle(bridge, 'pane-1', { title: 'Native agent title' });

    expect(coreState.panes[0]).toMatchObject({ title: 'Native agent title' });
  });

  it('drops a title when its pane was deleted before commit', () => {
    const bridge = AumxBridge.getInstance();
    coreState.updatePanes.mockClear();

    applyHarvestedTitle(bridge, 'deleted-pane', { title: 'Late agent title' });

    expect(coreState.updatePanes).not.toHaveBeenCalled();
  });
});
