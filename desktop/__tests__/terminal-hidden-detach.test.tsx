// @vitest-environment happy-dom
import { act, cleanup, render } from '@testing-library/react';
import type { AumxPane } from 'aumx/core';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  InteractiveTerminal,
  TERMINAL_HIDDEN_DETACH_DELAY_MS,
} from '../src/renderer/components/pane-detail/InteractiveTerminal';
import {
  useAgentSessionStore,
  useElectronSettingsStore,
  useNotificationStore,
  usePaneStore,
  useProjectStore,
  useTerminalStore,
} from '../src/renderer/stores';

interface FakeTerminalInstance {
  buffer: { active: { baseY: number; type: 'alternate'; viewportY: number } };
  cols: number;
  element: HTMLElement | null;
  modes: { mouseTrackingMode: 'none' };
  options: Record<string, unknown>;
  rows: number;
  unicode: { activeVersion: string; register: ReturnType<typeof vi.fn> };
  dispose: ReturnType<typeof vi.fn>;
}

const terminalMock = vi.hoisted(() => {
  const instances: Array<Record<string, unknown>> = [];
  const disposer = () => ({ dispose: vi.fn() });

  const Terminal = vi.fn((options: Record<string, unknown>) => {
    const terminal = {
      buffer: { active: { baseY: 0, type: 'alternate', viewportY: 0 } },
      cols: 80,
      element: null as HTMLElement | null,
      modes: { mouseTrackingMode: 'none' },
      options: { ...options },
      rows: 24,
      unicode: { activeVersion: '6', register: vi.fn() },
      attachCustomKeyEventHandler: vi.fn(),
      blur: vi.fn(),
      clear: vi.fn(),
      clearTextureAtlas: vi.fn(),
      dispose: vi.fn(),
      focus: vi.fn(),
      getSelection: vi.fn(() => ''),
      loadAddon: vi.fn(),
      onBell: vi.fn(disposer),
      onData: vi.fn(disposer),
      onKey: vi.fn(disposer),
      onSelectionChange: vi.fn(disposer),
      open: vi.fn((container: HTMLElement) => {
        const element = document.createElement('div');
        element.className = 'xterm';
        container.appendChild(element);
        terminal.element = element;
      }),
      parser: { registerOscHandler: vi.fn(disposer) },
      refresh: vi.fn(),
      registerLinkProvider: vi.fn(disposer),
      resize: vi.fn(),
      scrollLines: vi.fn(),
      scrollToBottom: vi.fn(),
      scrollToLine: vi.fn(),
      selectAll: vi.fn(),
      write: vi.fn((_data: string, callback?: () => void) => callback?.()),
    };
    instances.push(terminal);
    return terminal;
  });

  return { instances, Terminal };
});

const terminalApiMock = vi.hoisted(() => ({
  attach: vi.fn(() => Promise.resolve({ success: true, cols: 80, rows: 24 })),
  detach: vi.fn(),
  resize: vi.fn(() => Promise.resolve({ success: true })),
  scroll: vi.fn(() => Promise.resolve({ success: true })),
  unlockStdin: vi.fn(),
  write: vi.fn(),
}));

vi.mock('@xterm/xterm', () => ({ Terminal: terminalMock.Terminal }));

vi.mock('@xterm/addon-fit', () => ({ FitAddon: vi.fn() }));

vi.mock('@xterm/addon-search', () => ({
  SearchAddon: vi.fn(() => ({
    clearDecorations: vi.fn(),
    findNext: vi.fn(),
    findPrevious: vi.fn(),
    onDidChangeResults: vi.fn(() => ({ dispose: vi.fn() })),
  })),
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
  WebglAddon: vi.fn(() => ({
    dispose: vi.fn(),
    onContextLoss: vi.fn(() => ({ dispose: vi.fn() })),
  })),
}));

vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: vi.fn() }));

vi.mock('../src/renderer/api/ipc', () => ({ on: vi.fn(() => vi.fn()) }));

vi.mock('../src/renderer/api/system.api', () => ({
  clipboardRead: vi.fn(() => Promise.resolve('')),
  clipboardWrite: vi.fn(() => Promise.resolve()),
  openExternal: vi.fn(() => Promise.resolve()),
}));

vi.mock('../src/renderer/api/terminal.api', () => terminalApiMock);

vi.mock('../src/renderer/lib/terminal-fit', () => ({
  fitTerminalToContainer: vi.fn(() => ({ cols: 80, rows: 24 })),
}));

vi.mock('../src/renderer/lib/terminal-fonts', () => ({
  loadTerminalFonts: vi.fn(() => Promise.resolve()),
}));

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

function makePane(): AumxPane {
  return {
    agent: 'opencode',
    agentStatus: 'idle',
    id: 'pane-1',
    paneId: '%1',
    projectRoot: '/repo',
    prompt: 'Explain the architecture',
    slug: 'explain-architecture',
    type: 'worktree',
    worktreePath: '/repo/.aumx/worktrees/explain-architecture',
  };
}

function resetStores(pane: AumxPane): void {
  useAgentSessionStore.setState({ sessions: {} });
  useElectronSettingsStore.setState({ isLoading: false, settings: null });
  useNotificationStore.setState({ toasts: [] });
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
      configPath: '/repo/.aumx/aumx.config.json',
      name: 'repo',
      paneCount: 1,
      root: '/repo',
      sessionName: 'aumx-repo',
    },
    projectSwitching: false,
    projects: [],
    sessionName: 'aumx-repo',
    sessionProjectName: 'repo',
    sessionProjectRoot: '/repo',
  });
  useTerminalStore.setState({
    attachedPaneIds: new Set<string>(),
    seenPaneIds: new Set<string>(),
  });
}

async function settle(ms = 0): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function lastTerminal(): FakeTerminalInstance {
  return terminalMock.instances.at(-1) as unknown as FakeTerminalInstance;
}

function isAttached(paneId: string): boolean {
  return useTerminalStore.getState().attachedPaneIds.has(paneId);
}

describe('InteractiveTerminal hidden-tab detach', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    terminalMock.instances.length = 0;
    terminalMock.Terminal.mockClear();
    terminalApiMock.attach.mockClear();
    terminalApiMock.detach.mockClear();
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    vi.stubGlobal('ResizeObserver', class {
      observe = vi.fn();
      disconnect = vi.fn();
      unobserve = vi.fn();
    });
    vi.stubGlobal('matchMedia', vi.fn(() => ({
      addEventListener: vi.fn(),
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

  it('keeps the stream attached when a hidden tab is reopened inside the grace period', async () => {
    // Arrange
    const pane = makePane();
    resetStores(pane);
    const view = render(<InteractiveTerminal pane={pane} terminalVisible />);
    await settle(20);
    expect(terminalApiMock.attach).toHaveBeenCalledOnce();
    expect(isAttached(pane.id)).toBe(true);

    // Act
    view.rerender(<InteractiveTerminal pane={pane} terminalVisible={false} />);
    await settle(TERMINAL_HIDDEN_DETACH_DELAY_MS - 100);
    view.rerender(<InteractiveTerminal pane={pane} terminalVisible />);
    await settle(TERMINAL_HIDDEN_DETACH_DELAY_MS * 2);

    // Assert
    expect(terminalApiMock.detach).not.toHaveBeenCalled();
    expect(terminalApiMock.attach).toHaveBeenCalledOnce();
    expect(terminalMock.instances).toHaveLength(1);
    expect(isAttached(pane.id)).toBe(true);
  });

  it('detaches the tmux stream once the hidden grace period elapses', async () => {
    // Arrange
    const pane = makePane();
    resetStores(pane);
    const view = render(<InteractiveTerminal pane={pane} terminalVisible />);
    await settle(20);
    const terminal = lastTerminal();

    // Act
    view.rerender(<InteractiveTerminal pane={pane} terminalVisible={false} />);
    await settle(TERMINAL_HIDDEN_DETACH_DELAY_MS);

    // Assert
    expect(terminalApiMock.detach).toHaveBeenCalledWith({ paneId: pane.id });
    expect(terminal.dispose).toHaveBeenCalledOnce();
    expect(isAttached(pane.id)).toBe(false);
  });

  it('re-attaches a fresh terminal when the tab becomes visible again', async () => {
    // Arrange
    const pane = makePane();
    resetStores(pane);
    const view = render(<InteractiveTerminal pane={pane} terminalVisible />);
    await settle(20);
    view.rerender(<InteractiveTerminal pane={pane} terminalVisible={false} />);
    await settle(TERMINAL_HIDDEN_DETACH_DELAY_MS);
    expect(isAttached(pane.id)).toBe(false);

    // Act
    view.rerender(<InteractiveTerminal pane={pane} terminalVisible />);
    await settle(20);

    // Assert
    expect(terminalApiMock.attach).toHaveBeenCalledTimes(2);
    expect(terminalMock.instances).toHaveLength(2);
    expect(isAttached(pane.id)).toBe(true);
  });

  it('stays attached for mount sites that omit the visibility prop', async () => {
    // Arrange
    const pane = makePane();
    resetStores(pane);

    // Act
    render(<InteractiveTerminal pane={pane} />);
    await settle(20);
    await settle(TERMINAL_HIDDEN_DETACH_DELAY_MS * 2);

    // Assert
    expect(terminalApiMock.attach).toHaveBeenCalledOnce();
    expect(terminalApiMock.detach).not.toHaveBeenCalled();
    expect(isAttached(pane.id)).toBe(true);
  });
});
