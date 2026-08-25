// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { MuxBasePane } from 'muxbase/core';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ATTACH_REJECTION_BACKOFF_MS,
  InteractiveTerminal,
} from '../src/renderer/components/pane-detail/InteractiveTerminal';
import { clipboardWrite } from '../src/renderer/api/system.api';
import { createEmptySession } from '../src/shared/agent-session-types';
import { TERMINAL_BACKGROUND_COLORS, TERMINAL_FOREGROUND_COLORS } from '../src/shared/app-colors';
import type { TerminalTheme } from '../src/shared/terminal-profile';
import { useAgentSessionStore, useElectronSettingsStore, useNotificationStore, usePaneActivityStore, usePaneStore, useProjectStore, useTerminalStore } from '../src/renderer/stores';
import type { PaneActivityState } from '../src/shared/pane-activity';
import { IPC_EVENT } from '../src/shared/ipc-channels';
import type { ElectronSettings, TerminalSelectionExpandResponse } from '../src/shared/ipc-types';
import * as terminalBootDetection from '../src/renderer/lib/terminal-boot-detection';
import { makeActivity } from './helpers/pane-activity-fixtures';

type OscHandler = (data: string) => boolean | Promise<boolean>;

interface Deferred<T> {
  promise: Promise<T>;
  reject: (reason?: unknown) => void;
  resolve: (value: T) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, reject, resolve };
}

interface FakeTerminalInstance {
  buffer: { active: { baseY: number; type: 'normal' | 'alternate'; viewportY: number } };
  cols: number;
  dataListeners: Array<(data: string) => void>;
  element: HTMLElement | null;
  keyListeners: Array<() => void>;
  options: Record<string, unknown>;
  rows: number;
  selection: string;
  selectionPosition?: {
    end: { x: number; y: number };
    start: { x: number; y: number };
  };
  selectionChangeListeners: Array<() => void>;
  attachCustomKeyEventHandler: ReturnType<typeof vi.fn>;
  blur: ReturnType<typeof vi.fn>;
  clear: ReturnType<typeof vi.fn>;
  clearSelection: ReturnType<typeof vi.fn>;
  clearTextureAtlas: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
  focus: ReturnType<typeof vi.fn>;
  getSelection: ReturnType<typeof vi.fn>;
  getSelectionPosition: ReturnType<typeof vi.fn>;
  hasSelection: ReturnType<typeof vi.fn>;
  loadAddon: ReturnType<typeof vi.fn>;
  modes: { mouseTrackingMode: 'none' | 'vt200' };
  onBell: ReturnType<typeof vi.fn>;
  onData: ReturnType<typeof vi.fn>;
  onKey: ReturnType<typeof vi.fn>;
  onSelectionChange: (listener: () => void) => { dispose: ReturnType<typeof vi.fn> };
  open: ReturnType<typeof vi.fn>;
  oscHandlers: Map<number, OscHandler>;
  parser: { registerOscHandler: ReturnType<typeof vi.fn> };
  refresh: ReturnType<typeof vi.fn>;
  registerLinkProvider: ReturnType<typeof vi.fn>;
  resize: ReturnType<typeof vi.fn>;
  scrollLines: ReturnType<typeof vi.fn>;
  scrollToBottom: ReturnType<typeof vi.fn>;
  scrollToLine: ReturnType<typeof vi.fn>;
  select: ReturnType<typeof vi.fn>;
  selectAll: ReturnType<typeof vi.fn>;
  unicode: { activeVersion: string; register: ReturnType<typeof vi.fn> };
  write: ReturnType<typeof vi.fn>;
}

const terminalMock = vi.hoisted(() => {
  const constructorOptions: Array<Record<string, unknown>> = [];
  const instances: FakeTerminalInstance[] = [];
  const state: { loadAddonError: Error | null; openError: Error | null } = {
    loadAddonError: null,
    openError: null,
  };

  const Terminal = vi.fn((options: Record<string, unknown>) => {
    const terminal: FakeTerminalInstance = {
      buffer: { active: { baseY: 0, type: 'alternate', viewportY: 0 } },
      cols: 80,
      dataListeners: [],
      element: null,
      keyListeners: [],
      options: { ...options },
      rows: 24,
      selection: '',
      selectionChangeListeners: [],
      attachCustomKeyEventHandler: vi.fn(),
      blur: vi.fn(),
      clear: vi.fn(),
      clearSelection: vi.fn(),
      clearTextureAtlas: vi.fn(),
      dispose: vi.fn(),
      focus: vi.fn(),
      getSelection: vi.fn(() => terminal.selection),
      getSelectionPosition: vi.fn(() => terminal.selectionPosition),
      hasSelection: vi.fn(() => terminal.selection.length > 0),
      loadAddon: vi.fn((addon: object) => {
        if (state.loadAddonError && 'onContextLoss' in addon) {
          throw state.loadAddonError;
        }
      }),
      modes: { mouseTrackingMode: 'none' },
      onBell: vi.fn(() => ({ dispose: vi.fn() })),
      onData: vi.fn((listener: (data: string) => void) => {
        terminal.dataListeners.push(listener);
        return { dispose: vi.fn() };
      }),
      onKey: vi.fn((listener: () => void) => {
        terminal.keyListeners.push(listener);
        return { dispose: vi.fn() };
      }),
      onSelectionChange: (listener: () => void) => {
        terminal.selectionChangeListeners.push(listener);
        return { dispose: vi.fn() };
      },
      open: vi.fn((container: HTMLElement) => {
        if (state.openError) throw state.openError;
        terminal.element = document.createElement('div');
        terminal.element.className = 'xterm';
        container.appendChild(terminal.element);
      }),
      oscHandlers: new Map<number, OscHandler>(),
      parser: {
        registerOscHandler: vi.fn((ident: number, handler: OscHandler) => {
          terminal.oscHandlers.set(ident, handler);
          return { dispose: vi.fn() };
        }),
      },
      refresh: vi.fn(),
      registerLinkProvider: vi.fn(() => ({ dispose: vi.fn() })),
      resize: vi.fn((cols: number, rows: number) => {
        terminal.cols = cols;
        terminal.rows = rows;
      }),
      scrollLines: vi.fn(),
      scrollToBottom: vi.fn(),
      scrollToLine: vi.fn(),
      select: vi.fn((column: number, row: number, length: number) => {
        const endOffset = column + length;
        terminal.selectionPosition = {
          end: {
            x: endOffset % terminal.cols,
            y: row + Math.floor(endOffset / terminal.cols),
          },
          start: { x: column, y: row },
        };
        terminal.selectionChangeListeners.forEach((listener) => listener());
      }),
      selectAll: vi.fn(),
      unicode: { activeVersion: '6', register: vi.fn() },
      write: vi.fn((_data: string, callback?: () => void) => callback?.()),
    };
    constructorOptions.push(options);
    instances.push(terminal);
    return terminal;
  });

  return {
    constructorOptions,
    instances,
    state,
    Terminal,
  };
});

const searchAddonMock = vi.hoisted(() => ({
  clearDecorations: vi.fn(),
  findNext: vi.fn(),
  findPrevious: vi.fn(),
  onDidChangeResults: vi.fn(() => ({ dispose: vi.fn() })),
}));

const webglAddonMock = vi.hoisted(() => {
  const instances: Array<{
    contextLossListeners: Array<() => void>;
    dispose: ReturnType<typeof vi.fn>;
    onContextLoss: ReturnType<typeof vi.fn>;
  }> = [];
  const state: { constructorError: Error | null } = { constructorError: null };
  const WebglAddon = vi.fn(() => {
    if (state.constructorError) throw state.constructorError;
    const contextLossListeners: Array<() => void> = [];
    const addon = {
      contextLossListeners,
      dispose: vi.fn(),
      onContextLoss: vi.fn((listener: () => void) => {
        contextLossListeners.push(listener);
        return {
          dispose: vi.fn(() => {
            const index = contextLossListeners.indexOf(listener);
            if (index >= 0) contextLossListeners.splice(index, 1);
          }),
        };
      }),
    };
    instances.push(addon);
    return addon;
  });

  return { instances, state, WebglAddon };
});

const terminalApiMock = vi.hoisted(() => ({
  attach: vi.fn(() => Promise.resolve({ success: true, cols: 80, rows: 24 })),
  detach: vi.fn(),
  expandSelection: vi.fn((): Promise<TerminalSelectionExpandResponse> => (
    Promise.resolve({ status: 'history-unavailable' })
  )),
  resize: vi.fn(() => Promise.resolve({ success: true })),
  scroll: vi.fn(() => Promise.resolve({ success: true })),
  unlockStdin: vi.fn(),
  write: vi.fn(),
}));

const terminalFontsMock = vi.hoisted(() => ({
  loadTerminalFonts: vi.fn(() => Promise.resolve()),
}));

const terminalFitMock = vi.hoisted(() => ({
  fitTerminalToContainer: vi.fn((
    _fitAddon?: unknown,
    _terminal?: unknown,
    _container?: unknown,
    _options?: { onFailure?: (reason: 'too-narrow') => void },
  ) => ({ cols: 80, rows: 24 } as { cols: number; rows: number } | null)),
}));

const resizeObserverMock = vi.hoisted(() => ({
  callbacks: [] as ResizeObserverCallback[],
}));

const mediaQueryMock = vi.hoisted(() => ({
  callbacks: [] as Array<() => void>,
}));

const systemApiMock = vi.hoisted(() => ({
  clipboardRead: vi.fn(() => Promise.resolve('')),
  clipboardWrite: vi.fn((..._args: unknown[]) => Promise.resolve()),
  openExternal: vi.fn(() => Promise.resolve()),
}));

const ipcMock = vi.hoisted(() => ({
  listeners: new Map<string, (event: unknown) => void>(),
  on: vi.fn((channel: string, listener: (event: unknown) => void) => {
    ipcMock.listeners.set(channel, listener);
    return vi.fn(() => {
      ipcMock.listeners.delete(channel);
    });
  }),
}));

vi.mock('@xterm/xterm', () => ({
  Terminal: terminalMock.Terminal,
}));

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: vi.fn(),
}));

vi.mock('@xterm/addon-search', () => ({
  SearchAddon: vi.fn(() => searchAddonMock),
}));

vi.mock('@xterm/addon-unicode-graphemes', () => ({
  UnicodeGraphemesAddon: vi.fn(() => ({
    activate: (terminal: { unicode: { register: (provider: unknown) => void } }) => {
      terminal.unicode.register({
        version: '15-graphemes',
        charProperties: vi.fn(() => 2),
        wcwidth: vi.fn(() => 1),
      });
    },
    dispose: vi.fn(),
  })),
}));

vi.mock('@xterm/addon-webgl', () => ({
  WebglAddon: webglAddonMock.WebglAddon,
}));

vi.mock('@xterm/addon-web-links', () => ({
  WebLinksAddon: vi.fn(),
}));

vi.mock('../src/renderer/api/ipc', () => ({
  on: ipcMock.on,
}));

vi.mock('../src/renderer/api/system.api', () => systemApiMock);

vi.mock('../src/renderer/api/terminal.api', () => terminalApiMock);

vi.mock('../src/renderer/lib/platform', () => ({ IS_MAC: true }));

vi.mock('../src/renderer/lib/terminal-fit', () => terminalFitMock);

vi.mock('../src/renderer/lib/terminal-fonts', () => terminalFontsMock);

vi.mock('../src/renderer/lib/terminalDebug', () => ({
  terminalDebug: {
    attach: vi.fn(),
    capture: vi.fn(() => ({})),
    data: vi.fn(),
    drop: vi.fn(),
    register: vi.fn(),
    unregister: vi.fn(),
    wheel: vi.fn(),
  },
}));

const defaultSettings: ElectronSettings = {
  alwaysOnTop: false,
  compactMode: false,
  copyOnSelect: false,
  costCurrency: 'EUR-hai',
  cursorBlink: true,
  cursorStyle: 'block',
  debugLogging: false,
  disableExternalNetwork: false,
  enableConversationTopics: false,
  enableKanbanBoard: false,
  enablePaneSummary: false,
  enableReviewAgent: true,
  enableTelemetryCostTracking: true,
  pollingInterval: 200,
  scrollbackLines: 25000,
  showAgentHealthTracker: false,
  showArenaScores: false,
  showPerformanceMetrics: false,
  sidebarOrganize: 'project',
  sidebarSort: 'priority',
  terminalBell: false,
  terminalFontFamily: 'Intel One Mono',
  terminalFontSize: 14,
  opencodeMousePassthrough: false,
  terminalOsc52Clipboard: 'off',
  terminalPreferredLaunchCols: 0,
  terminalPreferredLaunchRows: 0,
  terminalTheme: 'follow',
  terminalTransport: 'classic',
  theme: 'dark',
  uiZoom: 1,
  windowOpacity: 1,
};

function makePane(overrides: Partial<MuxBasePane> = {}): MuxBasePane {
  return {
    agent: 'opencode',
    agentStatus: 'working',
    id: 'pane-1',
    paneId: '%1',
    projectRoot: '/repo',
    prompt: 'Explain the architecture',
    slug: 'explain-architecture',
    terminalTranscriptPath: '/tmp/muxbase-pane-1.log',
    type: 'worktree',
    worktreePath: '/repo/.muxbase/worktrees/explain-architecture',
    ...overrides,
  };
}

function resetStores(settings: Partial<ElectronSettings> = {}, pane = makePane()): void {
  useElectronSettingsStore.setState({
    isLoading: false,
    settings: { ...defaultSettings, ...settings },
  });
  usePaneStore.setState({
    isCreating: false,
    justFinishedPaneIds: new Set<string>(),
    loaded: true,
    panes: [pane],
    pendingPane: null,
    selectedPaneId: pane.id,
  });
  useProjectStore.setState({
    activeProject: {
      configPath: '/repo/.muxbase/muxbase.config.json',
      name: 'repo',
      paneCount: 1,
      root: '/repo',
      sessionName: 'muxbase-repo',
    },
    projectSwitching: false,
    projects: [],
    sessionName: 'muxbase-repo',
    sessionProjectName: 'repo',
    sessionProjectRoot: '/repo',
  });
  useTerminalStore.setState({
    attachedPaneIds: new Set<string>(),
    seenPaneIds: new Set<string>(),
  });
  useAgentSessionStore.setState({ sessions: {} });
  useNotificationStore.setState({
    toasts: [],
  });
  usePaneActivityStore.setState({
    activityByPaneId: {
      [pane.id]: {
        activityRevision: 1,
        adapterHealth: 'degraded',
        certainty: 'provisional',
        liveness: 'unknown',
        openBackgroundWork: [],
        origin: 'none',
        paneIncarnationId: `${pane.id}-incarnation`,
        sinceWallMs: Date.now(),
        state: pane.agentStatus === 'waiting' ? 'waiting' : pane.agentStatus === 'idle' ? 'idle' : 'working',
      },
    },
    justFinishedPaneIds: new Set(),
  });
}

function setPaneActivityState(paneId: string, state: PaneActivityState): void {
  usePaneActivityStore.setState((current) => ({
    activityByPaneId: {
      ...current.activityByPaneId,
      [paneId]: { ...current.activityByPaneId[paneId], state },
    },
  }));
}

async function renderTerminal(settings: Partial<ElectronSettings> = {}, pane = makePane()) {
  resetStores(settings, pane);
  render(<InteractiveTerminal pane={pane} />);
  await waitFor(() => expect(terminalMock.instances).toHaveLength(1));
  await waitFor(() => expect(terminalApiMock.attach).toHaveBeenCalled());
  return terminalMock.instances[0];
}

async function renderTerminalWithFakeTimers(
  settings: Partial<ElectronSettings> = {},
  pane = makePane(),
): Promise<FakeTerminalInstance> {
  resetStores(settings, pane);
  render(<InteractiveTerminal pane={pane} />);
  for (let index = 0; index < 12 && resizeObserverMock.callbacks.length === 0; index += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
  await act(async () => {
    await vi.advanceTimersByTimeAsync(20);
  });
  expect(terminalMock.instances).toHaveLength(1);
  expect(resizeObserverMock.callbacks.length).toBeGreaterThan(0);
  return terminalMock.instances[0];
}

async function exhaustAttachRejectionRetries(): Promise<void> {
  for (const delay of ATTACH_REJECTION_BACKOFF_MS) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(delay);
    });
  }
}

function notifyTerminalResize(): void {
  const callback = resizeObserverMock.callbacks.at(-1);
  expect(callback).toBeTruthy();
  callback?.([], {} as ResizeObserver);
}

describe('InteractiveTerminal copy behavior', () => {
  beforeEach(() => {
    terminalMock.constructorOptions.length = 0;
    terminalMock.instances.length = 0;
    terminalMock.state.loadAddonError = null;
    terminalMock.state.openError = null;
    terminalMock.Terminal.mockClear();
    terminalApiMock.attach.mockReset().mockResolvedValue({ success: true, cols: 80, rows: 24 });
    terminalApiMock.detach.mockReset();
    terminalApiMock.expandSelection.mockReset().mockResolvedValue({ status: 'history-unavailable' });
    terminalApiMock.resize.mockReset().mockResolvedValue({ success: true });
    terminalApiMock.scroll.mockReset().mockResolvedValue({ success: true });
    terminalApiMock.unlockStdin.mockClear();
    terminalApiMock.write.mockClear();
    terminalFitMock.fitTerminalToContainer.mockReset().mockReturnValue({ cols: 80, rows: 24 });
    terminalFontsMock.loadTerminalFonts.mockReset().mockResolvedValue(undefined);
    searchAddonMock.clearDecorations.mockClear();
    searchAddonMock.findNext.mockClear();
    searchAddonMock.findPrevious.mockClear();
    searchAddonMock.onDidChangeResults.mockClear();
    webglAddonMock.instances.length = 0;
    webglAddonMock.state.constructorError = null;
    webglAddonMock.WebglAddon.mockClear();
    ipcMock.listeners.clear();
    ipcMock.on.mockClear();
    systemApiMock.clipboardRead.mockClear();
    systemApiMock.clipboardWrite.mockClear();
    document.documentElement.style.removeProperty('--accent');

    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    resizeObserverMock.callbacks.length = 0;
    mediaQueryMock.callbacks.length = 0;
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: ResizeObserverCallback) {
        resizeObserverMock.callbacks.push(callback);
      }

      observe = vi.fn();
      disconnect = vi.fn();
      unobserve = vi.fn();
    });
    vi.stubGlobal('matchMedia', vi.fn(() => ({
      addEventListener: vi.fn((_event: string, callback: () => void) => {
        mediaQueryMock.callbacks.push(callback);
      }),
      matches: false,
      media: '',
      removeEventListener: vi.fn(),
    })));
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('enables xterm modifier-forced selection for OpenCode mouse-mode panes', async () => {
    await renderTerminal();

    expect(terminalMock.constructorOptions[0]).toMatchObject({
      macOptionClickForcesSelection: true,
    });
  });

  it('enforces WCAG AA contrast correction for terminal glyphs', async () => {
    await renderTerminal();

    expect(terminalMock.constructorOptions[0]).toMatchObject({
      minimumContrastRatio: 4.5,
    });
  });

  it('uses WebGL rendering after xterm opens', async () => {
    const terminal = await renderTerminal();

    expect(webglAddonMock.WebglAddon).toHaveBeenCalledOnce();
    expect(terminal.loadAddon).toHaveBeenCalledWith(webglAddonMock.instances[0]);
  });

  it('falls back to the built-in renderer when WebGL initialization fails', async () => {
    webglAddonMock.state.constructorError = new Error('WebGL2 unavailable');

    await renderTerminal();

    expect(webglAddonMock.WebglAddon).toHaveBeenCalledOnce();
    expect(terminalApiMock.attach).toHaveBeenCalledOnce();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('disposes a partially initialized addon when xterm rejects WebGL activation', async () => {
    terminalMock.state.loadAddonError = new Error('WebGL renderer rejected');

    await renderTerminal();

    expect(webglAddonMock.instances[0].dispose).toHaveBeenCalledOnce();
    expect(terminalApiMock.attach).toHaveBeenCalledOnce();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('disposes WebGL and refreshes the terminal after context loss', async () => {
    const terminal = await renderTerminal();
    const addon = webglAddonMock.instances[0];

    act(() => addon.contextLossListeners[0]?.());

    expect(addon.dispose).toHaveBeenCalledOnce();
    expect(terminal.refresh).toHaveBeenCalledWith(0, terminal.rows - 1);
  });

  it('moves focus to the selected terminal when another pane still owns xterm focus', async () => {
    const previousTerminalInput = document.createElement('textarea');
    previousTerminalInput.className = 'xterm-helper-textarea';
    document.body.appendChild(previousTerminalInput);
    previousTerminalInput.focus();

    try {
      const terminal = await renderTerminal({}, makePane({ agentStatus: 'idle' }));
      await waitFor(() => expect(terminal.focus).toHaveBeenCalled());
    } finally {
      previousTerminalInput.remove();
    }
  });

  it('does not steal focus from a user-facing input when the selected terminal mounts', async () => {
    const dialogInput = document.createElement('input');
    document.body.appendChild(dialogInput);
    dialogInput.focus();

    try {
      const terminal = await renderTerminal({}, makePane({ agentStatus: 'idle' }));
      expect(terminal.focus).not.toHaveBeenCalled();
      expect(document.activeElement).toBe(dialogInput);
    } finally {
      dialogInput.remove();
    }
  });

  it('focuses the selected terminal after the pane creation dialog closes', async () => {
    const pane = makePane({ agentStatus: 'idle' });
    resetStores({}, pane);
    usePaneStore.setState({ isCreating: true });
    render(<InteractiveTerminal pane={pane} />);

    await waitFor(() => expect(terminalMock.instances).toHaveLength(1));
    const terminal = terminalMock.instances[0];
    expect(terminal.focus).not.toHaveBeenCalled();

    act(() => usePaneStore.setState({ isCreating: false }));

    await waitFor(() => expect(terminal.focus).toHaveBeenCalled());
  });

  it('re-enables stdin after the pane creation dialog opens then closes', async () => {
    const terminal = await renderTerminal({}, makePane({ agentStatus: 'idle' }));
    await waitFor(() => expect(terminal.options.disableStdin).toBe(false));

    // Opening the New Pane modal locks stdin on every mounted terminal so
    // typing into the modal can't leak into tmux.
    act(() => usePaneStore.setState({ isCreating: true }));
    expect(terminal.options.disableStdin).toBe(true);

    // Closing it must restore writable stdin — otherwise the pane stays
    // input-locked, which also silently kills wheel-driven scrolling.
    act(() => usePaneStore.setState({ isCreating: false }));
    await waitFor(() => expect(terminal.options.disableStdin).toBe(false));
  });

  it('keeps one live terminal across runtime-only store updates', async () => {
    const pane = makePane({ agentStatus: 'idle' });
    const terminal = await renderTerminal({}, pane);
    await waitFor(() => expect(terminal.options.disableStdin).toBe(false));

    act(() => {
      setPaneActivityState(pane.id, 'working');
      useAgentSessionStore.setState({
        sessions: {
          [pane.id]: {
            ...createEmptySession('opencode', 'session-1'),
            messages: [{
              content: 'A streamed update',
              id: 'message-1',
              toolCalls: [],
              toolResults: [],
              type: 'assistant',
            }],
          },
        },
      });
      useElectronSettingsStore.setState((state) => ({
        settings: state.settings
          ? { ...state.settings, copyOnSelect: true, terminalBell: true }
          : state.settings,
      }));
    });

    expect(terminalMock.instances).toEqual([terminal]);
    expect(terminalApiMock.attach).toHaveBeenCalledOnce();
    expect(terminalApiMock.detach).not.toHaveBeenCalled();
    expect(terminal.dispose).not.toHaveBeenCalled();
  });

  it('preserves the terminal for pane metadata changes but reconnects for transcript changes', async () => {
    const pane = makePane({ agentStatus: 'idle' });
    resetStores({}, pane);
    const view = render(<InteractiveTerminal pane={pane} />);
    await waitFor(() => expect(terminalApiMock.attach).toHaveBeenCalledOnce());
    const firstTerminal = terminalMock.instances[0];

    view.rerender(<InteractiveTerminal pane={{ ...pane, prompt: 'Updated description only' }} />);

    expect(terminalMock.instances).toHaveLength(1);
    expect(firstTerminal.dispose).not.toHaveBeenCalled();
    expect(terminalApiMock.detach).not.toHaveBeenCalled();

    view.rerender(<InteractiveTerminal
      pane={{ ...pane, terminalTranscriptPath: '/tmp/muxbase-pane-1-reconnected.log' }}
    />);

    await waitFor(() => expect(terminalMock.instances).toHaveLength(2));
    await waitFor(() => expect(terminalApiMock.attach).toHaveBeenCalledTimes(2));
    expect(firstTerminal.dispose).toHaveBeenCalledOnce();
    expect(terminalApiMock.detach).toHaveBeenCalledOnce();
  });

  it('does not open or attach a terminal after unmount wins the font-load race', async () => {
    const fonts = createDeferred<void>();
    terminalFontsMock.loadTerminalFonts.mockReturnValueOnce(fonts.promise);
    const pane = makePane({ agentStatus: 'idle' });
    resetStores({}, pane);
    const view = render(<InteractiveTerminal pane={pane} />);
    await waitFor(() => expect(terminalMock.instances).toHaveLength(1));
    const terminal = terminalMock.instances[0];

    view.unmount();
    await act(async () => {
      fonts.resolve(undefined);
      await fonts.promise;
    });

    expect(terminal.open).not.toHaveBeenCalled();
    expect(terminalApiMock.attach).not.toHaveBeenCalled();
    expect(terminal.dispose).toHaveBeenCalledOnce();
  });

  it('ignores an authoritative attach response that arrives after unmount', async () => {
    const attach = createDeferred<{
      cols: number;
      mode: 'pty';
      rows: number;
      success: true;
    }>();
    terminalApiMock.attach.mockReturnValueOnce(attach.promise);
    const pane = makePane({ agentStatus: 'idle' });
    resetStores({}, pane);
    const view = render(<InteractiveTerminal pane={pane} />);
    await waitFor(() => expect(terminalApiMock.attach).toHaveBeenCalledOnce());
    const terminal = terminalMock.instances[0];

    view.unmount();
    await act(async () => {
      attach.resolve({ cols: 80, mode: 'pty', rows: 24, success: true });
      await attach.promise;
    });

    expect(terminal.dispose).toHaveBeenCalledOnce();
    expect(terminalApiMock.unlockStdin).not.toHaveBeenCalled();
    expect(useTerminalStore.getState().attachedPaneIds.has(pane.id)).toBe(false);
  });

  it('drops a pending inertial tmux scroll batch as soon as the user types', async () => {
    vi.useFakeTimers();
    terminalApiMock.attach.mockResolvedValue({
      success: true,
      cols: 80,
      mode: 'pty',
      rows: 24,
    });
    const terminal = await renderTerminalWithFakeTimers({}, makePane({ agent: 'claude', agentStatus: 'idle' }));
    const container = terminal.element?.parentElement;
    expect(container).toBeTruthy();

    fireEvent.wheel(container!, { deltaMode: 0, deltaY: -48 });
    fireEvent.wheel(container!, { deltaMode: 0, deltaY: -48 });
    expect(terminalApiMock.scroll).toHaveBeenCalledTimes(1);

    act(() => terminal.dataListeners[0]?.('x'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });

    expect(terminalApiMock.write).toHaveBeenCalledWith({
      data: 'x',
      paneId: 'pane-1',
      userInitiated: false,
    });
    expect(terminalApiMock.scroll).toHaveBeenCalledTimes(1);
  });

  it('distinguishes keyboard input from terminal protocol replies', async () => {
    const terminal = await renderTerminal({}, makePane({ agentStatus: 'idle' }));
    expect(terminal.keyListeners).toHaveLength(1);

    act(() => terminal.dataListeners[0]?.('\x1b[0n'));
    expect(terminalApiMock.write).toHaveBeenLastCalledWith({
      data: '\x1b[0n',
      paneId: 'pane-1',
      userInitiated: false,
    });

    act(() => {
      terminal.keyListeners[0]?.();
      terminal.dataListeners[0]?.('x');
    });
    expect(terminalApiMock.write).toHaveBeenLastCalledWith({
      data: 'x',
      paneId: 'pane-1',
      userInitiated: true,
    });
  });

  it('drops a pending inertial scroll batch when a real terminal resize starts', async () => {
    vi.useFakeTimers();
    terminalApiMock.attach.mockResolvedValue({
      success: true,
      cols: 80,
      mode: 'pty',
      rows: 24,
    });
    const terminal = await renderTerminalWithFakeTimers({}, makePane({ agent: 'claude', agentStatus: 'idle' }));
    const container = terminal.element?.parentElement;
    expect(container).toBeTruthy();
    terminalApiMock.resize.mockClear();
    terminalApiMock.scroll.mockClear();
    terminalFitMock.fitTerminalToContainer.mockReturnValue({ cols: 96, rows: 24 });

    act(() => notifyTerminalResize());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(130);
    });
    fireEvent.wheel(container!, { deltaMode: 0, deltaY: -48 });
    fireEvent.wheel(container!, { deltaMode: 0, deltaY: -48 });
    expect(terminalApiMock.scroll).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(70);
    });

    expect(terminalApiMock.resize).toHaveBeenCalledWith({ cols: 96, paneId: 'pane-1', rows: 24 });
    expect(terminalApiMock.scroll).toHaveBeenCalledTimes(1);
  });

  it('drops opposite pending inertia and applies a wheel direction reversal immediately', async () => {
    vi.useFakeTimers();
    terminalApiMock.attach.mockResolvedValue({
      success: true,
      cols: 80,
      mode: 'pty',
      rows: 24,
    });
    const terminal = await renderTerminalWithFakeTimers({}, makePane({ agent: 'claude', agentStatus: 'idle' }));
    const container = terminal.element?.parentElement;
    expect(container).toBeTruthy();
    terminalApiMock.scroll.mockClear();

    fireEvent.wheel(container!, { deltaMode: 0, deltaY: -48 });
    fireEvent.wheel(container!, { deltaMode: 0, deltaY: -48 });
    fireEvent.wheel(container!, { deltaMode: 0, deltaY: 48 });

    expect(terminalApiMock.scroll).toHaveBeenNthCalledWith(1, expect.objectContaining({
      direction: 'up',
      lines: 2,
    }));
    expect(terminalApiMock.scroll).toHaveBeenNthCalledWith(2, expect.objectContaining({
      direction: 'down',
      lines: 2,
    }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });
    expect(terminalApiMock.scroll).toHaveBeenCalledTimes(2);
  });

  it('keeps continuous wheel input on one leading-and-trailing throttle cadence', async () => {
    vi.useFakeTimers();
    terminalApiMock.attach.mockResolvedValue({
      success: true,
      cols: 80,
      mode: 'pty',
      rows: 24,
    });
    const terminal = await renderTerminalWithFakeTimers({}, makePane({ agent: 'claude', agentStatus: 'idle' }));
    const container = terminal.element?.parentElement;
    expect(container).toBeTruthy();
    terminalApiMock.scroll.mockClear();

    fireEvent.wheel(container!, { deltaMode: 0, deltaY: -48 });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(39);
    });
    fireEvent.wheel(container!, { deltaMode: 0, deltaY: -48 });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });

    expect(terminalApiMock.scroll).toHaveBeenCalledTimes(2);

    fireEvent.wheel(container!, { deltaMode: 0, deltaY: -48 });
    expect(terminalApiMock.scroll).toHaveBeenCalledTimes(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(39);
    });
    expect(terminalApiMock.scroll).toHaveBeenCalledTimes(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(terminalApiMock.scroll).toHaveBeenCalledTimes(3);
  });

  it('preserves fractional classic-agent wheel motion after emitting an input step', async () => {
    const terminal = await renderTerminal({}, makePane({ agent: 'opencode', agentStatus: 'idle' }));
    const container = terminal.element?.parentElement;
    expect(container).toBeTruthy();
    terminalApiMock.write.mockClear();

    fireEvent.wheel(container!, { deltaMode: 0, deltaY: -45 });
    fireEvent.wheel(container!, { deltaMode: 0, deltaY: -15 });

    expect(terminalApiMock.write).toHaveBeenNthCalledWith(1, {
      data: '\x1b\x19\x1b\x19',
      paneId: 'pane-1',
      userInitiated: true,
    });
    expect(terminalApiMock.write).toHaveBeenNthCalledWith(2, {
      data: '\x1b\x19',
      paneId: 'pane-1',
      userInitiated: true,
    });
  });

  it('clears fractional wheel state when the terminal effect is recreated', async () => {
    const pane = makePane({ agent: 'opencode', agentStatus: 'idle' });
    const terminal = await renderTerminal({}, pane);
    const container = terminal.element?.parentElement;
    expect(container).toBeTruthy();
    terminalApiMock.write.mockClear();

    fireEvent.wheel(container!, { deltaMode: 0, deltaY: -8 });
    expect(terminalApiMock.write).not.toHaveBeenCalled();

    act(() => useElectronSettingsStore.setState((state) => ({
      settings: { ...state.settings, terminalFontSize: 15 },
    })));
    await waitFor(() => expect(terminalMock.instances).toHaveLength(2));
    await waitFor(() => expect(terminalApiMock.attach).toHaveBeenCalledTimes(2));
    const replacement = terminalMock.instances[1];
    const replacementContainer = replacement.element?.parentElement;
    expect(replacementContainer).toBeTruthy();

    fireEvent.wheel(replacementContainer!, { deltaMode: 0, deltaY: -12 });

    expect(terminalApiMock.write).not.toHaveBeenCalled();
  });

  it('drops pending tmux inertia when a TUI enables native mouse tracking', async () => {
    vi.useFakeTimers();
    terminalApiMock.attach.mockResolvedValue({
      success: true,
      cols: 80,
      mode: 'pty',
      rows: 24,
    });
    const terminal = await renderTerminalWithFakeTimers({}, makePane({ agent: 'claude', agentStatus: 'idle' }));
    const container = terminal.element?.parentElement;
    expect(container).toBeTruthy();
    terminalApiMock.scroll.mockClear();

    fireEvent.wheel(container!, { deltaMode: 0, deltaY: -48 });
    fireEvent.wheel(container!, { deltaMode: 0, deltaY: -48 });
    expect(terminalApiMock.scroll).toHaveBeenCalledTimes(1);

    terminal.modes.mouseTrackingMode = 'vt200';
    fireEvent.wheel(container!, { deltaMode: 0, deltaY: -48 });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });

    expect(terminalApiMock.scroll).toHaveBeenCalledTimes(1);
  });

  it('serializes a terminal-owned selection through mouse-reporting repaints', async () => {
    terminalApiMock.attach.mockResolvedValue({
      success: true,
      cols: 80,
      mode: 'pty',
      rows: 24,
      streamId: 1,
    });
    const terminal = await renderTerminal({}, makePane({ agent: 'claude', agentStatus: 'idle' }));
    await waitFor(() => expect(terminal.options.disableStdin).toBe(false));
    const attachRequest = terminalApiMock.attach.mock.calls.at(-1)?.[0];
    expect(attachRequest).toBeTruthy();
    const container = terminal.element?.parentElement;
    expect(container).toBeTruthy();
    terminal.modes.mouseTrackingMode = 'vt200';
    terminal.element!.getBoundingClientRect = () => ({
      bottom: 240,
      height: 240,
      left: 0,
      right: 800,
      top: 0,
      width: 800,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    const forwardedWheelEvents: WheelEvent[] = [];
    terminal.element!.addEventListener('wheel', (event) => forwardedWheelEvents.push(event));

    fireEvent.mouseDown(terminal.element!, {
      altKey: true,
      button: 0,
      buttons: 1,
      clientX: 10,
      clientY: 10,
      shiftKey: true,
    });
    terminal.selection = 'frame-01\nframe-02\nframe-03';
    terminal.selectionPosition = {
      end: { x: 8, y: 2 },
      start: { x: 0, y: 0 },
    };
    terminal.selectionChangeListeners.forEach((listener) => listener());

    const physicalWheel = fireEvent.wheel(container!, {
      clientX: 10,
      clientY: 238,
      deltaMode: 0,
      deltaY: 72,
    });

    expect(physicalWheel).toBe(false);
    expect(terminalApiMock.scroll).not.toHaveBeenCalled();
    expect(forwardedWheelEvents).toHaveLength(1);
    expect(forwardedWheelEvents[0]).toMatchObject({ deltaMode: 1, deltaY: 1 });

    terminal.selection = 'frame-02\nframe-03\nframe-04';
    ipcMock.listeners.get(IPC_EVENT.TERMINAL_DATA)?.({
      data: 'repaint-1',
      paneId: 'pane-1',
      source: 'live',
      streamId: attachRequest.streamId,
    });
    await waitFor(() => expect(forwardedWheelEvents).toHaveLength(2));
    terminal.selection = 'frame-03\nframe-04\nframe-05';
    ipcMock.listeners.get(IPC_EVENT.TERMINAL_DATA)?.({
      data: 'repaint-2',
      paneId: 'pane-1',
      source: 'live',
      streamId: attachRequest.streamId,
    });
    await waitFor(() => expect(forwardedWheelEvents).toHaveLength(2));
  });

  it('does not let wheel input bypass the agent startup stdin lock', async () => {
    terminalApiMock.attach.mockResolvedValue({
      success: true,
      cols: 80,
      mode: 'pty',
      rows: 24,
    });
    const terminal = await renderTerminal({}, makePane({ agent: 'claude', agentStatus: 'working' }));
    const container = terminal.element?.parentElement;
    expect(container).toBeTruthy();

    fireEvent.wheel(container!, { deltaMode: 0, deltaY: -96 });

    expect(terminalApiMock.scroll).not.toHaveBeenCalled();
    expect(terminalApiMock.write).not.toHaveBeenCalled();
  });

  it('drops a trailing tmux wheel batch if replay locks input before it flushes', async () => {
    vi.useFakeTimers();
    terminalApiMock.attach.mockResolvedValue({
      success: true,
      cols: 80,
      mode: 'pty',
      rows: 24,
    });
    const terminal = await renderTerminalWithFakeTimers({}, makePane({ agent: 'claude', agentStatus: 'idle' }));
    const container = terminal.element?.parentElement;
    expect(container).toBeTruthy();
    const attachRequest = terminalApiMock.attach.mock.calls.at(-1)?.[0];
    terminalApiMock.scroll.mockClear();

    fireEvent.wheel(container!, { deltaMode: 0, deltaY: -48 });
    fireEvent.wheel(container!, { deltaMode: 0, deltaY: -48 });
    expect(terminalApiMock.scroll).toHaveBeenCalledTimes(1);

    terminal.write.mockImplementationOnce(() => undefined);
    ipcMock.listeners.get(IPC_EVENT.TERMINAL_DATA)?.({
      data: 'authoritative replay',
      paneId: 'pane-1',
      source: 'replay',
      streamId: attachRequest.streamId,
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });

    expect(terminalApiMock.scroll).toHaveBeenCalledTimes(1);
  });

  it('does not read or send clipboard text while terminal input is locked', async () => {
    systemApiMock.clipboardRead.mockResolvedValue('stale-paste');
    const terminal = await renderTerminal({}, makePane({ agent: 'claude', agentStatus: 'working' }));
    const container = terminal.element?.parentElement;
    expect(container).toBeTruthy();

    fireEvent.paste(container!);
    await act(async () => {
      await Promise.resolve();
    });

    expect(systemApiMock.clipboardRead).not.toHaveBeenCalled();
    expect(terminalApiMock.write).not.toHaveBeenCalled();
  });

  it('does not paste while an authoritative replay write suppresses input', async () => {
    const terminal = await renderTerminal({}, makePane({ agent: 'claude', agentStatus: 'idle' }));
    await waitFor(() => expect(terminal.options.disableStdin).toBe(false));
    const attachRequest = terminalApiMock.attach.mock.calls.at(-1)?.[0];
    terminal.write.mockImplementationOnce(() => undefined);

    ipcMock.listeners.get(IPC_EVENT.TERMINAL_DATA)?.({
      data: 'authoritative replay',
      paneId: 'pane-1',
      source: 'replay',
      streamId: attachRequest.streamId,
    });
    expect(terminal.write).toHaveBeenCalledWith('authoritative replay', expect.any(Function));

    systemApiMock.clipboardRead.mockClear().mockResolvedValue('stale-paste');
    terminalApiMock.write.mockClear();
    const container = terminal.element?.parentElement;
    expect(container).toBeTruthy();
    fireEvent.paste(container!);
    await act(async () => {
      await Promise.resolve();
    });

    expect(systemApiMock.clipboardRead).not.toHaveBeenCalled();
    expect(terminalApiMock.write).not.toHaveBeenCalled();
  });

  it('discards clipboard text when authoritative replay starts while the read is pending', async () => {
    const clipboard = createDeferred<string>();
    systemApiMock.clipboardRead.mockReturnValue(clipboard.promise);
    const terminal = await renderTerminal({}, makePane({ agent: 'claude', agentStatus: 'idle' }));
    await waitFor(() => expect(terminal.options.disableStdin).toBe(false));
    const attachRequest = terminalApiMock.attach.mock.calls.at(-1)?.[0];
    const container = terminal.element?.parentElement;
    expect(container).toBeTruthy();

    fireEvent.paste(container!);
    expect(systemApiMock.clipboardRead).toHaveBeenCalledOnce();

    terminal.write.mockImplementationOnce(() => undefined);
    ipcMock.listeners.get(IPC_EVENT.TERMINAL_DATA)?.({
      data: 'authoritative replay',
      paneId: 'pane-1',
      source: 'replay',
      streamId: attachRequest.streamId,
    });
    expect(terminal.write).toHaveBeenCalledWith('authoritative replay', expect.any(Function));

    await act(async () => {
      clipboard.resolve('stale-paste');
      await clipboard.promise;
    });

    expect(terminalApiMock.write).not.toHaveBeenCalled();
  });

  it('discards clipboard text when replay starts and finishes while the read is pending', async () => {
    const clipboard = createDeferred<string>();
    systemApiMock.clipboardRead.mockReturnValue(clipboard.promise);
    const terminal = await renderTerminal({}, makePane({ agent: 'claude', agentStatus: 'idle' }));
    await waitFor(() => expect(terminal.options.disableStdin).toBe(false));
    const attachRequest = terminalApiMock.attach.mock.calls.at(-1)?.[0];
    const container = terminal.element?.parentElement;
    expect(container).toBeTruthy();

    fireEvent.paste(container!);
    expect(systemApiMock.clipboardRead).toHaveBeenCalledOnce();

    let completeReplay: (() => void) | undefined;
    terminal.write.mockImplementationOnce((_data: string, callback?: () => void) => {
      completeReplay = callback;
    });
    ipcMock.listeners.get(IPC_EVENT.TERMINAL_DATA)?.({
      data: 'authoritative replay',
      paneId: 'pane-1',
      source: 'replay',
      streamId: attachRequest.streamId,
    });
    expect(completeReplay).toBeTypeOf('function');
    act(() => completeReplay?.());

    await act(async () => {
      clipboard.resolve('stale-paste');
      await clipboard.promise;
    });

    expect(terminalApiMock.write).not.toHaveBeenCalled();
  });

  it('routes PTY OpenCode wheel input through the live tmux screen state', async () => {
    terminalApiMock.attach.mockResolvedValue({
      success: true,
      cols: 80,
      mode: 'pty',
      rows: 24,
    });
    const terminal = await renderTerminal({}, makePane({ agent: 'opencode', agentStatus: 'idle' }));
    const container = terminal.element?.parentElement;
    expect(container).toBeTruthy();

    fireEvent.wheel(container!, { deltaMode: 0, deltaY: -48 });

    expect(terminalApiMock.scroll).toHaveBeenCalledWith({
      alternateScreenMode: 'opencode',
      direction: 'up',
      lines: 2,
      paneId: 'pane-1',
    });
    expect(terminalApiMock.write).not.toHaveBeenCalled();
  });

  it('uses live tmux routing when OpenCode passthrough is enabled but mouse mode is inactive', async () => {
    terminalApiMock.attach.mockResolvedValue({
      success: true,
      cols: 80,
      mode: 'pty',
      rows: 24,
    });
    const terminal = await renderTerminal(
      { opencodeMousePassthrough: true },
      makePane({ agent: 'opencode', agentStatus: 'idle' }),
    );
    const container = terminal.element?.parentElement;
    expect(container).toBeTruthy();

    fireEvent.wheel(container!, { deltaMode: 0, deltaY: -48 });

    expect(terminalApiMock.scroll).toHaveBeenCalledWith(expect.objectContaining({
      alternateScreenMode: 'opencode',
      direction: 'up',
      lines: 2,
    }));
  });

  it('surfaces initialization failures and reconnects with a fresh terminal', async () => {
    terminalMock.state.openError = new Error('xterm renderer unavailable');
    const pane = makePane({ agentStatus: 'idle' });
    resetStores({}, pane);
    render(<InteractiveTerminal pane={pane} />);

    expect((await screen.findByRole('alert')).textContent).toContain('xterm renderer unavailable');
    expect(screen.getByText('Terminal unavailable')).toBeTruthy();
    expect(terminalApiMock.attach).not.toHaveBeenCalled();
    expect(terminalMock.instances[0]?.dispose).toHaveBeenCalledOnce();

    terminalMock.state.openError = null;
    fireEvent.click(screen.getByRole('button', { name: 'Reconnect terminal' }));

    await waitFor(() => expect(terminalMock.instances).toHaveLength(2));
    await waitFor(() => expect(terminalApiMock.attach).toHaveBeenCalledOnce());
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('keeps shell stdin locked until authoritative attach succeeds', async () => {
    const attach = createDeferred<{ success: boolean; cols: number; rows: number }>();
    terminalApiMock.attach.mockReturnValue(attach.promise);
    const pane = makePane({
      agent: undefined,
      agentStatus: 'idle',
      type: 'shell',
    });
    resetStores({}, pane);
    render(<InteractiveTerminal pane={pane} />);

    await waitFor(() => expect(terminalApiMock.attach).toHaveBeenCalledOnce());
    const terminal = terminalMock.instances[0];
    expect(terminal.options.disableStdin).toBe(true);
    act(() => terminal.dataListeners[0]?.('premature input'));
    expect(terminalApiMock.write).not.toHaveBeenCalled();

    await act(async () => {
      attach.resolve({ success: true, cols: 80, rows: 24 });
      await attach.promise;
    });

    expect(terminal.options.disableStdin).toBe(false);
    act(() => terminal.dataListeners[0]?.('ready input'));
    expect(terminalApiMock.write).toHaveBeenCalledWith({
      data: 'ready input',
      paneId: pane.id,
      userInitiated: false,
    });
  });

  it('keeps shell stdin locked while attach is rejected and after retries are exhausted', async () => {
    vi.useFakeTimers();
    terminalApiMock.attach.mockResolvedValue({
      success: false,
      error: 'tmux pane unavailable',
    });
    const pane = makePane({
      agent: undefined,
      agentStatus: 'idle',
      type: 'shell',
    });

    const terminal = await renderTerminalWithFakeTimers({}, pane);
    expect(terminal.options.disableStdin).toBe(true);

    await exhaustAttachRejectionRetries();

    expect(screen.getByRole('alert')).toBeTruthy();
    expect(terminal.options.disableStdin).toBe(true);
    act(() => terminal.dataListeners[0]?.('lost input'));
    expect(terminalApiMock.write).not.toHaveBeenCalled();
    expect(terminalApiMock.unlockStdin).not.toHaveBeenCalled();
  });

  it('uses the canonical persisted terminalFixedCols for fitting and the terminal attach contract', async () => {
    await renderTerminal({}, makePane({
      agent: 'claude',
      claudeRenderer: 'classic',
      terminalFixedCols: 100,
    }));

    expect(terminalFitMock.fitTerminalToContainer).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ fixedCols: 100 }),
    );
    expect(terminalApiMock.attach).toHaveBeenCalledWith(expect.objectContaining({
      fixedCols: 100,
    }));
  });

  it('shows the fullscreen empty state only for a conclusively hydrated empty session', async () => {
    const pane = makePane({
      agent: 'claude',
      agentStatus: 'idle',
      claudeRenderer: 'fullscreen',
      terminalFixedCols: undefined,
    });
    await renderTerminal({}, pane);

    expect(screen.queryByTestId('terminal-empty-state')).toBeNull();

    const emptySession = createEmptySession('claude', 'session-1');
    act(() => useAgentSessionStore.setState({
      sessions: { [pane.id]: emptySession },
    }));
    expect(screen.getByTestId('terminal-empty-state')).toBeTruthy();

    act(() => useAgentSessionStore.setState({
      sessions: {
        [pane.id]: {
          ...emptySession,
          messages: [{
            content: 'Existing conversation',
            id: 'message-1',
            toolCalls: [],
            toolResults: [],
            type: 'user',
          }],
        },
      },
    }));
    expect(screen.queryByTestId('terminal-empty-state')).toBeNull();
  });

  it('pauses boot for a session awaiting input instead of completing on raw idle, and can restart after the user answers', async () => {
    // Arrange — boot overlay starts visible (a genuinely booting agent), then
    // the session reports a boot-time prompt in the same beat the arbiter
    // resolves agentStatus to 'idle' (awaiting_input -> idle). sessionWaiting
    // must still win so the boot effect pauses instead of completing.
    const pane = makePane({ agent: 'claude', agentStatus: 'working' });
    resetStores({}, pane);
    const { rerender } = render(<InteractiveTerminal pane={pane} />);
    await waitFor(() => expect(terminalMock.instances).toHaveLength(1));
    await waitFor(() => expect(terminalApiMock.attach).toHaveBeenCalled());
    const terminal = terminalMock.instances[0];
    expect(screen.getByTestId('terminal-boot-overlay').getAttribute('data-booting')).toBe('true');

    // Act — session and resolved activity land together
    act(() => {
      useAgentSessionStore.setState({
        sessions: { [pane.id]: { ...createEmptySession('claude', 'session-1'), awaitingUserInput: true } },
      });
      setPaneActivityState(pane.id, 'idle');
    });
    rerender(<InteractiveTerminal pane={pane} />);

    // Assert — the overlay is dismissed for the prompt either way...
    expect(screen.getByTestId('terminal-boot-overlay').getAttribute('data-booting')).toBe('false');

    // Act — the user answers the prompt and presses Enter
    act(() => terminal.dataListeners[0]?.('\r'));

    // Assert — ...but boot tracking was only paused, not completed, so it can
    // resume. If the idle branch had won, startupCompleteRef would already be
    // permanently set and this keypress would be a no-op.
    expect(screen.getByTestId('terminal-boot-overlay').getAttribute('data-booting')).toBe('true');
  });

  it('honors a session that is already awaiting input before the terminal mounts', async () => {
    const pane = makePane({ agent: 'claude', agentStatus: 'working' });
    resetStores({}, pane);
    useAgentSessionStore.setState({
      sessions: {
        [pane.id]: {
          ...createEmptySession('claude', 'session-1'),
          awaitingUserInput: true,
        },
      },
    });
    usePaneActivityStore.setState({ activityByPaneId: {}, justFinishedPaneIds: new Set() });

    render(<InteractiveTerminal pane={pane} />);
    await waitFor(() => expect(terminalMock.instances).toHaveLength(1));
    await waitFor(() => expect(terminalApiMock.attach).toHaveBeenCalled());

    expect(screen.getByTestId('terminal-boot-overlay').getAttribute('data-booting')).toBe('false');
    await waitFor(() => {
      expect(terminalApiMock.unlockStdin).toHaveBeenCalledWith({ paneId: pane.id });
    });
  });

  it('completes boot from runtime activity even while the legacy agentStatus is stale', async () => {
    // Arrange — the arbiter has not caught up to 'idle' yet, but PaneActivity has.
    const pane = makePane({ agent: 'claude', agentStatus: 'working' });
    resetStores({}, pane);
    render(<InteractiveTerminal pane={pane} />);
    await waitFor(() => expect(terminalMock.instances).toHaveLength(1));
    await waitFor(() => expect(terminalApiMock.attach).toHaveBeenCalled());
    expect(screen.getByTestId('terminal-boot-overlay').getAttribute('data-booting')).toBe('true');

    // Act
    act(() => {
      usePaneActivityStore.setState({
        activityByPaneId: { [pane.id]: makeActivity({ state: 'idle' }) },
      });
    });

    // Assert
    expect(screen.getByTestId('terminal-boot-overlay').getAttribute('data-booting')).toBe('false');
  });

  it('does not re-render for streaming updates to an already populated session', async () => {
    const pane = makePane({
      agent: 'claude',
      agentStatus: 'idle',
      claudeRenderer: 'fullscreen',
      terminalFixedCols: undefined,
    });
    const populatedSession = {
      ...createEmptySession('claude', 'session-1'),
      messages: [{
        content: 'Existing conversation',
        id: 'message-1',
        toolCalls: [],
        toolResults: [],
        type: 'user' as const,
      }],
    };
    resetStores({}, pane);
    useAgentSessionStore.setState({ sessions: { [pane.id]: populatedSession } });
    let renderCount = 0;
    render(
      <React.Profiler id="terminal" onRender={() => { renderCount += 1; }}>
        <InteractiveTerminal pane={pane} />
      </React.Profiler>,
    );
    await waitFor(() => expect(terminalApiMock.attach).toHaveBeenCalled());
    const settledRenderCount = renderCount;

    act(() => useAgentSessionStore.setState({
      sessions: {
        [pane.id]: {
          ...populatedSession,
          messages: [{
            ...populatedSession.messages[0],
            content: 'Existing conversation with streamed content',
          }],
        },
      },
    }));

    expect(renderCount).toBe(settledRenderCount);
  });

  it('uses the current theme accent for every terminal search', async () => {
    document.documentElement.style.setProperty('--accent', '#112233');
    const terminal = await renderTerminal({}, makePane({ agentStatus: 'idle' }));
    const keyHandler = terminal.attachCustomKeyEventHandler.mock.calls[0]?.[0] as ((event: KeyboardEvent) => boolean) | undefined;
    expect(keyHandler).toBeTruthy();

    act(() => {
      keyHandler?.({
        ctrlKey: false,
        key: 'f',
        metaKey: true,
        preventDefault: vi.fn(),
        shiftKey: false,
        stopPropagation: vi.fn(),
        type: 'keydown',
      } as unknown as KeyboardEvent);
    });
    const input = await screen.findByPlaceholderText('Find in terminal');
    fireEvent.change(input, { target: { value: 'first' } });
    await waitFor(() => expect(searchAddonMock.findNext).toHaveBeenCalled());
    expect(searchAddonMock.findNext.mock.calls.at(-1)?.[1]).toMatchObject({
      decorations: {
        activeMatchBorder: TERMINAL_FOREGROUND_COLORS.dark,
        matchBackground: '#112233',
      },
    });

    document.documentElement.style.setProperty('--accent', '#445566');
    fireEvent.change(input, { target: { value: 'second' } });
    await waitFor(() => {
      expect(searchAddonMock.findNext.mock.calls.at(-1)?.[1]).toMatchObject({
        decorations: { matchBackground: '#445566' },
      });
    });
  });

  it('repaints the live terminal grid when the app theme changes', async () => {
    const terminal = await renderTerminal();
    const readBackground = () => (terminal.options.theme as TerminalTheme).background;
    expect(readBackground()).toBe(TERMINAL_BACKGROUND_COLORS.dark);

    act(() => document.documentElement.setAttribute('data-theme', 'light'));
    await waitFor(() => expect(readBackground()).toBe(TERMINAL_BACKGROUND_COLORS.light));

    act(() => document.documentElement.setAttribute('data-theme', 'dark'));
    await waitFor(() => expect(readBackground()).toBe(TERMINAL_BACKGROUND_COLORS.dark));
  });

  it('adopts a theme switch that lands while the terminal fonts are still loading', async () => {
    const fonts = createDeferred<void>();
    terminalFontsMock.loadTerminalFonts.mockReturnValueOnce(fonts.promise);
    const pane = makePane({ agentStatus: 'idle' });
    resetStores({}, pane);
    render(<InteractiveTerminal pane={pane} />);
    await waitFor(() => expect(terminalMock.instances).toHaveLength(1));
    const terminal = terminalMock.instances[0];

    await act(async () => {
      document.documentElement.setAttribute('data-theme', 'light');
      await Promise.resolve();
    });
    await act(async () => {
      fonts.resolve(undefined);
      await fonts.promise;
    });

    await waitFor(() => expect((terminal.options.theme as TerminalTheme).background)
      .toBe(TERMINAL_BACKGROUND_COLORS.light));
    act(() => document.documentElement.setAttribute('data-theme', 'dark'));
  });

  it('retries a fitted size after the main process rejects the previous resize', async () => {
    terminalFitMock.fitTerminalToContainer
      .mockReturnValueOnce({ cols: 80, rows: 24 })
      .mockReturnValue({ cols: 120, rows: 30 });
    terminalApiMock.resize
      .mockResolvedValueOnce({ success: false, error: 'source geometry mismatch' })
      .mockResolvedValue({ success: true });

    await renderTerminal();
    await waitFor(() => expect(terminalApiMock.resize).toHaveBeenCalledTimes(2));
    expect(terminalApiMock.resize).toHaveBeenLastCalledWith({
      cols: 120,
      paneId: 'pane-1',
      rows: 30,
    });
  });

  it('refreshes a font-only layout refit without clearing the shared WebGL glyph atlas', async () => {
    const terminal = await renderTerminal();
    await waitFor(() => expect(terminal.refresh).toHaveBeenCalled());
    terminal.clearTextureAtlas.mockClear();
    terminal.refresh.mockClear();
    terminalFitMock.fitTerminalToContainer.mockImplementation(() => {
      terminal.options.fontSize = 8;
      return { cols: 100, rows: 12 };
    });

    act(() => notifyTerminalResize());

    await waitFor(() => expect(terminal.refresh).toHaveBeenCalledWith(0, terminal.rows - 1));
    expect(terminal.clearTextureAtlas).not.toHaveBeenCalled();
  });

  it('refreshes a device-pixel-ratio change without clearing the shared WebGL glyph atlas', async () => {
    const terminal = await renderTerminal();
    terminal.clearTextureAtlas.mockClear();
    terminal.refresh.mockClear();

    act(() => mediaQueryMock.callbacks.at(-1)?.());

    expect(terminal.clearTextureAtlas).not.toHaveBeenCalled();
    expect(terminal.refresh).toHaveBeenCalledWith(0, terminal.rows - 1);
  });

  it('serializes resize IPC and drains only the latest size after the in-flight request settles', async () => {
    const firstResize = createDeferred<{ success: boolean }>();
    const secondResize = createDeferred<{ success: boolean }>();
    terminalFitMock.fitTerminalToContainer
      .mockReturnValueOnce({ cols: 80, rows: 24 })
      .mockReturnValueOnce({ cols: 120, rows: 30 })
      .mockReturnValue({ cols: 140, rows: 34 });
    terminalApiMock.resize
      .mockReturnValueOnce(firstResize.promise)
      .mockReturnValueOnce(secondResize.promise);

    await renderTerminal();
    await waitFor(() => expect(terminalApiMock.resize).toHaveBeenCalledTimes(1));
    expect(terminalApiMock.resize).toHaveBeenLastCalledWith({
      cols: 120,
      paneId: 'pane-1',
      rows: 30,
    });

    act(() => notifyTerminalResize());
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(terminalApiMock.resize).toHaveBeenCalledTimes(1);

    await act(async () => {
      firstResize.resolve({ success: true });
      await firstResize.promise;
    });
    await waitFor(() => expect(terminalApiMock.resize).toHaveBeenCalledTimes(2));
    expect(terminalApiMock.resize).toHaveBeenLastCalledWith({
      cols: 140,
      paneId: 'pane-1',
      rows: 34,
    });

    await act(async () => {
      secondResize.resolve({ success: true });
      await secondResize.promise;
    });
  });

  it('shows reconnect recovery after bounded terminal resize retries are exhausted', async () => {
    terminalFitMock.fitTerminalToContainer
      .mockReturnValueOnce({ cols: 80, rows: 24 })
      .mockReturnValue({ cols: 120, rows: 30 });
    terminalApiMock.resize.mockResolvedValue({ success: false, error: 'source geometry mismatch' });

    await renderTerminal();

    expect(await screen.findByText('source geometry mismatch')).toBeTruthy();
    expect(screen.getByText('Terminal resize failed')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain('source geometry mismatch');
    expect(screen.getByRole('button', { name: 'Reconnect terminal' })).toBeTruthy();
    expect(terminalApiMock.resize).toHaveBeenCalledTimes(3);
  });

  it('surfaces fit exhaustion and self-heals when a later ResizeObserver measurement succeeds', async () => {
    vi.useFakeTimers();
    terminalFitMock.fitTerminalToContainer.mockReturnValue(null);

    await renderTerminalWithFakeTimers();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6_000);
    });

    expect(screen.getByRole('alert').textContent).toContain('could not measure');
    expect(screen.queryByRole('status')).toBeNull();
    expect(terminalApiMock.attach).not.toHaveBeenCalled();

    terminalFitMock.fitTerminalToContainer.mockReturnValue({ cols: 80, rows: 24 });
    await act(async () => {
      notifyTerminalResize();
      await Promise.resolve();
    });

    expect(terminalApiMock.attach).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows a self-healing pane-too-narrow state for unreadable fixed-grid fits', async () => {
    vi.useFakeTimers();
    terminalFitMock.fitTerminalToContainer.mockImplementation((
      _fitAddon,
      _terminal,
      _container,
      options,
    ) => {
      options?.onFailure?.('too-narrow');
      return null;
    });

    await renderTerminalWithFakeTimers({}, makePane({
      agent: 'claude',
      claudeRenderer: 'classic',
      terminalFixedCols: 100,
    }));

    expect(screen.getByRole('alert').textContent).toContain('Pane is too narrow');
    expect(terminalApiMock.attach).not.toHaveBeenCalled();

    terminalFitMock.fitTerminalToContainer.mockReturnValue({ cols: 100, rows: 24 });
    terminalApiMock.attach.mockResolvedValue({ success: true, cols: 100, rows: 24 });
    await act(async () => {
      notifyTerminalResize();
      await Promise.resolve();
    });

    expect(terminalApiMock.attach).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('keeps attach output buffered beyond the old early-flush window until authoritative geometry arrives', async () => {
    vi.useFakeTimers();
    const attach = createDeferred<{ success: boolean; cols: number; rows: number; mode: 'pty' }>();
    terminalApiMock.attach.mockReturnValue(attach.promise);
    const terminal = await renderTerminalWithFakeTimers();
    const attachRequest = terminalApiMock.attach.mock.calls.at(-1)?.[0];
    expect(attachRequest).toBeTruthy();

    ipcMock.listeners.get(IPC_EVENT.TERMINAL_DATA)?.({
      data: 'authoritative repaint',
      paneId: 'pane-1',
      source: 'live',
      streamId: attachRequest.streamId,
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_600);
    });
    expect(terminal.write).not.toHaveBeenCalled();
    expect(useTerminalStore.getState().seenPaneIds.has('pane-1')).toBe(false);

    await act(async () => {
      attach.resolve({ success: true, cols: 80, rows: 24, mode: 'pty' });
      await attach.promise;
    });
    expect(terminal.write).toHaveBeenCalledWith('authoritative repaint', expect.any(Function));
  });

  it('discards buffered output on a rejected attach and detaches once retries are exhausted', async () => {
    vi.useFakeTimers();
    const attach = createDeferred<{ success: boolean; error?: string }>();
    terminalApiMock.attach
      .mockReturnValueOnce(attach.promise)
      .mockResolvedValue({ success: false, error: 'authoritative attach rejected' });
    const terminal = await renderTerminalWithFakeTimers();
    const attachRequest = terminalApiMock.attach.mock.calls.at(-1)?.[0];

    ipcMock.listeners.get(IPC_EVENT.TERMINAL_DATA)?.({
      data: 'must not render',
      paneId: 'pane-1',
      source: 'live',
      streamId: attachRequest.streamId,
    });
    await act(async () => {
      attach.resolve({ success: false, error: 'authoritative attach rejected' });
      await attach.promise;
    });

    expect(terminal.write).not.toHaveBeenCalled();
    expect(useTerminalStore.getState().seenPaneIds.has('pane-1')).toBe(false);
    expect(terminalApiMock.detach).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Reconnect terminal' })).toBeNull();

    await exhaustAttachRejectionRetries();

    expect(terminalApiMock.detach).toHaveBeenCalledWith({ paneId: 'pane-1' });
    expect(screen.getByRole('button', { name: 'Reconnect terminal' })).toBeTruthy();
  });

  it('fails closed when authoritative attach geometry violates the persisted fixed grid', async () => {
    const attach = createDeferred<{ success: boolean; cols: number; rows: number }>();
    terminalApiMock.attach.mockReturnValue(attach.promise);
    const terminal = await renderTerminal({}, makePane({
      agent: 'claude',
      claudeRenderer: 'classic',
      terminalFixedCols: 100,
    }));
    const attachRequest = terminalApiMock.attach.mock.calls.at(-1)?.[0];

    ipcMock.listeners.get(IPC_EVENT.TERMINAL_DATA)?.({
      data: 'wrong-grid repaint',
      paneId: 'pane-1',
      source: 'live',
      streamId: attachRequest.streamId,
    });
    await act(async () => {
      attach.resolve({ success: true, cols: 80, rows: 24 });
      await attach.promise;
    });

    expect(screen.getByRole('alert').textContent).toContain('fixed 100-column profile');
    expect(terminal.write).not.toHaveBeenCalled();
    expect(terminalApiMock.detach).toHaveBeenCalledWith({ paneId: 'pane-1' });
  });

  it('fails closed when the pre-attach output buffer exceeds its byte limit', async () => {
    const attach = createDeferred<{ success: boolean; cols: number; rows: number }>();
    terminalApiMock.attach.mockReturnValue(attach.promise);
    const terminal = await renderTerminal();
    const attachRequest = terminalApiMock.attach.mock.calls.at(-1)?.[0];

    ipcMock.listeners.get(IPC_EVENT.TERMINAL_DATA)?.({
      data: 'x'.repeat((1024 * 1024) + 1),
      paneId: 'pane-1',
      source: 'live',
      streamId: attachRequest.streamId,
    });

    expect((await screen.findByRole('alert')).textContent).toContain('safe buffer');
    expect(terminal.write).not.toHaveBeenCalled();
    expect(terminalApiMock.detach).toHaveBeenCalledWith({ paneId: 'pane-1' });
    expect(screen.getByRole('button', { name: 'Reconnect terminal' })).toBeTruthy();
  });

  it('times out an unanswered attach without flushing output and offers reconnect', async () => {
    vi.useFakeTimers();
    const attach = createDeferred<{ success: boolean; cols: number; rows: number }>();
    terminalApiMock.attach.mockReturnValue(attach.promise);
    const terminal = await renderTerminalWithFakeTimers();
    const attachRequest = terminalApiMock.attach.mock.calls.at(-1)?.[0];

    ipcMock.listeners.get(IPC_EVENT.TERMINAL_DATA)?.({
      data: 'must remain quarantined',
      paneId: 'pane-1',
      source: 'live',
      streamId: attachRequest.streamId,
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });

    expect(screen.getByRole('alert').textContent).toContain('timed out');
    expect(terminal.write).not.toHaveBeenCalled();
    expect(terminalApiMock.detach).toHaveBeenCalledWith({ paneId: 'pane-1' });
    expect(terminalApiMock.unlockStdin).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Reconnect terminal' })).toBeTruthy();
  });

  it('keeps hidden boot overlays out of the accessibility tree and makes active progress polite', async () => {
    await renderTerminal();
    const activeOverlay = screen.getByTestId('terminal-boot-overlay');
    expect(activeOverlay.getAttribute('aria-hidden')).toBe('false');
    expect(activeOverlay.getAttribute('aria-live')).toBe('polite');
    expect(activeOverlay.getAttribute('role')).toBe('status');
    expect(activeOverlay.className).toContain('motion-reduce:transition-none');
    expect(activeOverlay.querySelectorAll('.motion-reduce\\:animate-none').length).toBeGreaterThan(0);

    cleanup();
    terminalMock.instances.length = 0;
    terminalApiMock.attach.mockClear();
    await renderTerminal({}, makePane({ agentStatus: 'idle' }));
    const hiddenOverlay = screen.getByTestId('terminal-boot-overlay');
    expect(hiddenOverlay.getAttribute('aria-hidden')).toBe('true');
    expect(hiddenOverlay.getAttribute('aria-live')).toBeNull();
    expect(hiddenOverlay.getAttribute('role')).toBeNull();
  });

  it('stops scanning output for boot markers after startup is complete', async () => {
    // Arrange
    const bootReady = vi.spyOn(terminalBootDetection, 'isAgentBootReady');
    await renderTerminal({}, makePane({ agentStatus: 'idle' }));
    const attachRequest = terminalApiMock.attach.mock.calls.at(-1)?.[0];
    bootReady.mockClear();

    // Act
    ipcMock.listeners.get(IPC_EVENT.TERMINAL_DATA)?.({
      data: 'steady-state terminal output',
      paneId: 'pane-1',
      source: 'live',
      streamId: attachRequest.streamId,
    });

    // Assert
    expect(bootReady).not.toHaveBeenCalled();
  });

  it('disables EOL conversion for raw PTY streams without transcript files', async () => {
    await renderTerminal({ terminalTransport: 'pty' }, makePane({
      agent: undefined,
      agentStatus: 'idle',
      terminalTranscriptPath: undefined,
      type: 'shell',
      worktreePath: '/repo',
    }));

    expect(terminalMock.constructorOptions[0]).toMatchObject({
      convertEol: false,
    });
  });

  it('activates modern unicode widths so tmux-measured emoji stay aligned', async () => {
    const terminal = await renderTerminal();

    expect(terminal.unicode.register).toHaveBeenCalledWith(expect.objectContaining({
      version: '15-graphemes-tmux',
    }));
    expect(terminal.unicode.activeVersion).toBe('15-graphemes-tmux');
  });

  it('copies selected terminal text when copy-on-select is enabled', async () => {
    const terminal = await renderTerminal({ copyOnSelect: true });
    terminal.selection = 'OpenCode agent response';

    terminal.selectionChangeListeners.forEach((listener) => listener());

    expect(clipboardWrite).toHaveBeenCalledWith('OpenCode agent response');
  });

  it('copies the authoritative range when a PTY selection spans repainted viewports', async () => {
    terminalApiMock.attach.mockResolvedValue({
      cols: 80,
      mode: 'pty',
      rows: 24,
      streamId: 1,
      success: true,
    });
    terminalApiMock.expandSelection.mockResolvedValue({
      status: 'expanded',
      text: 'first viewport\nmiddle viewport\nlast viewport',
    });
    const terminal = await renderTerminal({}, makePane({ agentStatus: 'idle' }));
    await waitFor(() => expect(terminal.options.disableStdin).toBe(false));
    const container = terminal.element?.parentElement;
    expect(container).toBeTruthy();
    terminal.selection = 'first viewport';

    fireEvent.mouseDown(terminal.element!, { button: 0 });
    fireEvent.wheel(container!, { deltaMode: 0, deltaY: 48 });
    terminal.selection = 'last viewport';
    fireEvent.copy(container!);

    await waitFor(() => expect(terminalApiMock.expandSelection).toHaveBeenCalledWith({
      anchorText: 'first viewport',
      currentText: 'last viewport',
      direction: 'down',
      paneId: 'pane-1',
    }));
    await waitFor(() => expect(clipboardWrite).toHaveBeenCalledWith(
      'first viewport\nmiddle viewport\nlast viewport',
    ));
  });

  it('copies a verified client range silently when normal-screen history cannot align it', async () => {
    terminalApiMock.attach.mockResolvedValue({
      cols: 80,
      mode: 'pty',
      rows: 24,
      streamId: 1,
      success: true,
    });
    terminalApiMock.expandSelection.mockResolvedValue({ status: 'range-not-found' });
    const terminal = await renderTerminal({}, makePane({
      agent: undefined,
      agentStatus: 'idle',
      type: 'shell',
    }));
    await waitFor(() => expect(terminal.options.disableStdin).toBe(false));
    const container = terminal.element?.parentElement;
    expect(container).toBeTruthy();
    terminal.selection = 'soft-wrapped anchor\nshared wrapped row 1\nshared wrapped row 2';

    fireEvent.mouseDown(terminal.element!, { button: 0 });
    fireEvent.wheel(container!, { deltaMode: 0, deltaY: 48 });
    terminal.selection = 'shared wrapped row 1\nshared wrapped row 2\nvisible soft-wrapped tail';
    fireEvent.mouseUp(document, { button: 0 });
    fireEvent.copy(container!);

    expect(terminalApiMock.expandSelection).not.toHaveBeenCalled();
    await waitFor(() => expect(clipboardWrite).toHaveBeenCalledWith(
      [
        'soft-wrapped anchor',
        'shared wrapped row 1',
        'shared wrapped row 2',
        'visible soft-wrapped tail',
      ].join('\n'),
    ));
    expect(useNotificationStore.getState().toasts).toEqual([]);
  });

  it('copies the accumulated range when an OpenCode alternate screen has no tmux history', async () => {
    terminalApiMock.attach.mockResolvedValue({
      cols: 80,
      mode: 'pty',
      rows: 24,
      streamId: 1,
      success: true,
    });
    terminalApiMock.expandSelection.mockResolvedValue({ status: 'history-unavailable' });
    const terminal = await renderTerminal({}, makePane({ agentStatus: 'idle' }));
    await waitFor(() => expect(terminal.options.disableStdin).toBe(false));
    const container = terminal.element?.parentElement;
    const attachRequest = terminalApiMock.attach.mock.calls.at(-1)?.[0];
    expect(container).toBeTruthy();
    terminal.selection = [
      'OpenCode',
      'message-03',
      'message-04',
      'message-05',
      '',
      '/repo  ctrl+p commands',
    ].join('\n');
    terminal.selectionPosition = { end: { x: 20, y: 5 }, start: { x: 0, y: 1 } };

    fireEvent.mouseDown(terminal.element!, { button: 0 });
    terminal.selectionPosition = { end: { x: 20, y: 6 }, start: { x: 0, y: 1 } };
    terminal.selectionChangeListeners.forEach((listener) => listener());

    fireEvent.wheel(container!, { deltaMode: 1, deltaY: -2 });
    await waitFor(() => expect(terminalApiMock.scroll).toHaveBeenCalledTimes(1));

    terminal.selection = [
      'OpenCode',
      'message-02',
      'message-03',
      'message-04',
      '',
      '/repo  ctrl+p commands',
    ].join('\n');
    ipcMock.listeners.get(IPC_EVENT.TERMINAL_DATA)?.({
      data: '\x1b[2Jframe-1',
      paneId: 'pane-1',
      source: 'live',
      streamId: attachRequest.streamId,
    });
    await waitFor(() => expect(terminalApiMock.scroll).toHaveBeenCalledTimes(2));

    terminal.selection = [
      'OpenCode',
      'message-01',
      'message-02',
      'message-03',
      '',
      '/repo  ctrl+p commands',
    ].join('\n');
    ipcMock.listeners.get(IPC_EVENT.TERMINAL_DATA)?.({
      data: '\x1b[2Jframe-2',
      paneId: 'pane-1',
      source: 'live',
      streamId: attachRequest.streamId,
    });
    await act(async () => new Promise((resolve) => setTimeout(resolve, 50)));
    fireEvent.mouseUp(document, { button: 0 });
    fireEvent.copy(container!);

    const completeSelection = [
      'OpenCode',
      'message-01',
      'message-02',
      'message-03',
      'message-04',
      'message-05',
      '',
      '/repo  ctrl+p commands',
    ].join('\n');
    await waitFor(() => expect(clipboardWrite).toHaveBeenCalledWith(completeSelection));

    clipboardWrite.mockClear();
    fireEvent.wheel(container!, { deltaMode: 0, deltaY: 48 });
    terminal.selection = [
      'OpenCode',
      'message-03',
      'message-04',
      'message-05',
      '',
      '/repo  ctrl+p commands',
    ].join('\n');
    fireEvent.copy(container!);

    await waitFor(() => expect(clipboardWrite).toHaveBeenCalledWith(completeSelection));
  });

  it('recovers the OpenCode range after one unalignable repaint', async () => {
    terminalApiMock.attach.mockResolvedValue({
      cols: 80,
      mode: 'pty',
      rows: 24,
      streamId: 1,
      success: true,
    });
    terminalApiMock.expandSelection.mockResolvedValue({ status: 'history-unavailable' });
    const terminal = await renderTerminal({}, makePane({ agent: 'opencode', agentStatus: 'idle' }));
    await waitFor(() => expect(terminal.options.disableStdin).toBe(false));
    const container = terminal.element?.parentElement;
    const attachRequest = terminalApiMock.attach.mock.calls.at(-1)?.[0];
    expect(container).toBeTruthy();
    terminal.selection = 'message-01\nmessage-02\nmessage-03';
    terminal.selectionPosition = { end: { x: 10, y: 3 }, start: { x: 0, y: 1 } };

    fireEvent.mouseDown(terminal.element!, { button: 0 });
    terminal.selectionPosition = { end: { x: 20, y: 4 }, start: { x: 0, y: 1 } };
    terminal.selectionChangeListeners.forEach((listener) => listener());

    // Scroll 1: down — pump dispatches one unit
    fireEvent.wheel(container!, { deltaMode: 1, deltaY: 1 });
    await waitFor(() => expect(terminalApiMock.scroll).toHaveBeenCalledTimes(1));

    // Advancing repaint — acknowledge pump so it goes idle
    terminal.selection = 'message-02\nmessage-03\nmessage-04';
    ipcMock.listeners.get(IPC_EVENT.TERMINAL_DATA)?.({
      data: '\x1b[2Jframe-1',
      paneId: 'pane-1',
      source: 'live',
      streamId: attachRequest.streamId,
    });
    await act(async () => new Promise((resolve) => setTimeout(resolve, 50)));

    // Unalignable repaint while pump is idle — settlement skips (pendingUnits=0)
    terminal.selection = 'temporary header\ntemporary footer';
    ipcMock.listeners.get(IPC_EVENT.TERMINAL_DATA)?.({
      data: '\x1b[2Jlayout-frame',
      paneId: 'pane-1',
      source: 'live',
      streamId: attachRequest.streamId,
    });
    await act(async () => new Promise((resolve) => setTimeout(resolve, 50)));

    // Recovery frame — sets current selection for finalization snapshot
    terminal.selection = 'message-03\nmessage-04\nmessage-05';
    ipcMock.listeners.get(IPC_EVENT.TERMINAL_DATA)?.({
      data: '\x1b[2Jframe-2',
      paneId: 'pane-1',
      source: 'live',
      streamId: attachRequest.streamId,
    });
    await act(async () => new Promise((resolve) => setTimeout(resolve, 50)));

    // mouseUp triggers finalization which merges the final selection snapshot
    fireEvent.mouseUp(document, { button: 0 });
    fireEvent.copy(container!);

    await waitFor(() => expect(clipboardWrite).toHaveBeenCalledWith(
      'message-01\nmessage-02\nmessage-03\nmessage-04\nmessage-05',
    ));
  });

  it('does not copy a partial OpenCode range when the final repaint cannot be aligned', async () => {
    terminalApiMock.attach.mockResolvedValue({
      cols: 80,
      mode: 'pty',
      rows: 24,
      streamId: 1,
      success: true,
    });
    terminalApiMock.expandSelection.mockResolvedValue({ status: 'history-unavailable' });
    const terminal = await renderTerminal({}, makePane({ agentStatus: 'idle' }));
    await waitFor(() => expect(terminal.options.disableStdin).toBe(false));
    const container = terminal.element?.parentElement;
    expect(container).toBeTruthy();
    terminal.selection = 'message-01\nmessage-02\nmessage-03';

    fireEvent.mouseDown(terminal.element!, { button: 0 });
    fireEvent.wheel(container!, { deltaMode: 0, deltaY: 48 });
    terminal.selection = 'unrelated-01\nunrelated-02\nunrelated-03';
    fireEvent.mouseUp(document, { button: 0 });
    fireEvent.copy(container!);

    await waitFor(() => expect(terminalApiMock.expandSelection).toHaveBeenCalled());
    await waitFor(() => expect(useNotificationStore.getState().toasts).toEqual([
      expect.objectContaining({
        severity: 'warning',
        title: 'Selection could not be copied completely',
      }),
    ]));
    expect(clipboardWrite).not.toHaveBeenCalled();
  });

  it('does not fall back to visible text when a scrolled selection exceeds the safety limit', async () => {
    terminalApiMock.attach.mockResolvedValue({
      cols: 80,
      mode: 'pty',
      rows: 24,
      streamId: 1,
      success: true,
    });
    terminalApiMock.expandSelection.mockResolvedValue({ status: 'history-unavailable' });
    const terminal = await renderTerminal({}, makePane({ agentStatus: 'idle' }));
    await waitFor(() => expect(terminal.options.disableStdin).toBe(false));
    const container = terminal.element?.parentElement;
    expect(container).toBeTruthy();
    terminal.selection = 'X'.repeat((2 * 1024 * 1024) + 1);

    fireEvent.mouseDown(terminal.element!, { button: 0 });
    fireEvent.wheel(container!, { deltaMode: 0, deltaY: 48 });
    fireEvent.mouseUp(document, { button: 0 });
    fireEvent.copy(container!);

    await waitFor(() => expect(terminalApiMock.expandSelection).toHaveBeenCalled());
    await waitFor(() => expect(useNotificationStore.getState().toasts).toEqual([
      expect.objectContaining({
        severity: 'warning',
        title: 'Selection could not be copied completely',
      }),
    ]));
    expect(clipboardWrite).not.toHaveBeenCalled();
  });

  it('warns and does not write clipboard when range-not-found and client range is unverified', async () => {
    terminalApiMock.attach.mockResolvedValue({
      cols: 80,
      mode: 'pty',
      rows: 24,
      streamId: 1,
      success: true,
    });
    terminalApiMock.expandSelection.mockResolvedValue({ status: 'range-not-found' });
    const terminal = await renderTerminal({}, makePane({
      agent: undefined,
      agentStatus: 'idle',
      type: 'shell',
    }));
    await waitFor(() => expect(terminal.options.disableStdin).toBe(false));
    const container = terminal.element?.parentElement;
    expect(container).toBeTruthy();
    const availableText = 'X'.repeat((2 * 1024 * 1024) + 1);
    terminal.selection = availableText;

    fireEvent.mouseDown(terminal.element!, { button: 0 });
    fireEvent.wheel(container!, { deltaMode: 0, deltaY: 48 });
    fireEvent.mouseUp(document, { button: 0 });
    fireEvent.copy(container!);

    await waitFor(() => expect(terminalApiMock.expandSelection).toHaveBeenCalled());
    await waitFor(() => expect(useNotificationStore.getState().toasts).toEqual([
      expect.objectContaining({
        severity: 'warning',
        title: 'Selection could not be copied completely',
      }),
    ]));
    expect(clipboardWrite).not.toHaveBeenCalled();
  });

  it('retains the logical OpenCode range when a repaint transiently clears xterm selection', async () => {
    terminalApiMock.attach.mockResolvedValue({
      cols: 80,
      mode: 'pty',
      rows: 24,
      streamId: 1,
      success: true,
    });
    terminalApiMock.expandSelection.mockResolvedValue({ status: 'history-unavailable' });
    const terminal = await renderTerminal({}, makePane({ agentStatus: 'idle' }));
    await waitFor(() => expect(terminal.options.disableStdin).toBe(false));
    const attachRequest = terminalApiMock.attach.mock.calls.at(-1)?.[0];
    const container = terminal.element?.parentElement;
    expect(container).toBeTruthy();
    terminal.selection = 'message-02\nmessage-03\nmessage-04';

    fireEvent.mouseDown(terminal.element!, { button: 0 });
    fireEvent.wheel(container!, { deltaMode: 0, deltaY: -48 });
    terminal.write.mockImplementationOnce((_data: string, callback?: () => void) => {
      terminal.selection = '';
      terminal.selectionPosition = undefined;
      terminal.selectionChangeListeners.forEach((listener) => listener());
      callback?.();
    });
    ipcMock.listeners.get(IPC_EVENT.TERMINAL_DATA)?.({
      data: '\x1b[2Jmessage-01\r\nmessage-02\r\nmessage-03',
      paneId: 'pane-1',
      source: 'live',
      streamId: attachRequest.streamId,
    });
    await waitFor(() => expect(terminal.write).toHaveBeenCalled());

    terminal.selection = 'message-01\nmessage-02\nmessage-03';
    fireEvent.mouseUp(document, { button: 0 });
    fireEvent.copy(container!);

    await waitFor(() => expect(clipboardWrite).toHaveBeenCalledWith(
      'message-01\nmessage-02\nmessage-03\nmessage-04',
    ));
  });

  it('freezes an OpenCode range copied after selection ended and scrolling began', async () => {
    terminalApiMock.attach.mockResolvedValue({
      cols: 80,
      mode: 'pty',
      rows: 24,
      streamId: 1,
      success: true,
    });
    terminalApiMock.expandSelection.mockResolvedValue({ status: 'history-unavailable' });
    const terminal = await renderTerminal({}, makePane({ agentStatus: 'idle' }));
    await waitFor(() => expect(terminal.options.disableStdin).toBe(false));
    const container = terminal.element?.parentElement;
    expect(container).toBeTruthy();
    const laterViewport = [
      'OpenCode',
      'message-03',
      'message-04',
      'message-05',
      'message-06',
      '',
      '/repo  ctrl+p commands',
    ].join('\n');
    const earlierViewport = [
      'OpenCode',
      'message-01',
      'message-02',
      'message-03',
      'message-04',
      '',
      '/repo  ctrl+p commands',
    ].join('\n');
    const completeSelection = [
      'OpenCode',
      'message-01',
      'message-02',
      'message-03',
      'message-04',
      'message-05',
      'message-06',
      '',
      '/repo  ctrl+p commands',
    ].join('\n');

    terminal.selection = laterViewport;
    fireEvent.mouseDown(terminal.element!, { button: 0 });
    fireEvent.mouseUp(document, { button: 0 });
    fireEvent.wheel(container!, { deltaMode: 0, deltaY: -48 });
    terminal.selection = earlierViewport;
    fireEvent.copy(container!);
    await waitFor(() => expect(clipboardWrite).toHaveBeenCalledWith(completeSelection));

    clipboardWrite.mockClear();
    fireEvent.wheel(container!, { deltaMode: 0, deltaY: 48 });
    terminal.selection = laterViewport;
    fireEvent.copy(container!);

    await waitFor(() => expect(clipboardWrite).toHaveBeenCalledWith(completeSelection));
  });

  it('copies a new Select All range instead of a completed scrolled selection', async () => {
    terminalApiMock.attach.mockResolvedValue({
      cols: 80,
      mode: 'pty',
      rows: 24,
      streamId: 1,
      success: true,
    });
    terminalApiMock.expandSelection.mockResolvedValue({ status: 'history-unavailable' });
    const terminal = await renderTerminal({}, makePane({ agentStatus: 'idle' }));
    await waitFor(() => expect(terminal.options.disableStdin).toBe(false));
    const container = terminal.element?.parentElement;
    expect(container).toBeTruthy();
    terminal.selection = [
      'OpenCode',
      'message-02',
      'message-03',
      'message-04',
      '',
      '/repo  ctrl+p commands',
    ].join('\n');

    fireEvent.mouseDown(terminal.element!, { button: 0 });
    fireEvent.wheel(container!, { deltaMode: 0, deltaY: -48 });
    terminal.selection = [
      'OpenCode',
      'message-01',
      'message-02',
      'message-03',
      '',
      '/repo  ctrl+p commands',
    ].join('\n');
    fireEvent.mouseUp(document, { button: 0 });
    fireEvent.copy(container!);
    await waitFor(() => expect(clipboardWrite).toHaveBeenCalled());

    clipboardWrite.mockClear();
    terminal.selection = 'entire OpenCode terminal buffer';
    fireEvent.contextMenu(container!, { clientX: 20, clientY: 20 });
    fireEvent.click(screen.getByRole('button', { name: /Select All/ }));
    fireEvent.contextMenu(container!, { clientX: 20, clientY: 20 });
    fireEvent.click(screen.getByRole('button', { name: /Copy/ }));

    expect(terminal.selectAll).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(clipboardWrite).toHaveBeenCalledWith(
      'entire OpenCode terminal buffer',
    ));
  });

  it('copies a fully-offscreen range by context menu or macOS Command+C without swallowing Control+C', async () => {
    terminalApiMock.attach.mockResolvedValue({
      cols: 80,
      mode: 'pty',
      rows: 24,
      streamId: 1,
      success: true,
    });
    terminalApiMock.expandSelection.mockResolvedValue({ status: 'history-unavailable' });
    const terminal = await renderTerminal({}, makePane({ agentStatus: 'idle' }));
    await waitFor(() => expect(terminal.options.disableStdin).toBe(false));
    const container = terminal.element?.parentElement;
    const attachRequest = terminalApiMock.attach.mock.calls.at(-1)?.[0];
    expect(container).toBeTruthy();
    terminal.selection = ['frozen line 03', 'frozen line 04', 'frozen line 05'].join('\n');
    terminal.selectionPosition = { end: { x: 20, y: 5 }, start: { x: 0, y: 1 } };

    fireEvent.mouseDown(terminal.element!, { button: 0 });
    terminal.selectionPosition = { end: { x: 20, y: 6 }, start: { x: 0, y: 1 } };
    terminal.selectionChangeListeners.forEach((listener) => listener());

    fireEvent.wheel(container!, { deltaMode: 1, deltaY: -2 });
    await waitFor(() => expect(terminalApiMock.scroll).toHaveBeenCalledTimes(1));

    terminal.selection = ['frozen line 02', 'frozen line 03', 'frozen line 04'].join('\n');
    ipcMock.listeners.get(IPC_EVENT.TERMINAL_DATA)?.({
      data: '\x1b[2Jframe-1',
      paneId: 'pane-1',
      source: 'live',
      streamId: attachRequest.streamId,
    });
    await waitFor(() => expect(terminalApiMock.scroll).toHaveBeenCalledTimes(2));

    terminal.selection = ['frozen line 01', 'frozen line 02', 'frozen line 03'].join('\n');
    ipcMock.listeners.get(IPC_EVENT.TERMINAL_DATA)?.({
      data: '\x1b[2Jframe-2',
      paneId: 'pane-1',
      source: 'live',
      streamId: attachRequest.streamId,
    });
    await act(async () => new Promise((resolve) => setTimeout(resolve, 50)));
    fireEvent.mouseUp(document, { button: 0 });
    await act(async () => { await Promise.resolve(); });

    const frozenText = [
      'frozen line 01',
      'frozen line 02',
      'frozen line 03',
      'frozen line 04',
      'frozen line 05',
    ].join('\n');
    terminal.selection = '';
    terminal.selectionPosition = undefined;
    terminal.selectionChangeListeners.forEach((listener) => listener());

    fireEvent.contextMenu(container!, { clientX: 20, clientY: 20 });
    fireEvent.click(screen.getByRole('button', { name: /Copy/ }));

    await waitFor(() => expect(clipboardWrite).toHaveBeenCalledWith(frozenText));

    clipboardWrite.mockClear();
    const keyHandler = terminal.attachCustomKeyEventHandler.mock.calls[0]?.[0] as
      | ((event: KeyboardEvent) => boolean)
      | undefined;
    expect(keyHandler).toBeTypeOf('function');
    const commandCopy = {
      ctrlKey: false,
      key: 'c',
      metaKey: true,
      preventDefault: vi.fn(),
      shiftKey: false,
      stopPropagation: vi.fn(),
      type: 'keydown',
    } as unknown as KeyboardEvent;
    expect(keyHandler?.(commandCopy)).toBe(false);

    await waitFor(() => expect(clipboardWrite).toHaveBeenCalledWith(frozenText));

    clipboardWrite.mockClear();
    const preventInterruptDefault = vi.fn();
    const stopInterruptPropagation = vi.fn();
    const controlInterrupt = {
      ctrlKey: true,
      key: 'c',
      metaKey: false,
      preventDefault: preventInterruptDefault,
      shiftKey: false,
      stopPropagation: stopInterruptPropagation,
      type: 'keydown',
    } as unknown as KeyboardEvent;

    expect(keyHandler?.(controlInterrupt)).toBe(true);
    expect(preventInterruptDefault).not.toHaveBeenCalled();
    // DOM isolation is independent from xterm's custom-handler return gate.
    expect(stopInterruptPropagation).toHaveBeenCalledOnce();
    expect(clipboardWrite).not.toHaveBeenCalled();
  });

  it('keeps a completed frozen range when history expansion returns a shorter review slice', async () => {
    terminalApiMock.attach.mockResolvedValue({
      cols: 80,
      mode: 'pty',
      rows: 24,
      streamId: 1,
      success: true,
    });
    terminalApiMock.expandSelection.mockResolvedValue({ status: 'expanded', text: 'line-02' });
    const terminal = await renderTerminal({}, makePane({ agentStatus: 'idle' }));
    await waitFor(() => expect(terminal.options.disableStdin).toBe(false));
    const container = terminal.element?.parentElement;
    const attachRequest = terminalApiMock.attach.mock.calls.at(-1)?.[0];
    expect(container).toBeTruthy();
    const frozenText = 'line-01\nline-02\nline-03';
    terminal.selection = frozenText;
    terminal.selectionPosition = { end: { x: 7, y: 3 }, start: { x: 0, y: 1 } };

    fireEvent.mouseDown(terminal.element!, { button: 0, buttons: 1 });
    terminal.selectionPosition = { end: { x: 8, y: 3 }, start: { x: 0, y: 1 } };
    terminal.selectionChangeListeners.forEach((listener) => listener());
    fireEvent.mouseUp(document, { button: 0, buttons: 0 });
    await act(async () => { await Promise.resolve(); });
    fireEvent.wheel(container!, { clientX: 700, clientY: 220, deltaMode: 1, deltaY: 1 });
    expect(terminal.select).toHaveBeenLastCalledWith(0, 0, 168);
    terminal.selection = 'line-02';
    ipcMock.listeners.get(IPC_EVENT.TERMINAL_DATA)?.({
      data: '\x1b[2Jreview',
      paneId: 'pane-1',
      source: 'live',
      streamId: attachRequest.streamId,
    });
    await act(async () => new Promise((resolve) => setTimeout(resolve, 40)));

    fireEvent.copy(container!);

    await waitFor(() => expect(clipboardWrite).toHaveBeenCalledWith(frozenText));
  });

  it('does not offer context-menu Copy for a canceled range with no visible selection', async () => {
    terminalApiMock.attach.mockResolvedValue({
      cols: 80,
      mode: 'pty',
      rows: 24,
      streamId: 1,
      success: true,
    });
    const terminal = await renderTerminal({}, makePane({ agentStatus: 'idle' }));
    await waitFor(() => expect(terminal.options.disableStdin).toBe(false));
    const terminalElement = terminal.element;
    const container = terminalElement?.parentElement;
    expect(terminalElement && container).toBeTruthy();
    terminalElement!.getBoundingClientRect = () => ({
      bottom: 240, height: 240, left: 0, right: 800, top: 0, width: 800, x: 0, y: 0,
      toJSON: () => ({}),
    });
    terminal.selection = 'partial range';
    terminal.selectionPosition = { end: { x: 40, y: 10 }, start: { x: 4, y: 10 } };

    fireEvent.mouseDown(terminalElement!, { button: 0, buttons: 1, clientX: 45, clientY: 105 });
    fireEvent.wheel(container!, { deltaMode: 0, deltaY: 48 });
    await waitFor(() => expect(terminal.select).toHaveBeenCalled());
    fireEvent.mouseDown(terminalElement!, { button: 0, buttons: 1, clientX: 200, clientY: 120 });
    terminal.selection = '';
    terminal.selectionPosition = undefined;
    fireEvent.mouseUp(document, { button: 0, buttons: 0, clientX: 400, clientY: 238 });
    await act(async () => { await Promise.resolve(); });

    fireEvent.contextMenu(container!, { clientX: 20, clientY: 20 });

    expect(screen.queryByRole('button', { name: /Copy/ })).toBeNull();
  });

  it('resets gesture ownership on Select All after an application-owned interaction', async () => {
    terminalApiMock.attach.mockResolvedValue({
      cols: 80,
      mode: 'pty',
      rows: 24,
      streamId: 1,
      success: true,
    });
    terminalApiMock.expandSelection.mockResolvedValue({ status: 'history-unavailable' });
    const terminal = await renderTerminal({}, makePane({ agentStatus: 'idle' }));
    await waitFor(() => expect(terminal.options.disableStdin).toBe(false));
    const terminalElement = terminal.element;
    const container = terminalElement?.parentElement;
    expect(terminalElement && container).toBeTruthy();
    terminal.modes.mouseTrackingMode = 'vt200';

    fireEvent.mouseDown(terminalElement!, { button: 0, buttons: 1, clientX: 45, clientY: 105 });
    await act(async () => { await Promise.resolve(); });

    terminal.selection = 'entire buffer via select all';
    fireEvent.contextMenu(container!, { clientX: 20, clientY: 20 });
    fireEvent.click(screen.getByRole('button', { name: /Select All/ }));
    fireEvent.contextMenu(container!, { clientX: 20, clientY: 20 });
    fireEvent.click(screen.getByRole('button', { name: /Copy/ }));

    expect(terminal.selectAll).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(clipboardWrite).toHaveBeenCalledWith('entire buffer via select all'));
  });

  it('scrolls a PTY pane while an active selection is held at the terminal edge', async () => {
    vi.useFakeTimers();
    terminalApiMock.attach.mockResolvedValue({
      cols: 80,
      mode: 'pty',
      rows: 24,
      streamId: 1,
      success: true,
    });
    const terminal = await renderTerminalWithFakeTimers({}, makePane({ agentStatus: 'idle' }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    expect(terminal.options.disableStdin).toBe(false);
    const terminalElement = terminal.element;
    expect(terminalElement).toBeTruthy();
    terminalElement!.getBoundingClientRect = () => ({
      bottom: 240,
      height: 240,
      left: 0,
      right: 800,
      top: 0,
      width: 800,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    terminal.selection = 'first viewport';
    terminal.selectionPosition = {
      end: { x: 40, y: 23 },
      start: { x: 4, y: 10 },
    };

    fireEvent.mouseDown(terminalElement!, { button: 0, buttons: 1, clientX: 45, clientY: 105 });
    terminal.selectionPosition = {
      end: { x: 41, y: 23 },
      start: { x: 4, y: 10 },
    };
    terminal.selectionChangeListeners.forEach((listener) => listener());
    fireEvent.mouseMove(document, { buttons: 1, clientX: 400, clientY: 238 });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60);
    });

    expect(terminalApiMock.scroll).toHaveBeenCalledWith({
      alternateScreenMode: 'opencode',
      direction: 'down',
      lines: 1,
      paneId: 'pane-1',
    });
    expect(terminal.select).toHaveBeenLastCalledWith(4, 9, 1157);

    // xterm stops owning the document drag after a programmatic select. The
    // companion must keep the endpoint attached to the physical pointer.
    fireEvent.mouseMove(document, { buttons: 1, clientX: 500, clientY: 155 });
    expect(terminal.select).toHaveBeenLastCalledWith(4, 9, 526);

    fireEvent.mouseUp(document, { button: 0, buttons: 0, clientX: 500, clientY: 155 });
    terminalApiMock.scroll.mockClear();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120);
    });
    expect(terminalApiMock.scroll).not.toHaveBeenCalled();
  });

  it('drains bursty PTY selection scrolling one repaint step at a time', async () => {
    vi.useFakeTimers();
    terminalApiMock.attach.mockResolvedValue({
      cols: 80,
      mode: 'pty',
      rows: 24,
      streamId: 1,
      success: true,
    });
    const terminal = await renderTerminalWithFakeTimers(
      { copyOnSelect: true },
      makePane({ agent: 'opencode', agentStatus: 'idle' }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    expect(terminal.options.disableStdin).toBe(false);
    const container = terminal.element?.parentElement;
    const attachRequest = terminalApiMock.attach.mock.calls.at(-1)?.[0];
    expect(container).toBeTruthy();
    terminal.selection = 'msg-01\nmsg-02\nmsg-03';
    terminal.selectionPosition = {
      end: { x: 5, y: 5 },
      start: { x: 0, y: 1 },
    };

    // Establish terminal-owned gesture so pump is used (tracking-off -> terminalApi.scroll per unit)
    fireEvent.mouseDown(terminal.element!, { button: 0, buttons: 1 });
    terminal.selectionPosition = {
      end: { x: 20, y: 6 },
      start: { x: 0, y: 1 },
    };
    terminal.selectionChangeListeners.forEach((listener) => listener());

    // Burst 4 wheels — pump enqueues at most 1+1 in-flight (2 total), others dropped
    for (let index = 0; index < 4; index += 1) {
      fireEvent.wheel(container!, { clientY: 100, deltaMode: 0, deltaY: 16_000 });
    }
    expect(terminalApiMock.scroll).toHaveBeenCalledTimes(1);

    // Acknowledge repaint after each unit to drain the pump
    for (let repaint = 1; repaint < 3; repaint += 1) {
      terminal.selection = `msg-0${repaint + 1}\nmsg-0${repaint + 2}\nmsg-0${repaint + 3}`;
      ipcMock.listeners.get(IPC_EVENT.TERMINAL_DATA)?.({
        data: `\x1b[2Jframe-${repaint}`,
        paneId: 'pane-1',
        source: 'live',
        streamId: attachRequest.streamId,
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(40);
      });
    }

    expect(terminalApiMock.scroll).toHaveBeenCalledTimes(2);
    expect(terminalApiMock.scroll).toHaveBeenCalledWith({
      alternateScreenMode: 'opencode',
      direction: 'down',
      lines: 1,
      paneId: 'pane-1',
    });

    terminalApiMock.scroll.mockClear();
    fireEvent.mouseUp(document, { button: 0 });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(160);
    });
    expect(terminalApiMock.scroll).not.toHaveBeenCalled();
  });

  it('does not dispatch the next selection scroll from a partial TUI repaint', async () => {
    vi.useFakeTimers();
    terminalApiMock.attach.mockResolvedValue({
      cols: 80,
      mode: 'pty',
      rows: 24,
      streamId: 1,
      success: true,
    });
    const terminal = await renderTerminalWithFakeTimers(
      {},
      makePane({ agent: 'opencode', agentStatus: 'idle' }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    const container = terminal.element?.parentElement;
    const attachRequest = terminalApiMock.attach.mock.calls.at(-1)?.[0];
    const forwardedWheels = vi.fn();
    expect(container).toBeTruthy();
    terminal.modes.mouseTrackingMode = 'vt200';
    terminal.element!.addEventListener('wheel', (event) => {
      if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) forwardedWheels();
    });
    terminal.selection = 'message-01\nmessage-02\nmessage-03';
    terminal.selectionPosition = {
      end: { x: 10, y: 3 },
      start: { x: 0, y: 1 },
    };

    fireEvent.mouseDown(terminal.element!, { button: 0, buttons: 1 });
    terminal.selectionPosition = {
      end: { x: 20, y: 4 },
      start: { x: 0, y: 1 },
    };
    terminal.selectionChangeListeners.forEach((listener) => listener());
    fireEvent.wheel(container!, { deltaMode: 0, deltaY: 48 });
    expect(forwardedWheels).toHaveBeenCalledTimes(1);

    terminal.selection = 'message-02\nmessage-03';
    ipcMock.listeners.get(IPC_EVENT.TERMINAL_DATA)?.({
      data: '\x1b[2Jpartial frame',
      paneId: 'pane-1',
      source: 'live',
      streamId: attachRequest.streamId,
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(16);
    });
    expect(forwardedWheels).toHaveBeenCalledTimes(1);

    terminal.selection = 'message-02\nmessage-03\nmessage-04';
    ipcMock.listeners.get(IPC_EVENT.TERMINAL_DATA)?.({
      data: 'rest of frame',
      paneId: 'pane-1',
      source: 'live',
      streamId: attachRequest.streamId,
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(40);
    });
    expect(forwardedWheels).toHaveBeenCalledTimes(2);
  });

  it('reapplies a logical selection that xterm clears after a TUI repaint', async () => {
    vi.useFakeTimers();
    terminalApiMock.attach.mockResolvedValue({
      cols: 80,
      mode: 'pty',
      rows: 24,
      streamId: 1,
      success: true,
    });
    const terminal = await renderTerminalWithFakeTimers(
      {},
      makePane({ agent: 'claude', agentStatus: 'idle' }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    const container = terminal.element?.parentElement;
    const attachRequest = terminalApiMock.attach.mock.calls.at(-1)?.[0];
    const forwardedWheels = vi.fn();
    expect(container).toBeTruthy();
    terminal.modes.mouseTrackingMode = 'vt200';
    terminal.element!.addEventListener('wheel', (event) => {
      if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) forwardedWheels();
    });
    terminal.selection = 'message-01\nmessage-02\nmessage-03';
    terminal.selectionPosition = {
      end: { x: 10, y: 3 },
      start: { x: 0, y: 1 },
    };

    fireEvent.mouseDown(terminal.element!, { altKey: true, button: 0, buttons: 1 });
    terminal.selectionPosition = {
      end: { x: 20, y: 4 },
      start: { x: 0, y: 1 },
    };
    terminal.selectionChangeListeners.forEach((listener) => listener());
    fireEvent.wheel(container!, { deltaMode: 0, deltaY: 48 });
    expect(forwardedWheels).toHaveBeenCalledTimes(1);

    terminal.select.mockImplementation(() => {
      terminal.selection = 'message-02\nmessage-03\nmessage-04';
    });
    terminal.write.mockImplementationOnce((_data: string, callback?: () => void) => {
      callback?.();
      // Model xterm finishing its clear-screen render after the write callback.
      terminal.selection = '';
      terminal.selectionPosition = undefined;
    });
    ipcMock.listeners.get(IPC_EVENT.TERMINAL_DATA)?.({
      data: '\x1b[2Jlate-clear-frame',
      paneId: 'pane-1',
      source: 'live',
      streamId: attachRequest.streamId,
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(40);
    });

    expect(forwardedWheels).toHaveBeenCalledTimes(2);
  });

  it('tolerates one duplicate TUI repaint before declaring the scroll edge', async () => {
    vi.useFakeTimers();
    terminalApiMock.attach.mockResolvedValue({
      cols: 80,
      mode: 'pty',
      rows: 24,
      streamId: 1,
      success: true,
    });
    const terminal = await renderTerminalWithFakeTimers(
      {},
      makePane({ agent: 'claude', agentStatus: 'idle' }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    const container = terminal.element?.parentElement;
    const attachRequest = terminalApiMock.attach.mock.calls.at(-1)?.[0];
    const forwardedWheels = vi.fn();
    expect(container).toBeTruthy();
    terminal.modes.mouseTrackingMode = 'vt200';
    terminal.element!.addEventListener('wheel', (event) => {
      if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) forwardedWheels();
    });
    terminal.selection = 'message-01\nmessage-02\nmessage-03';
    terminal.selectionPosition = {
      end: { x: 10, y: 3 },
      start: { x: 0, y: 1 },
    };

    fireEvent.mouseDown(terminal.element!, { altKey: true, button: 0, buttons: 1 });
    terminal.selectionPosition = {
      end: { x: 20, y: 4 },
      start: { x: 0, y: 1 },
    };
    terminal.selectionChangeListeners.forEach((listener) => listener());
    fireEvent.wheel(container!, { deltaMode: 0, deltaY: 48 });
    expect(forwardedWheels).toHaveBeenCalledTimes(1);

    ipcMock.listeners.get(IPC_EVENT.TERMINAL_DATA)?.({
      data: '\x1b[2Jduplicate frame',
      paneId: 'pane-1',
      source: 'live',
      streamId: attachRequest.streamId,
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(40);
    });

    expect(forwardedWheels).toHaveBeenCalledTimes(1);

    terminal.selection = 'message-02\nmessage-03\nmessage-04';
    ipcMock.listeners.get(IPC_EVENT.TERMINAL_DATA)?.({
      data: 'advancing frame',
      paneId: 'pane-1',
      source: 'live',
      streamId: attachRequest.streamId,
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(40);
    });

    expect(forwardedWheels).toHaveBeenCalledTimes(2);
    fireEvent.mouseUp(document, { button: 0, buttons: 0 });
  });

  it('finishes the last in-flight repaint after mouse release before copying', async () => {
    vi.useFakeTimers();
    terminalApiMock.attach.mockResolvedValue({
      cols: 80,
      mode: 'pty',
      rows: 24,
      streamId: 1,
      success: true,
    });
    const terminal = await renderTerminalWithFakeTimers(
      { copyOnSelect: true },
      makePane({ agent: 'claude', agentStatus: 'idle' }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    const container = terminal.element?.parentElement;
    const attachRequest = terminalApiMock.attach.mock.calls.at(-1)?.[0];
    const forwardedWheels = vi.fn();
    expect(container).toBeTruthy();
    terminal.modes.mouseTrackingMode = 'vt200';
    terminal.element!.addEventListener('wheel', (event) => {
      if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) forwardedWheels();
    });
    terminal.selection = 'message-01\nmessage-02\nmessage-03';
    terminal.selectionPosition = {
      end: { x: 10, y: 3 },
      start: { x: 0, y: 1 },
    };

    fireEvent.mouseDown(terminal.element!, { altKey: true, button: 0, buttons: 1 });
    terminal.selectionPosition = {
      end: { x: 20, y: 4 },
      start: { x: 0, y: 1 },
    };
    terminal.selectionChangeListeners.forEach((listener) => listener());
    fireEvent.wheel(container!, { deltaMode: 0, deltaY: 24 });
    expect(forwardedWheels).toHaveBeenCalledTimes(1);
    fireEvent.mouseUp(document, { altKey: true, button: 0, buttons: 0 });
    expect(clipboardWrite).not.toHaveBeenCalled();

    terminal.selection = 'message-02\nmessage-03\nmessage-04';
    ipcMock.listeners.get(IPC_EVENT.TERMINAL_DATA)?.({
      data: '\x1b[2Jcomplete frame',
      paneId: 'pane-1',
      source: 'live',
      streamId: attachRequest.streamId,
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(40);
      await Promise.resolve();
    });

    expect(clipboardWrite).toHaveBeenCalledWith(
      'message-01\nmessage-02\nmessage-03\nmessage-04',
    );
  });

  it('starts a second Shift selection without retaining the previous scrolled range', async () => {
    vi.useFakeTimers();
    terminalApiMock.attach.mockResolvedValue({
      cols: 80,
      mode: 'pty',
      rows: 24,
      streamId: 1,
      success: true,
    });
    const terminal = await renderTerminalWithFakeTimers(
      {},
      makePane({ agent: 'opencode', agentStatus: 'idle' }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    const container = terminal.element?.parentElement;
    const attachRequest = terminalApiMock.attach.mock.calls.at(-1)?.[0];
    const forwardedWheels = vi.fn();
    expect(container).toBeTruthy();
    terminal.modes.mouseTrackingMode = 'vt200';
    terminal.element!.addEventListener('wheel', (event) => {
      if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) forwardedWheels();
    });
    terminal.selection = 'first-01\nfirst-02\nfirst-03';
    terminal.selectionPosition = {
      end: { x: 10, y: 3 },
      start: { x: 0, y: 1 },
    };

    fireEvent.mouseDown(terminal.element!, { button: 0, buttons: 1, shiftKey: true });
    terminal.selectionPosition = {
      end: { x: 20, y: 4 },
      start: { x: 0, y: 1 },
    };
    terminal.selectionChangeListeners.forEach((listener) => listener());
    fireEvent.wheel(container!, { deltaMode: 0, deltaY: 24 });
    terminal.selection = 'first-02\nfirst-03\nfirst-04';
    ipcMock.listeners.get(IPC_EVENT.TERMINAL_DATA)?.({
      data: '\x1b[2Jfirst complete frame',
      paneId: 'pane-1',
      source: 'live',
      streamId: attachRequest.streamId,
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(40);
    });
    fireEvent.mouseUp(document, { button: 0, buttons: 0, shiftKey: true });
    expect(forwardedWheels).toHaveBeenCalledTimes(1);

    terminal.selection = 'second-01\nsecond-02\nsecond-03';
    terminal.selectionPosition = {
      end: { x: 10, y: 10 },
      start: { x: 0, y: 8 },
    };
    fireEvent.mouseDown(terminal.element!, { button: 0, buttons: 1, shiftKey: true });
    terminal.selectionPosition = {
      end: { x: 20, y: 11 },
      start: { x: 0, y: 8 },
    };
    terminal.selectionChangeListeners.forEach((listener) => listener());
    fireEvent.wheel(container!, { deltaMode: 0, deltaY: 24 });

    expect(forwardedWheels).toHaveBeenCalledTimes(2);
  });

  it('restores the visible PTY selection after tmux repaints the viewport', async () => {
    terminalApiMock.attach.mockResolvedValue({
      cols: 80,
      mode: 'pty',
      rows: 24,
      streamId: 1,
      success: true,
    });
    const terminal = await renderTerminal({}, makePane({ agentStatus: 'idle' }));
    await waitFor(() => expect(terminal.options.disableStdin).toBe(false));
    const attachRequest = terminalApiMock.attach.mock.calls.at(-1)?.[0];
    const terminalElement = terminal.element;
    const container = terminalElement?.parentElement;
    expect(terminalElement).toBeTruthy();
    expect(container).toBeTruthy();
    terminalElement!.getBoundingClientRect = () => ({
      bottom: 240,
      height: 240,
      left: 0,
      right: 800,
      top: 0,
      width: 800,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    terminal.selection = 'first viewport';
    terminal.selectionPosition = {
      end: { x: 40, y: 23 },
      start: { x: 4, y: 10 },
    };

    fireEvent.mouseDown(terminalElement!, { button: 0, buttons: 1, clientX: 45, clientY: 105 });
    fireEvent.wheel(container!, { deltaMode: 0, deltaY: 48 });
    await waitFor(() => expect(terminal.select).toHaveBeenCalled());
    const visualUpdatesBeforeRepaint = terminal.select.mock.calls.length;

    ipcMock.listeners.get(IPC_EVENT.TERMINAL_DATA)?.({
      data: '\x1b[2Jrepainted viewport',
      paneId: 'pane-1',
      source: 'live',
      streamId: attachRequest.streamId,
    });

    await waitFor(() => expect(terminal.write).toHaveBeenCalledWith(
      '\x1b[2Jrepainted viewport',
      expect.any(Function),
    ));
    await waitFor(() => {
      expect(terminal.select.mock.calls.length).toBeGreaterThan(visualUpdatesBeforeRepaint);
    });
    fireEvent.mouseUp(document, { button: 0, buttons: 0, clientX: 400, clientY: 238 });
  });

  it('does not restore a completed PTY selection after the user clears it', async () => {
    terminalApiMock.attach.mockResolvedValue({
      cols: 80,
      mode: 'pty',
      rows: 24,
      streamId: 1,
      success: true,
    });
    const terminal = await renderTerminal({}, makePane({ agentStatus: 'idle' }));
    await waitFor(() => expect(terminal.options.disableStdin).toBe(false));
    const attachRequest = terminalApiMock.attach.mock.calls.at(-1)?.[0];
    const terminalElement = terminal.element;
    const container = terminalElement?.parentElement;
    expect(terminalElement).toBeTruthy();
    expect(container).toBeTruthy();
    terminalElement!.getBoundingClientRect = () => ({
      bottom: 240,
      height: 240,
      left: 0,
      right: 800,
      top: 0,
      width: 800,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    terminal.selection = 'selected viewport';
    terminal.selectionPosition = {
      end: { x: 40, y: 23 },
      start: { x: 4, y: 10 },
    };

    fireEvent.mouseDown(terminalElement!, { button: 0, buttons: 1, clientX: 45, clientY: 105 });
    fireEvent.wheel(container!, { deltaMode: 0, deltaY: 48 });
    await waitFor(() => expect(terminal.select).toHaveBeenCalled());
    fireEvent.mouseUp(document, { button: 0, buttons: 0, clientX: 400, clientY: 238 });
    await act(async () => { await Promise.resolve(); });

    // Scrolling a completed selection takes visual ownership again so it can
    // survive tmux repainting while the user reviews the copied range.
    const selectionsBeforeReviewScroll = terminal.select.mock.calls.length;
    fireEvent.wheel(container!, { deltaMode: 0, deltaY: -48 });
    await waitFor(() => {
      expect(terminal.select.mock.calls.length).toBeGreaterThan(selectionsBeforeReviewScroll);
    });

    fireEvent.mouseDown(terminalElement!, { button: 0, buttons: 1, clientX: 45, clientY: 105 });
    terminal.selection = '';
    terminal.selectionPosition = undefined;
    terminal.selectionChangeListeners.forEach((listener) => listener());
    const selectionsAfterClear = terminal.select.mock.calls.length;
    ipcMock.listeners.get(IPC_EVENT.TERMINAL_DATA)?.({
      data: '\x1b[2Jnext viewport',
      paneId: 'pane-1',
      source: 'live',
      streamId: attachRequest.streamId,
    });

    await waitFor(() => expect(terminal.write).toHaveBeenCalledWith(
      '\x1b[2Jnext viewport',
      expect.any(Function),
    ));
    expect(terminal.select).toHaveBeenCalledTimes(selectionsAfterClear);
  });

  it('keeps a reverse PTY selection highlighted while scrolling toward the top edge', async () => {
    vi.useFakeTimers();
    terminalApiMock.attach.mockResolvedValue({
      cols: 80,
      mode: 'pty',
      rows: 24,
      streamId: 1,
      success: true,
    });
    const terminal = await renderTerminalWithFakeTimers({}, makePane({ agentStatus: 'idle' }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    const terminalElement = terminal.element;
    expect(terminalElement).toBeTruthy();
    terminalElement!.getBoundingClientRect = () => ({
      bottom: 240,
      height: 240,
      left: 0,
      right: 800,
      top: 0,
      width: 800,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    terminal.selection = 'last viewport';
    terminal.selectionPosition = {
      end: { x: 30, y: 15 },
      start: { x: 0, y: 0 },
    };

    fireEvent.mouseDown(terminalElement!, { button: 0, buttons: 1, clientX: 305, clientY: 155 });
    terminal.selectionPosition = {
      end: { x: 30, y: 15 },
      start: { x: 0, y: 1 },
    };
    terminal.selectionChangeListeners.forEach((listener) => listener());
    fireEvent.mouseMove(document, { buttons: 1, clientX: 0, clientY: 2 });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60);
    });

    expect(terminalApiMock.scroll).toHaveBeenCalledWith({
      alternateScreenMode: 'opencode',
      direction: 'up',
      lines: 1,
      paneId: 'pane-1',
    });
    expect(terminal.select).toHaveBeenLastCalledWith(0, 1, 1230);

    fireEvent.mouseUp(document, { button: 0, buttons: 0, clientX: 0, clientY: 2 });
  });

  it('does not let an older PTY selection expansion overwrite a newer copy', async () => {
    terminalApiMock.attach.mockResolvedValue({
      cols: 80,
      mode: 'pty',
      rows: 24,
      streamId: 1,
      success: true,
    });
    const firstExpansion = createDeferred<TerminalSelectionExpandResponse>();
    const secondExpansion = createDeferred<TerminalSelectionExpandResponse>();
    terminalApiMock.expandSelection
      .mockReturnValueOnce(firstExpansion.promise)
      .mockReturnValueOnce(secondExpansion.promise);
    const terminal = await renderTerminal({}, makePane({ agentStatus: 'idle' }));
    await waitFor(() => expect(terminal.options.disableStdin).toBe(false));
    const container = terminal.element?.parentElement;
    expect(container).toBeTruthy();
    terminal.selection = 'first viewport';

    fireEvent.mouseDown(container!, { button: 0 });
    fireEvent.wheel(container!, { deltaMode: 0, deltaY: 48 });
    terminal.selection = 'older last viewport';
    fireEvent.copy(container!);
    terminal.selection = 'newer last viewport';
    fireEvent.copy(container!);
    await waitFor(() => expect(terminalApiMock.expandSelection).toHaveBeenCalledTimes(2));

    await act(async () => secondExpansion.resolve({
      status: 'expanded',
      text: 'new complete selection',
    }));
    await waitFor(() => expect(clipboardWrite).toHaveBeenCalledWith('new complete selection'));
    await act(async () => firstExpansion.resolve({
      status: 'expanded',
      text: 'stale incomplete selection',
    }));

    expect(clipboardWrite).not.toHaveBeenCalledWith('stale incomplete selection');
  });

  it('does not finish a pending PTY copy after the terminal is unmounted', async () => {
    terminalApiMock.attach.mockResolvedValue({
      cols: 80,
      mode: 'pty',
      rows: 24,
      streamId: 1,
      success: true,
    });
    const expansion = createDeferred<TerminalSelectionExpandResponse>();
    terminalApiMock.expandSelection.mockReturnValue(expansion.promise);
    const terminal = await renderTerminal({}, makePane({ agentStatus: 'idle' }));
    await waitFor(() => expect(terminal.options.disableStdin).toBe(false));
    const container = terminal.element?.parentElement;
    expect(container).toBeTruthy();
    terminal.selection = 'first viewport';

    fireEvent.mouseDown(container!, { button: 0 });
    fireEvent.wheel(container!, { deltaMode: 0, deltaY: 48 });
    terminal.selection = 'last viewport';
    fireEvent.copy(container!);
    await waitFor(() => expect(terminalApiMock.expandSelection).toHaveBeenCalledOnce());

    cleanup();
    await act(async () => expansion.resolve({
      status: 'expanded',
      text: 'stale complete selection',
    }));

    expect(clipboardWrite).not.toHaveBeenCalled();
  });

  it('does not let OpenCode mouse tracking controls reach xterm so plain drag selection works', async () => {
    const terminal = await renderTerminal();
    const attachRequest = terminalApiMock.attach.mock.calls.at(-1)?.[0];
    expect(attachRequest).toBeTruthy();

    ipcMock.listeners.get(IPC_EVENT.TERMINAL_DATA)?.({
      data: '\x1b[?1000;1006hOpenCode agent response',
      paneId: 'pane-1',
      source: 'live',
      streamId: attachRequest.streamId,
    });

    await waitFor(() => expect(terminal.write).toHaveBeenCalled());
    expect(terminal.write).toHaveBeenCalledWith('OpenCode agent response', expect.any(Function));
  });

  it('does not let split OpenCode mouse tracking controls reach xterm', async () => {
    const terminal = await renderTerminal();
    const attachRequest = terminalApiMock.attach.mock.calls.at(-1)?.[0];
    expect(attachRequest).toBeTruthy();
    terminal.write.mockClear();

    ipcMock.listeners.get(IPC_EVENT.TERMINAL_DATA)?.({
      data: '\x1b[?1049;1000;',
      paneId: 'pane-1',
      source: 'live',
      streamId: attachRequest.streamId,
    });

    await waitFor(() => expect(terminal.write).not.toHaveBeenCalled());

    ipcMock.listeners.get(IPC_EVENT.TERMINAL_DATA)?.({
      data: '1006hOpenCode agent response',
      paneId: 'pane-1',
      source: 'live',
      streamId: attachRequest.streamId,
    });

    await waitFor(() => expect(terminal.write).toHaveBeenCalledTimes(1));
    expect(terminal.write).toHaveBeenCalledWith(
      '\x1b[?1049hOpenCode agent response',
      expect.any(Function),
    );
  });

  it('preserves OpenCode mouse tracking controls when native passthrough is enabled on PTY', async () => {
    terminalApiMock.attach.mockResolvedValue({ success: true, cols: 80, rows: 24, mode: 'pty' });
    const terminal = await renderTerminal({ opencodeMousePassthrough: true, terminalTransport: 'pty' });
    const attachRequest = terminalApiMock.attach.mock.calls.at(-1)?.[0];
    expect(attachRequest).toBeTruthy();

    ipcMock.listeners.get(IPC_EVENT.TERMINAL_DATA)?.({
      data: '\x1b[?1000;1006hOpenCode agent response',
      paneId: 'pane-1',
      source: 'live',
      streamId: attachRequest.streamId,
    });

    await waitFor(() => expect(terminal.write).toHaveBeenCalled());
    expect(terminal.write).toHaveBeenCalledWith('\x1b[?1000;1006hOpenCode agent response', expect.any(Function));
  });

  it('preserves a split OpenCode mouse control across PTY transport resolution', async () => {
    const attach = createDeferred<{ success: boolean; cols: number; rows: number; mode: 'pty' }>();
    terminalApiMock.attach.mockReturnValue(attach.promise);
    const terminal = await renderTerminal({ opencodeMousePassthrough: true, terminalTransport: 'pty' });
    const attachRequest = terminalApiMock.attach.mock.calls.at(-1)?.[0];
    expect(attachRequest).toBeTruthy();

    ipcMock.listeners.get(IPC_EVENT.TERMINAL_DATA)?.({
      data: '\x1b[?1000;',
      paneId: 'pane-1',
      source: 'live',
      streamId: attachRequest.streamId,
    });
    expect(terminal.write).not.toHaveBeenCalled();

    await act(async () => {
      attach.resolve({ success: true, cols: 80, rows: 24, mode: 'pty' });
      await attach.promise;
    });
    ipcMock.listeners.get(IPC_EVENT.TERMINAL_DATA)?.({
      data: '1006hOpenCode agent response',
      paneId: 'pane-1',
      source: 'live',
      streamId: attachRequest.streamId,
    });

    await waitFor(() => expect(terminal.write).toHaveBeenCalledTimes(2));
    expect(terminal.write.mock.calls.map(([data]) => data)).toEqual([
      '\x1b[?1000;',
      '1006hOpenCode agent response',
    ]);
  });

  it('ignores OSC 52 clipboard writes without prompting by default', async () => {
    const terminal = await renderTerminal();
    const handler = terminal.oscHandlers.get(52);
    expect(handler).toBeTruthy();

    const handled = handler?.(`c;${Buffer.from('agent copied text', 'utf8').toString('base64')}`);

    expect(handled).toBe(true);
    expect(clipboardWrite).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog', { name: 'Terminal clipboard request' })).toBeNull();
  });

  it('honors explicitly allowed OSC 52 clipboard writes without prompting', async () => {
    const terminal = await renderTerminal({ terminalOsc52Clipboard: 'allow' });
    const handler = terminal.oscHandlers.get(52);
    expect(handler).toBeTruthy();

    const handled = handler?.(`c;${Buffer.from('agent copied text', 'utf8').toString('base64')}`);

    expect(handled).toBe(true);
    await waitFor(() => expect(clipboardWrite).toHaveBeenCalledWith('agent copied text'));
    expect(screen.queryByRole('dialog', { name: 'Terminal clipboard request' })).toBeNull();
  });

  it('shows a reconnect control once attach retries are exhausted and retries on demand', async () => {
    vi.useFakeTimers();
    terminalApiMock.attach.mockResolvedValue({ success: false, error: 'tmux view client detached' });

    await renderTerminalWithFakeTimers();
    await exhaustAttachRejectionRetries();

    const reconnect = screen.getByRole('button', { name: 'Reconnect terminal' });
    expect(screen.getByText('tmux view client detached')).toBeTruthy();
    const rejectedAttempts = terminalApiMock.attach.mock.calls.length;
    expect(rejectedAttempts).toBe(ATTACH_REJECTION_BACKOFF_MS.length + 1);

    terminalApiMock.attach.mockResolvedValue({ success: true, cols: 80, rows: 24, mode: 'pty' });
    await act(async () => {
      fireEvent.click(reconnect);
      await vi.advanceTimersByTimeAsync(20);
    });

    expect(terminalApiMock.attach).toHaveBeenCalledTimes(rejectedAttempts + 1);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('does not write to clipboard for a coordinated selection in capture/transcript stream mode', async () => {
    terminalApiMock.attach.mockResolvedValue({
      cols: 80,
      mode: 'capture',
      rows: 24,
      streamId: 1,
      success: true,
    });
    terminalApiMock.expandSelection.mockResolvedValue({ status: 'history-unavailable' });
    const terminal = await renderTerminal({}, makePane({ agentStatus: 'idle' }));
    await waitFor(() => expect(terminal.options.disableStdin).toBe(false));
    const container = terminal.element?.parentElement;
    expect(container).toBeTruthy();
    terminal.selection = 'anchor viewport';

    fireEvent.mouseDown(terminal.element!, { button: 0 });
    fireEvent.wheel(container!, { deltaMode: 0, deltaY: 48 });
    terminal.selection = 'current viewport';
    fireEvent.mouseUp(document, { button: 0 });

    fireEvent.contextMenu(container!, { clientX: 20, clientY: 20 });
    expect(screen.queryByRole('button', { name: /Copy/ })).toBeNull();

    fireEvent.copy(container!);

    await waitFor(() => expect(useNotificationStore.getState().toasts).toEqual([
      expect.objectContaining({
        severity: 'warning',
        title: 'Selection could not be copied completely',
      }),
    ]));
    expect(clipboardWrite).not.toHaveBeenCalled();
  });

  it('does not write to clipboard when range-not-found and client range is unverified', async () => {
    terminalApiMock.attach.mockResolvedValue({
      cols: 80,
      mode: 'pty',
      rows: 24,
      streamId: 1,
      success: true,
    });
    terminalApiMock.expandSelection.mockResolvedValue({ status: 'range-not-found' });
    const terminal = await renderTerminal({}, makePane({
      agent: undefined,
      agentStatus: 'idle',
      type: 'shell',
    }));
    await waitFor(() => expect(terminal.options.disableStdin).toBe(false));
    const container = terminal.element?.parentElement;
    expect(container).toBeTruthy();
    terminal.selection = 'X'.repeat((2 * 1024 * 1024) + 1);

    fireEvent.mouseDown(terminal.element!, { button: 0 });
    fireEvent.wheel(container!, { deltaMode: 0, deltaY: 48 });
    fireEvent.mouseUp(document, { button: 0 });
    fireEvent.copy(container!);

    await waitFor(() => expect(terminalApiMock.expandSelection).toHaveBeenCalled());
    await waitFor(() => expect(useNotificationStore.getState().toasts).toEqual([
      expect.objectContaining({
        severity: 'warning',
        title: 'Selection could not be copied completely',
      }),
    ]));
    expect(clipboardWrite).not.toHaveBeenCalled();
  });

  it('does not trigger edge auto-scroll when the gesture owner is application', async () => {
    vi.useFakeTimers();
    terminalApiMock.attach.mockResolvedValue({
      cols: 80,
      mode: 'pty',
      rows: 24,
      streamId: 1,
      success: true,
    });
    const terminal = await renderTerminalWithFakeTimers({}, makePane({ agentStatus: 'idle' }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    expect(terminal.options.disableStdin).toBe(false);
    const terminalElement = terminal.element;
    expect(terminalElement).toBeTruthy();
    terminalElement!.getBoundingClientRect = () => ({
      bottom: 240,
      height: 240,
      left: 0,
      right: 800,
      top: 0,
      width: 800,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    terminal.selection = 'some text';
    terminal.selectionPosition = { end: { x: 9, y: 5 }, start: { x: 0, y: 5 } };

    // Mouse tracking mode on during mousedown triggers the queueMicrotask path
    // that marks the gesture application-owned (no altKey/shiftKey).
    terminal.modes.mouseTrackingMode = 'vt200';
    fireEvent.mouseDown(terminalElement!, { button: 0, buttons: 1, clientX: 45, clientY: 105 });
    await act(async () => {
      // Flush the queueMicrotask that marks the gesture application-owned
      await Promise.resolve();
    });
    expect(terminal.clearSelection).toHaveBeenCalledTimes(1);

    fireEvent.copy(terminalElement!);
    expect(clipboardWrite).not.toHaveBeenCalled();

    // Restore none-mode so synthetic wheel events from onScroll go through the
    // observable queueTmuxScroll path (terminalApi.scroll) — not the vt200 early-return.
    // Without the needsCustomScroll fix, onScroll fires → scroll IS called.
    terminal.modes.mouseTrackingMode = 'none';
    terminalApiMock.scroll.mockClear();
    fireEvent.mouseMove(document, { buttons: 1, clientX: 400, clientY: 238 });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120);
    });

    expect(terminalApiMock.scroll).not.toHaveBeenCalled();

    fireEvent.mouseUp(document, { button: 0, buttons: 0 });
  });

  it('does not trigger edge auto-scroll while gesture ownership is still pending', async () => {
    vi.useFakeTimers();
    terminalApiMock.attach.mockResolvedValue({ cols: 80, mode: 'pty', rows: 24, streamId: 1, success: true });
    const terminal = await renderTerminalWithFakeTimers({}, makePane({ agentStatus: 'idle' }));
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    const terminalElement = terminal.element;
    expect(terminalElement).toBeTruthy();
    terminalElement!.getBoundingClientRect = () => ({
      bottom: 240, height: 240, left: 0, right: 800, top: 0, width: 800, x: 0, y: 0,
      toJSON: () => ({}),
    });
    terminal.selection = 'selection that predates this gesture';
    terminal.selectionPosition = { end: { x: 20, y: 5 }, start: { x: 0, y: 5 } };

    fireEvent.mouseDown(terminalElement!, { altKey: true, button: 0, buttons: 1, clientX: 45, clientY: 105 });
    fireEvent.mouseMove(document, { buttons: 1, clientX: 400, clientY: 238 });
    await act(async () => { await vi.advanceTimersByTimeAsync(120); });

    expect(terminalApiMock.scroll).not.toHaveBeenCalled();
    fireEvent.mouseUp(document, { button: 0, buttons: 0 });
  });

  it('leaves horizontal-only wheel input unconsumed during a terminal-owned selection', async () => {
    terminalApiMock.attach.mockResolvedValue({ cols: 80, mode: 'pty', rows: 24, streamId: 1, success: true });
    const terminal = await renderTerminal({}, makePane({ agentStatus: 'idle' }));
    await waitFor(() => expect(terminal.options.disableStdin).toBe(false));
    const container = terminal.element?.parentElement;
    expect(container).toBeTruthy();
    terminal.selection = 'selected text';
    terminal.selectionPosition = { end: { x: 13, y: 5 }, start: { x: 0, y: 5 } };
    fireEvent.mouseDown(terminal.element!, { altKey: true, button: 0, buttons: 1 });
    terminal.selectionPosition = { end: { x: 14, y: 5 }, start: { x: 0, y: 5 } };
    terminal.selectionChangeListeners.forEach((listener) => listener());
    const horizontalWheel = new WheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      deltaX: 48,
      deltaY: 0,
    });

    container!.dispatchEvent(horizontalWheel);

    expect(horizontalWheel.defaultPrevented).toBe(false);
    expect(terminalApiMock.scroll).not.toHaveBeenCalled();
    fireEvent.mouseUp(document, { button: 0, buttons: 0 });
  });

  it('routes terminal-owned selection scrolling through the pump even when mouse tracking is on', async () => {
    vi.useFakeTimers();
    terminalApiMock.attach.mockResolvedValue({
      cols: 80,
      mode: 'pty',
      rows: 24,
      streamId: 1,
      success: true,
    });
    const terminal = await renderTerminalWithFakeTimers(
      {},
      makePane({ agent: 'opencode', agentStatus: 'idle' }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    const container = terminal.element?.parentElement;
    const attachRequest = terminalApiMock.attach.mock.calls.at(-1)?.[0];
    expect(container).toBeTruthy();
    terminal.modes.mouseTrackingMode = 'vt200';
    terminal.selection = 'message-01\nmessage-02\nmessage-03';
    terminal.selectionPosition = { end: { x: 10, y: 3 }, start: { x: 0, y: 1 } };

    fireEvent.mouseDown(terminal.element!, { altKey: true, button: 0, buttons: 1 });
    terminal.selectionPosition = { end: { x: 20, y: 4 }, start: { x: 0, y: 1 } };
    terminal.selectionChangeListeners.forEach((listener) => listener());

    const forwardedWheels = vi.fn();
    terminal.element!.addEventListener('wheel', (event) => {
      if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) forwardedWheels();
    });

    // Wheel with vt200 tracking active — must route through pump, not drop
    fireEvent.wheel(container!, { deltaMode: 0, deltaY: 24 });
    expect(forwardedWheels).toHaveBeenCalledTimes(1);

    terminal.selection = 'message-02\nmessage-03\nmessage-04';
    ipcMock.listeners.get(IPC_EVENT.TERMINAL_DATA)?.({
      data: '\x1b[2Jframe',
      paneId: 'pane-1',
      source: 'live',
      streamId: attachRequest.streamId,
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(40);
    });

    fireEvent.mouseUp(document, { button: 0, buttons: 0 });
  });

  it('uses terminalApi.scroll when mouse tracking is off and forwarded wheel when tracking is on', async () => {
    vi.useFakeTimers();
    terminalApiMock.attach.mockResolvedValue({
      cols: 80,
      mode: 'pty',
      rows: 24,
      streamId: 1,
      success: true,
    });
    const terminal = await renderTerminalWithFakeTimers(
      {},
      makePane({ agent: 'opencode', agentStatus: 'idle' }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    const container = terminal.element?.parentElement;
    const attachRequest = terminalApiMock.attach.mock.calls.at(-1)?.[0];
    expect(container).toBeTruthy();

    // --- tracking OFF: dispatch uses terminalApi.scroll ---
    terminal.selection = 'msg-01\nmsg-02';
    terminal.selectionPosition = { end: { x: 5, y: 2 }, start: { x: 0, y: 1 } };
    fireEvent.mouseDown(terminal.element!, { button: 0, buttons: 1 });
    terminal.selectionPosition = { end: { x: 10, y: 3 }, start: { x: 0, y: 1 } };
    terminal.selectionChangeListeners.forEach((listener) => listener());

    fireEvent.wheel(container!, { deltaMode: 0, deltaY: 24 });
    expect(terminalApiMock.scroll).toHaveBeenCalledWith(
      expect.objectContaining({ direction: 'down', lines: 1, paneId: 'pane-1' }),
    );
    terminalApiMock.scroll.mockClear();

    // Acknowledge repaint
    terminal.selection = 'msg-02\nmsg-03';
    ipcMock.listeners.get(IPC_EVENT.TERMINAL_DATA)?.({
      data: '\x1b[2Jframe',
      paneId: 'pane-1',
      source: 'live',
      streamId: attachRequest.streamId,
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(40);
    });
    fireEvent.mouseUp(document, { button: 0, buttons: 0 });

    // --- tracking ON: dispatch uses forwarded line-mode wheel ---
    terminal.modes.mouseTrackingMode = 'vt200';
    terminal.selection = 'msg-A\nmsg-B';
    terminal.selectionPosition = { end: { x: 5, y: 7 }, start: { x: 0, y: 6 } };
    fireEvent.mouseDown(terminal.element!, { altKey: true, button: 0, buttons: 1 });
    terminal.selectionPosition = { end: { x: 10, y: 8 }, start: { x: 0, y: 6 } };
    terminal.selectionChangeListeners.forEach((listener) => listener());

    const forwardedWheels = vi.fn();
    terminal.element!.addEventListener('wheel', (event) => {
      if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) forwardedWheels();
    });
    terminalApiMock.scroll.mockClear();

    fireEvent.wheel(container!, { deltaMode: 0, deltaY: 24 });
    expect(forwardedWheels).toHaveBeenCalledTimes(1);
    expect(terminalApiMock.scroll).not.toHaveBeenCalled();

    fireEvent.mouseUp(document, { button: 0, buttons: 0 });
  });

  it.each(['failure response', 'rejection'] as const)(
    'rolls back the visual step, cancels the pump and marks range unverified after a scroll %s',
    async (failureKind) => {
      vi.useFakeTimers();
      terminalApiMock.attach.mockResolvedValue({
        cols: 80,
        mode: 'pty',
        rows: 24,
        streamId: 1,
        success: true,
      });
      const scrollDeferred = { reject: (_e: unknown) => {}, resolve: (_v: unknown) => {} };
      terminalApiMock.scroll.mockImplementationOnce(
        () => new Promise((resolve, reject) => { scrollDeferred.resolve = resolve; scrollDeferred.reject = reject; }),
      );
      const terminal = await renderTerminalWithFakeTimers(
        {},
        makePane({ agent: 'opencode', agentStatus: 'idle' }),
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(250);
      });
      const container = terminal.element?.parentElement;
      expect(container).toBeTruthy();
      terminal.element!.getBoundingClientRect = () => ({
        bottom: 240,
        height: 240,
        left: 0,
        right: 800,
        top: 0,
        width: 800,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      });
      terminal.selection = 'line-1\nline-2\nline-3';
      terminal.selectionPosition = { end: { x: 6, y: 3 }, start: { x: 0, y: 1 } };

      fireEvent.mouseDown(terminal.element!, { button: 0, buttons: 1 });
      terminal.selectionPosition = { end: { x: 10, y: 4 }, start: { x: 0, y: 1 } };
      terminal.selectionChangeListeners.forEach((listener) => listener());

      const selectBeforeScroll = terminal.select.mock.calls.length;
      fireEvent.wheel(container!, { clientX: 400, clientY: 120, deltaMode: 0, deltaY: 48 });
      expect(terminalApiMock.scroll).toHaveBeenCalledTimes(1);
      const selectAfterDispatch = terminal.select.mock.calls.length;
      expect(selectAfterDispatch).toBeGreaterThan(selectBeforeScroll);

      await act(async () => {
        if (failureKind === 'failure response') {
          scrollDeferred.resolve({ error: 'scroll failed', success: false });
        } else {
          scrollDeferred.reject(new Error('scroll failed'));
        }
        await Promise.resolve();
      });

      // The visual step is rolled back and the range becomes unsafe to copy.
      expect(terminal.select.mock.calls.length).toBeGreaterThan(selectAfterDispatch);
      fireEvent.copy(container!);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10);
        await Promise.resolve();
      });
      expect(clipboardWrite).not.toHaveBeenCalled();

      fireEvent.mouseUp(document, { button: 0, buttons: 0 });
    },
  );

  it('keeps the gesture active during pump drain and completes exactly once after idle', async () => {
    vi.useFakeTimers();
    terminalApiMock.attach.mockResolvedValue({
      cols: 80,
      mode: 'pty',
      rows: 24,
      streamId: 1,
      success: true,
    });
    const terminal = await renderTerminalWithFakeTimers(
      { copyOnSelect: true },
      makePane({ agent: 'opencode', agentStatus: 'idle' }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    const container = terminal.element?.parentElement;
    const attachRequest = terminalApiMock.attach.mock.calls.at(-1)?.[0];
    expect(container).toBeTruthy();
    terminal.element!.getBoundingClientRect = () => ({
      bottom: 240,
      height: 240,
      left: 0,
      right: 800,
      top: 0,
      width: 800,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    terminal.selection = 'line-1\nline-2\nline-3';
    terminal.selectionPosition = { end: { x: 6, y: 3 }, start: { x: 0, y: 1 } };

    fireEvent.mouseDown(terminal.element!, { button: 0, buttons: 1 });
    terminal.selectionPosition = { end: { x: 10, y: 4 }, start: { x: 0, y: 1 } };
    terminal.selectionChangeListeners.forEach((listener) => listener());

    fireEvent.wheel(container!, { clientX: 400, clientY: 120, deltaMode: 0, deltaY: 48 });
    expect(terminalApiMock.scroll).toHaveBeenCalledTimes(1);

    // Mouseup while pump still has in-flight unit — clipboard NOT written yet
    fireEvent.mouseUp(document, { button: 0, buttons: 0 });
    expect(clipboardWrite).not.toHaveBeenCalled();

    // No new enqueues should happen after mouseup
    fireEvent.wheel(container!, { clientY: 100, deltaMode: 0, deltaY: 24 });
    expect(terminalApiMock.scroll).toHaveBeenCalledTimes(1);

    // The first repaint dispatches the queued second unit. The gesture object
    // changes as the visual range advances, but finalization must retain the
    // same generation/range ownership and keep draining.
    terminal.selection = 'line-2\nline-3\nline-4';
    ipcMock.listeners.get(IPC_EVENT.TERMINAL_DATA)?.({
      data: '\x1b[2Jcomplete',
      paneId: 'pane-1',
      source: 'live',
      streamId: attachRequest.streamId,
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(40);
      await Promise.resolve();
    });
    expect(terminalApiMock.scroll).toHaveBeenCalledTimes(2);

    terminal.selection = 'line-3\nline-4\nline-5';
    ipcMock.listeners.get(IPC_EVENT.TERMINAL_DATA)?.({
      data: '\x1b[2Jcomplete-2',
      paneId: 'pane-1',
      source: 'live',
      streamId: attachRequest.streamId,
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(40);
      await Promise.resolve();
    });

    expect(clipboardWrite).toHaveBeenCalledTimes(1);
  });

  it('drains an in-flight selection step before immediate keyboard Copy', async () => {
    vi.useFakeTimers();
    terminalApiMock.attach.mockResolvedValue({ cols: 80, mode: 'pty', rows: 24, streamId: 1, success: true });
    terminalApiMock.expandSelection.mockResolvedValue({ status: 'history-unavailable' });
    const terminal = await renderTerminalWithFakeTimers({}, makePane({ agent: 'opencode', agentStatus: 'idle' }));
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    const container = terminal.element?.parentElement;
    const attachRequest = terminalApiMock.attach.mock.calls.at(-1)?.[0];
    expect(container).toBeTruthy();
    terminal.selection = 'line-1\nline-2\nline-3';
    terminal.selectionPosition = { end: { x: 6, y: 3 }, start: { x: 0, y: 1 } };
    fireEvent.mouseDown(terminal.element!, { button: 0, buttons: 1 });
    terminal.selectionPosition = { end: { x: 10, y: 4 }, start: { x: 0, y: 1 } };
    terminal.selectionChangeListeners.forEach((listener) => listener());
    fireEvent.wheel(container!, { deltaMode: 0, deltaY: 24 });

    fireEvent.copy(container!);
    expect(clipboardWrite).not.toHaveBeenCalled();

    terminal.selection = 'line-2\nline-3\nline-4';
    ipcMock.listeners.get(IPC_EVENT.TERMINAL_DATA)?.({
      data: '\x1b[2Jcopy-final', paneId: 'pane-1', source: 'live', streamId: attachRequest.streamId,
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(40);
      await Promise.resolve();
    });

    expect(clipboardWrite).toHaveBeenCalledWith('line-1\nline-2\nline-3\nline-4');
  });

  it('never copies overshot text after reversing direction past acknowledged growth', async () => {
    // Arrange
    vi.useFakeTimers();
    terminalApiMock.attach.mockResolvedValue({
      cols: 80,
      mode: 'pty',
      rows: 24,
      streamId: 1,
      success: true,
    });
    terminalApiMock.expandSelection.mockResolvedValue({
      status: 'expanded',
      text: 'line-1\nline-2\nline-3\nline-4',
    });
    const terminal = await renderTerminalWithFakeTimers(
      {},
      makePane({ agent: 'opencode', agentStatus: 'idle' }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    const container = terminal.element?.parentElement;
    const attachRequest = terminalApiMock.attach.mock.calls.at(-1)?.[0];
    expect(container).toBeTruthy();
    terminal.element!.getBoundingClientRect = () => ({
      bottom: 240,
      height: 240,
      left: 0,
      right: 800,
      top: 0,
      width: 800,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    terminal.selection = 'line-1\nline-2\nline-3';
    terminal.selectionPosition = { end: { x: 6, y: 3 }, start: { x: 0, y: 1 } };

    fireEvent.mouseDown(terminal.element!, { button: 0, buttons: 1 });
    terminal.selectionPosition = { end: { x: 10, y: 4 }, start: { x: 0, y: 1 } };
    terminal.selectionChangeListeners.forEach((listener) => listener());

    // Act — acknowledge one DOWNWARD growth unit so accumulatedText advances past the anchor
    fireEvent.wheel(container!, { clientX: 400, clientY: 120, deltaMode: 0, deltaY: 24 });
    expect(terminalApiMock.scroll).toHaveBeenCalledTimes(1);
    terminal.selection = 'line-2\nline-3\nline-4';
    ipcMock.listeners.get(IPC_EVENT.TERMINAL_DATA)?.({
      data: '\x1b[2Jadvanced',
      paneId: 'pane-1',
      source: 'live',
      streamId: attachRequest.streamId,
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(40);
      await Promise.resolve();
    });

    // Reverse to the OPPOSITE (up) direction after acknowledged growth
    fireEvent.wheel(container!, { clientX: 400, clientY: 120, deltaMode: 0, deltaY: -24 });

    expect(terminalApiMock.scroll).toHaveBeenCalledTimes(1);

    // A later repaint that is covered by the last verified text cannot rescue
    // a range invalidated by reversal, nor may authoritative history do so.
    terminal.selection = 'line-1\nline-2\nline-3';
    ipcMock.listeners.get(IPC_EVENT.TERMINAL_DATA)?.({
      data: '\x1b[2Jcovered-after-reversal',
      paneId: 'pane-1',
      source: 'live',
      streamId: attachRequest.streamId,
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(40);
    });

    // Assert — the overshot down-range must never reach the clipboard
    fireEvent.copy(container!);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
      await Promise.resolve();
    });
    expect(clipboardWrite).not.toHaveBeenCalled();
    expect(terminalApiMock.expandSelection).not.toHaveBeenCalled();
    expect(useNotificationStore.getState().toasts).toEqual([
      expect.objectContaining({
        severity: 'warning',
        title: 'Selection could not be copied completely',
      }),
    ]);

    fireEvent.mouseUp(document, { button: 0, buttons: 0 });
  });

  it('keeps the in-flight unit pending when the repaint frame is unchanged and dispatches no second probe', async () => {
    vi.useFakeTimers();
    terminalApiMock.attach.mockResolvedValue({
      cols: 80,
      mode: 'pty',
      rows: 24,
      streamId: 1,
      success: true,
    });
    const terminal = await renderTerminalWithFakeTimers(
      {},
      makePane({ agent: 'opencode', agentStatus: 'idle' }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    const container = terminal.element?.parentElement;
    const attachRequest = terminalApiMock.attach.mock.calls.at(-1)?.[0];
    expect(container).toBeTruthy();
    terminal.modes.mouseTrackingMode = 'vt200';
    terminal.selection = 'message-01\nmessage-02\nmessage-03';
    terminal.selectionPosition = { end: { x: 10, y: 3 }, start: { x: 0, y: 1 } };

    fireEvent.mouseDown(terminal.element!, { altKey: true, button: 0, buttons: 1 });
    terminal.selectionPosition = { end: { x: 20, y: 4 }, start: { x: 0, y: 1 } };
    terminal.selectionChangeListeners.forEach((listener) => listener());

    const forwardedWheels = vi.fn();
    terminal.element!.addEventListener('wheel', (event) => {
      if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) forwardedWheels();
    });

    // Two units enqueued: dispatch unit 1 immediately, unit 2 stays queued
    fireEvent.wheel(container!, { deltaMode: 0, deltaY: 48 });
    expect(forwardedWheels).toHaveBeenCalledTimes(1);

    // Unchanged frame (same selection) — must NOT dispatch a second probe
    ipcMock.listeners.get(IPC_EVENT.TERMINAL_DATA)?.({
      data: '\x1b[2Junchanged',
      paneId: 'pane-1',
      source: 'live',
      streamId: attachRequest.streamId,
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(40);
    });

    expect(forwardedWheels).toHaveBeenCalledTimes(1);

    // Advancing frame eventually arrives — unit completes
    terminal.selection = 'message-02\nmessage-03\nmessage-04';
    ipcMock.listeners.get(IPC_EVENT.TERMINAL_DATA)?.({
      data: 'advancing',
      paneId: 'pane-1',
      source: 'live',
      streamId: attachRequest.streamId,
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(40);
    });

    expect(forwardedWheels).toHaveBeenCalledTimes(2);

    fireEvent.mouseUp(document, { button: 0, buttons: 0 });
  });

  it('restores the pre-step anchor on pump stall and discards the speculative unit', async () => {
    vi.useFakeTimers();
    terminalApiMock.attach.mockResolvedValue({
      cols: 80,
      mode: 'pty',
      rows: 24,
      streamId: 1,
      success: true,
    });
    const terminal = await renderTerminalWithFakeTimers(
      {},
      makePane({ agent: 'opencode', agentStatus: 'idle' }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    const container = terminal.element?.parentElement;
    const attachRequest = terminalApiMock.attach.mock.calls.at(-1)?.[0];
    expect(container).toBeTruthy();
    terminal.element!.getBoundingClientRect = () => ({
      bottom: 240,
      height: 240,
      left: 0,
      right: 800,
      top: 0,
      width: 800,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    terminal.selection = 'line-1\nline-2\nline-3';
    terminal.selectionPosition = { end: { x: 5, y: 3 }, start: { x: 0, y: 1 } };

    fireEvent.mouseDown(terminal.element!, { button: 0, buttons: 1 });
    terminal.selectionPosition = { end: { x: 10, y: 4 }, start: { x: 0, y: 1 } };
    terminal.selectionChangeListeners.forEach((listener) => listener());

    fireEvent.wheel(container!, { clientX: 400, clientY: 120, deltaMode: 0, deltaY: 24 });
    expect(terminalApiMock.scroll).toHaveBeenCalledTimes(1);

    // The user can keep dragging while the scroll unit is in flight. Rollback
    // must restore the old anchor without losing this newest pointer.
    fireEvent.mouseMove(document, { buttons: 1, clientX: 600, clientY: 180 });

    const selectAfterDispatch = terminal.select.mock.calls.length;

    // Stall timeout fires (500ms default)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(550);
    });

    // After stall: visual selection must be restored to pre-step state
    expect(terminal.select.mock.calls.length).toBeGreaterThan(selectAfterDispatch);
    expect(terminal.select).toHaveBeenLastCalledWith(0, 1, 1420);

    // A repaint that arrives after the timeout is too late to authorize the
    // speculative unit or redraw unrelated text as the frozen selection.
    terminal.selection = 'line-2\nline-3\nline-4';
    ipcMock.listeners.get(IPC_EVENT.TERMINAL_DATA)?.({
      data: '\x1b[2Jlate-after-stall',
      paneId: 'pane-1',
      source: 'live',
      streamId: attachRequest.streamId,
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(40);
    });
    expect(terminal.clearSelection).toHaveBeenCalledOnce();

    // A silent boundary observed no contradictory frame, so the last verified
    // range remains copyable after the speculative visual unit is rolled back.
    fireEvent.copy(container!);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
      await Promise.resolve();
    });
    expect(clipboardWrite).toHaveBeenCalledWith('line-1\nline-2\nline-3');

    fireEvent.mouseUp(document, { button: 0, buttons: 0 });
  });

  it('does not let history expansion rescue an unverified logical timeout', async () => {
    vi.useFakeTimers();
    terminalApiMock.attach.mockResolvedValue({
      cols: 80,
      mode: 'pty',
      rows: 24,
      streamId: 1,
      success: true,
    });
    terminalApiMock.expandSelection.mockResolvedValue({
      status: 'expanded',
      text: 'line-1\nline-2\nline-3\nunsafe-line-4',
    });
    const terminal = await renderTerminalWithFakeTimers(
      {},
      makePane({ agent: 'opencode', agentStatus: 'idle' }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    const container = terminal.element?.parentElement;
    const attachRequest = terminalApiMock.attach.mock.calls.at(-1)?.[0];
    expect(container).toBeTruthy();
    terminal.selection = 'line-1\nline-2\nline-3';
    terminal.selectionPosition = { end: { x: 5, y: 3 }, start: { x: 0, y: 1 } };

    fireEvent.mouseDown(terminal.element!, { button: 0, buttons: 1 });
    terminal.selectionPosition = { end: { x: 10, y: 4 }, start: { x: 0, y: 1 } };
    terminal.selectionChangeListeners.forEach((listener) => listener());
    fireEvent.wheel(container!, { deltaMode: 0, deltaY: 24 });

    terminal.selection = 'unrelated repaint';
    ipcMock.listeners.get(IPC_EVENT.TERMINAL_DATA)?.({
      data: '\x1b[2Junverified-before-stall',
      paneId: 'pane-1',
      source: 'live',
      streamId: attachRequest.streamId,
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(40);
      await vi.advanceTimersByTimeAsync(510);
    });

    fireEvent.copy(container!);
    await act(async () => {
      await Promise.resolve();
    });

    expect(terminalApiMock.expandSelection).not.toHaveBeenCalled();
    expect(clipboardWrite).not.toHaveBeenCalled();
    expect(useNotificationStore.getState().toasts).toEqual([
      expect.objectContaining({
        severity: 'warning',
        title: 'Selection could not be copied completely',
      }),
    ]);
  });

  it('restores a completed single-viewport PTY selection after a silent review boundary', async () => {
    vi.useFakeTimers();
    terminalApiMock.attach.mockResolvedValue({
      cols: 80,
      mode: 'pty',
      rows: 24,
      streamId: 1,
      success: true,
    });
    const terminal = await renderTerminalWithFakeTimers(
      { copyOnSelect: true },
      makePane({ agent: 'opencode', agentStatus: 'idle' }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    const container = terminal.element?.parentElement;
    expect(container).toBeTruthy();
    terminal.element!.getBoundingClientRect = () => ({
      bottom: 240,
      height: 240,
      left: 0,
      right: 800,
      top: 0,
      width: 800,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    terminal.modes.mouseTrackingMode = 'vt200';
    terminal.selection = '';
    terminal.selectionPosition = undefined;

    fireEvent.mouseDown(terminal.element!, {
      altKey: true,
      button: 0,
      buttons: 1,
      clientX: 1,
      clientY: 10,
    });
    terminal.selection = 'line-1\nline-2\nline-3';
    terminal.selectionPosition = { end: { x: 5, y: 3 }, start: { x: 0, y: 1 } };
    fireEvent.mouseUp(document, { button: 0, buttons: 0, clientX: 50, clientY: 30 });
    await act(async () => { await Promise.resolve(); });
    expect(clipboardWrite).toHaveBeenCalledWith('line-1\nline-2\nline-3');
    clipboardWrite.mockClear();

    terminal.selection = '';
    terminal.selectionPosition = undefined;
    terminal.selectionChangeListeners.forEach((listener) => listener());
    const selectionsBeforeReview = terminal.select.mock.calls.length;
    fireEvent.wheel(container!, {
      clientX: 400,
      clientY: 120,
      deltaMode: 0,
      deltaY: -24,
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(550);
    });

    expect(terminal.select.mock.calls.length).toBeGreaterThan(selectionsBeforeReview);
    fireEvent.copy(container!);
    await act(async () => { await Promise.resolve(); });
    expect(clipboardWrite).toHaveBeenCalledWith('line-1\nline-2\nline-3');
  });

  it.each([
    { chunks: ['\x1bc'], label: 'one chunk' },
    { chunks: ['\x1b', 'c'], label: 'two chunks' },
  ])('drops the logical range when RIS arrives in $label and never restores its old highlight', async ({
    chunks,
  }) => {
    vi.useFakeTimers();
    terminalApiMock.attach.mockResolvedValue({
      cols: 80,
      mode: 'pty',
      rows: 24,
      streamId: 1,
      success: true,
    });
    const terminal = await renderTerminalWithFakeTimers(
      {},
      makePane({ agent: undefined, agentStatus: 'idle', type: 'shell' }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    const container = terminal.element?.parentElement;
    const attachRequest = terminalApiMock.attach.mock.calls.at(-1)?.[0];
    expect(container).toBeTruthy();
    terminal.selection = 'line-1\nline-2\nline-3';
    terminal.selectionPosition = { end: { x: 5, y: 3 }, start: { x: 0, y: 1 } };

    fireEvent.mouseDown(terminal.element!, { button: 0, buttons: 1 });
    terminal.selectionPosition = { end: { x: 10, y: 4 }, start: { x: 0, y: 1 } };
    terminal.selectionChangeListeners.forEach((listener) => listener());
    fireEvent.wheel(container!, { deltaMode: 0, deltaY: 24 });
    terminal.selection = 'line-2\nline-3\nline-4';
    ipcMock.listeners.get(IPC_EVENT.TERMINAL_DATA)?.({
      data: '\x1b[2Jverified-before-reset',
      paneId: 'pane-1',
      source: 'live',
      streamId: attachRequest.streamId,
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(40);
    });
    fireEvent.mouseUp(document, { button: 0, buttons: 0 });
    await act(async () => { await Promise.resolve(); });

    for (const data of chunks) {
      ipcMock.listeners.get(IPC_EVENT.TERMINAL_DATA)?.({
        data,
        paneId: 'pane-1',
        source: 'live',
        streamId: attachRequest.streamId,
      });
      await act(async () => { await Promise.resolve(); });
    }
    expect(terminal.clear).toHaveBeenCalledOnce();
    const visualUpdatesAfterReset = terminal.select.mock.calls.length;

    terminal.selection = '';
    terminal.selectionPosition = undefined;
    ipcMock.listeners.get(IPC_EVENT.TERMINAL_DATA)?.({
      data: 'output-after-reset',
      paneId: 'pane-1',
      source: 'live',
      streamId: attachRequest.streamId,
    });
    await act(async () => { await Promise.resolve(); });

    expect(terminal.select).toHaveBeenCalledTimes(visualUpdatesAfterReset);
    fireEvent.copy(container!);
    await act(async () => { await Promise.resolve(); });
    expect(clipboardWrite).not.toHaveBeenCalled();
  });

  it('stream-mode-changed event for current stream cancels pending selection so copy writes nothing', async () => {
    // Arrange: PTY mode attach with a live scrolled selection in progress
    terminalApiMock.attach.mockResolvedValue({
      cols: 80,
      mode: 'pty',
      rows: 24,
      streamId: 1,
      success: true,
    });
    const terminal = await renderTerminal({}, makePane({ agentStatus: 'idle' }));
    await waitFor(() => expect(terminal.options.disableStdin).toBe(false));
    const attachRequest = terminalApiMock.attach.mock.calls.at(-1)?.[0];
    const container = terminal.element?.parentElement;
    expect(container).toBeTruthy();

    terminal.selection = 'line-01\nline-02\nline-03';
    terminal.selectionPosition = { end: { x: 10, y: 3 }, start: { x: 0, y: 1 } };
    fireEvent.mouseDown(terminal.element!, { button: 0 });
    terminal.selectionPosition = { end: { x: 20, y: 4 }, start: { x: 0, y: 1 } };
    terminal.selectionChangeListeners.forEach((listener) => listener());
    fireEvent.wheel(container!, { deltaMode: 0, deltaY: -24 });
    await waitFor(() => expect(terminalApiMock.scroll).toHaveBeenCalledTimes(1));

    // Act: runtime stream-mode change (PTY → capture) resets selection state
    ipcMock.listeners.get(IPC_EVENT.TERMINAL_STREAM_MODE_CHANGED)?.({
      paneId: 'pane-1',
      streamId: attachRequest.streamId,
      mode: 'capture',
    });

    // Assert: copy writes nothing — selection was invalidated by the mode change
    fireEvent.mouseUp(document, { button: 0 });
    fireEvent.copy(container!);
    await act(async () => {
      await Promise.resolve();
    });
    expect(clipboardWrite).not.toHaveBeenCalled();
  });

  it('mismatched paneId or streamId in stream-mode-changed event does not disturb an active verified selection', async () => {
    // Arrange: PTY mode attach with a verified scrolled selection
    terminalApiMock.attach.mockResolvedValue({
      cols: 80,
      mode: 'pty',
      rows: 24,
      streamId: 1,
      success: true,
    });
    terminalApiMock.expandSelection.mockResolvedValue({
      status: 'expanded',
      text: 'line-01\nline-02\nline-03',
    });
    const terminal = await renderTerminal({}, makePane({ agentStatus: 'idle' }));
    await waitFor(() => expect(terminal.options.disableStdin).toBe(false));
    const attachRequest = terminalApiMock.attach.mock.calls.at(-1)?.[0];
    const container = terminal.element?.parentElement;
    expect(container).toBeTruthy();

    terminal.selection = 'line-01\nline-02\nline-03';
    terminal.selectionPosition = { end: { x: 10, y: 3 }, start: { x: 0, y: 1 } };
    fireEvent.mouseDown(terminal.element!, { button: 0 });
    terminal.selectionPosition = { end: { x: 20, y: 4 }, start: { x: 0, y: 1 } };
    terminal.selectionChangeListeners.forEach((listener) => listener());
    fireEvent.wheel(container!, { deltaMode: 0, deltaY: -24 });
    await waitFor(() => expect(terminalApiMock.scroll).toHaveBeenCalledTimes(1));

    // Act: mismatched paneId — should be ignored
    ipcMock.listeners.get(IPC_EVENT.TERMINAL_STREAM_MODE_CHANGED)?.({
      paneId: 'other-pane',
      streamId: attachRequest.streamId,
      mode: 'capture',
    });

    // Act: mismatched streamId — should also be ignored
    ipcMock.listeners.get(IPC_EVENT.TERMINAL_STREAM_MODE_CHANGED)?.({
      paneId: 'pane-1',
      streamId: attachRequest.streamId + 1,
      mode: 'capture',
    });

    // Assert: copy succeeds — neither stale event disturbed the selection
    terminal.selection = 'line-01\nline-02\nline-03';
    fireEvent.mouseUp(document, { button: 0 });
    fireEvent.copy(container!);
    await waitFor(() => expect(clipboardWrite).toHaveBeenCalledWith(
      'line-01\nline-02\nline-03',
    ));
  });

  it('does not create debug snapshots on ordinary wheel events in production (non-E2E)', async () => {
    // Arrange
    const { terminalDebug } = await import('../src/renderer/lib/terminalDebug');
    const terminal = await renderTerminal({}, makePane({ agent: 'claude', agentStatus: 'idle' }));
    const container = terminal.element?.parentElement;
    expect(container).toBeTruthy();
    vi.mocked(terminalDebug.capture).mockClear();
    vi.mocked(terminalDebug.wheel).mockClear();

    // Act
    fireEvent.wheel(container!, { deltaMode: 0, deltaY: -48 });

    // Assert — production mode: no snapshots, no wheel records
    expect(terminalDebug.capture).not.toHaveBeenCalled();
    expect(terminalDebug.wheel).not.toHaveBeenCalled();
  });

  it('does not create debug snapshots on terminal data writes in production (non-E2E)', async () => {
    // Arrange
    const { terminalDebug } = await import('../src/renderer/lib/terminalDebug');
    const terminal = await renderTerminal({}, makePane({ agent: 'claude', agentStatus: 'idle' }));
    const attachRequest = terminalApiMock.attach.mock.calls.at(-1)?.[0];
    vi.mocked(terminalDebug.capture).mockClear();
    vi.mocked(terminalDebug.data).mockClear();

    // Act
    ipcMock.listeners.get(IPC_EVENT.TERMINAL_DATA)?.({
      data: 'some terminal output',
      paneId: 'pane-1',
      source: 'live',
      streamId: attachRequest.streamId,
    });
    await waitFor(() => expect(terminal.write).toHaveBeenCalled());

    // Assert — production mode: no snapshot allocations before/after writes
    expect(terminalDebug.capture).not.toHaveBeenCalled();
    expect(terminalDebug.data).not.toHaveBeenCalled();
  });

  it('gives fullscreen Claude panes 1.25x scroll sensitivity', async () => {
    // Arrange + Act
    await renderTerminal({}, makePane({
      agent: 'claude',
      claudeRenderer: 'fullscreen',
      agentStatus: 'idle',
    }));

    // Assert
    expect(terminalMock.constructorOptions.at(-1)).toMatchObject({
      scrollSensitivity: 1.25,
    });
  });

  it('gives non-fullscreen-claude panes default 1.0 scroll sensitivity', async () => {
    terminalMock.constructorOptions.length = 0;
    terminalMock.instances.length = 0;
    terminalApiMock.attach.mockClear();

    await renderTerminal({}, makePane({ agent: 'claude', claudeRenderer: 'classic', agentStatus: 'idle' }));
    expect(terminalMock.constructorOptions.at(-1)).toMatchObject({ scrollSensitivity: 1 });

    cleanup();
    terminalMock.constructorOptions.length = 0;
    terminalMock.instances.length = 0;
    terminalApiMock.attach.mockClear();

    await renderTerminal({}, makePane({ agent: 'opencode', agentStatus: 'idle' }));
    expect(terminalMock.constructorOptions.at(-1)).toMatchObject({ scrollSensitivity: 1 });

    cleanup();
    terminalMock.constructorOptions.length = 0;
    terminalMock.instances.length = 0;
    terminalApiMock.attach.mockClear();

    await renderTerminal({}, makePane({ agent: undefined, agentStatus: 'idle', type: 'shell' }));
    expect(terminalMock.constructorOptions.at(-1)).toMatchObject({ scrollSensitivity: 1 });
  });
});
