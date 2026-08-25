// @vitest-environment happy-dom
import { act, cleanup, render, screen } from '@testing-library/react';
import type { MuxBasePane } from 'muxbase/core';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ATTACH_REJECTION_BACKOFF_MS,
  InteractiveTerminal,
  RECONNECTING_NOTICE_DELAY_MS,
} from '../src/renderer/components/pane-detail/InteractiveTerminal';
import {
  useAgentSessionStore,
  useElectronSettingsStore,
  useNotificationStore,
  usePaneStore,
  useProjectStore,
  useTerminalStore,
} from '../src/renderer/stores';

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

const UNAUTHORIZED = 'Unauthorized terminal pane';
const TOTAL_BACKOFF_MS = ATTACH_REJECTION_BACKOFF_MS.reduce((total, delay) => total + delay, 0);
const resizeObserverCallbacks: Array<() => void> = [];

function makePane(overrides: Partial<MuxBasePane> = {}): MuxBasePane {
  return {
    agentStatus: 'idle',
    id: 'pane-1',
    paneId: '%1',
    projectRoot: '/repo',
    prompt: 'shell',
    slug: 'shell-1',
    type: 'shell',
    ...overrides,
  };
}

function resetStores(pane: MuxBasePane): void {
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
}

async function settle(ms = 0): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function isAttached(paneId: string): boolean {
  return useTerminalStore.getState().attachedPaneIds.has(paneId);
}

describe('InteractiveTerminal attach rejection retry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    terminalMock.instances.length = 0;
    terminalMock.Terminal.mockClear();
    terminalApiMock.attach.mockReset().mockResolvedValue({ success: true, cols: 80, rows: 24 });
    terminalApiMock.detach.mockClear();
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    resizeObserverCallbacks.length = 0;
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: () => void) {
        resizeObserverCallbacks.push(callback);
      }

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

  it('recovers without a failure card when a rejected attach later succeeds', async () => {
    // Arrange
    const pane = makePane();
    resetStores(pane);
    terminalApiMock.attach
      .mockResolvedValueOnce({ success: false, error: UNAUTHORIZED })
      .mockResolvedValue({ success: true, cols: 80, rows: 24 });

    // Act
    render(<InteractiveTerminal pane={pane} terminalVisible />);
    await settle(20);
    expect(isAttached(pane.id)).toBe(false);
    await settle(ATTACH_REJECTION_BACKOFF_MS[0]);

    // Assert
    expect(terminalApiMock.attach).toHaveBeenCalledTimes(2);
    expect(isAttached(pane.id)).toBe(true);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows the failure card only once the bounded retries are exhausted', async () => {
    // Arrange
    const pane = makePane();
    resetStores(pane);
    terminalApiMock.attach.mockResolvedValue({ success: false, error: UNAUTHORIZED });

    // Act
    render(<InteractiveTerminal pane={pane} terminalVisible />);
    await settle(20);
    await settle(TOTAL_BACKOFF_MS - ATTACH_REJECTION_BACKOFF_MS.at(-1)!);
    const cardBeforeExhaustion = screen.queryByRole('alert');
    await settle(ATTACH_REJECTION_BACKOFF_MS.at(-1)!);

    // Assert
    expect(cardBeforeExhaustion).toBeNull();
    expect(terminalApiMock.attach).toHaveBeenCalledTimes(ATTACH_REJECTION_BACKOFF_MS.length + 1);
    expect(screen.getByRole('alert').textContent).toContain('Terminal disconnected');
    expect(screen.getByRole('alert').textContent).toContain(UNAUTHORIZED);
    expect(isAttached(pane.id)).toBe(false);
  });

  it('ignores resize events during a rejection backoff instead of burning retry slots', async () => {
    // Arrange
    const pane = makePane();
    resetStores(pane);
    terminalApiMock.attach.mockResolvedValue({ success: false, error: UNAUTHORIZED });
    render(<InteractiveTerminal pane={pane} terminalVisible />);
    await settle(20);
    expect(terminalApiMock.attach).toHaveBeenCalledOnce();
    expect(resizeObserverCallbacks).not.toHaveLength(0);

    // Act
    for (let tick = 0; tick < 20; tick += 1) {
      await act(async () => {
        resizeObserverCallbacks.forEach((callback) => callback());
      });
      await settle(10);
    }

    // Assert
    expect(terminalApiMock.attach).toHaveBeenCalledOnce();
    expect(screen.queryByRole('alert')).toBeNull();
    await settle(ATTACH_REJECTION_BACKOFF_MS[0]);
    expect(terminalApiMock.attach).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('keeps a sub-second shell recovery silent', async () => {
    // Arrange
    const pane = makePane();
    resetStores(pane);
    terminalApiMock.attach
      .mockResolvedValueOnce({ success: false, error: UNAUTHORIZED })
      .mockResolvedValue({ success: true, cols: 80, rows: 24 });

    // Act
    render(<InteractiveTerminal pane={pane} terminalVisible />);
    await settle(20);
    const noticeDuringBackoff = screen.queryByTestId('terminal-failure-card');
    await settle(ATTACH_REJECTION_BACKOFF_MS[0]);

    // Assert
    expect(noticeDuringBackoff).toBeNull();
    expect(isAttached(pane.id)).toBe(true);
    expect(screen.queryByTestId('terminal-failure-card')).toBeNull();
  });

  it('shows the reconnecting notice only when recovery is sustained', async () => {
    // Arrange
    const pane = makePane();
    resetStores(pane);
    terminalApiMock.attach.mockResolvedValue({ success: false, error: UNAUTHORIZED });

    // Act
    render(<InteractiveTerminal pane={pane} terminalVisible />);
    await settle(20);
    await settle(RECONNECTING_NOTICE_DELAY_MS - 40);
    const noticeBeforeDelay = screen.queryByTestId('terminal-failure-card');
    await settle(40);
    const noticeAfterDelay = screen.getByTestId('terminal-failure-card');

    // Assert
    expect(noticeBeforeDelay).toBeNull();
    expect(noticeAfterDelay.getAttribute('role')).toBe('status');
    expect(noticeAfterDelay.textContent).toContain('Reconnecting terminal');
    expect(noticeAfterDelay.textContent).toContain('Retrying automatically');
  });

  it('keeps an agent pane on its boot overlay instead of the reconnecting notice', async () => {
    // Arrange
    const pane = makePane({ agent: 'claude', agentStatus: 'working', type: 'worktree' });
    resetStores(pane);
    terminalApiMock.attach.mockResolvedValue({ success: false, error: UNAUTHORIZED });

    // Act
    render(<InteractiveTerminal pane={pane} terminalVisible />);
    await settle(20);
    await settle(TOTAL_BACKOFF_MS - ATTACH_REJECTION_BACKOFF_MS.at(-1)!);

    // Assert
    expect(terminalApiMock.attach).toHaveBeenCalledTimes(ATTACH_REJECTION_BACKOFF_MS.length);
    expect(screen.getByTestId('terminal-boot-overlay').getAttribute('data-booting')).toBe('true');
    expect(screen.queryByTestId('terminal-failure-card')).toBeNull();
  });

  it('offers no reconnect button while reconnecting and shows the failure card once retries are exhausted', async () => {
    // Arrange
    const pane = makePane();
    resetStores(pane);
    terminalApiMock.attach.mockResolvedValue({ success: false, error: UNAUTHORIZED });

    // Act
    render(<InteractiveTerminal pane={pane} terminalVisible />);
    await settle(20);
    await settle(RECONNECTING_NOTICE_DELAY_MS);
    const roleDuringBackoff = screen.getByTestId('terminal-failure-card').getAttribute('role');
    const buttonDuringBackoff = screen.queryByRole('button', { name: 'Reconnect terminal' });
    await settle(TOTAL_BACKOFF_MS);

    // Assert
    expect(roleDuringBackoff).toBe('status');
    expect(buttonDuringBackoff).toBeNull();
    const failureCard = screen.getByTestId('terminal-failure-card');
    expect(failureCard.getAttribute('role')).toBe('alert');
    expect(failureCard.textContent).toContain('Terminal disconnected');
    expect(screen.getByRole('button', { name: 'Reconnect terminal' })).toBeTruthy();
  });

  it('remounts a fresh alert node instead of mutating the reconnecting role in place', async () => {
    // Arrange
    const pane = makePane();
    resetStores(pane);
    terminalApiMock.attach.mockResolvedValue({ success: false, error: UNAUTHORIZED });

    // Act
    render(<InteractiveTerminal pane={pane} terminalVisible />);
    await settle(20);
    await settle(RECONNECTING_NOTICE_DELAY_MS);
    const reconnectingNotice = screen.getByTestId('terminal-failure-card');
    await settle(TOTAL_BACKOFF_MS);
    const failureCard = screen.getByTestId('terminal-failure-card');

    // Assert
    expect(reconnectingNotice.getAttribute('role')).toBe('status');
    expect(failureCard).not.toBe(reconnectingNotice);
    expect(reconnectingNotice.isConnected).toBe(false);
    expect(failureCard.getAttribute('role')).toBe('alert');
  });

  it('lets clicks through the reconnecting notice but keeps the failure card interactive', async () => {
    // Arrange
    const pane = makePane();
    resetStores(pane);
    terminalApiMock.attach.mockResolvedValue({ success: false, error: UNAUTHORIZED });

    // Act
    render(<InteractiveTerminal pane={pane} terminalVisible />);
    await settle(20);
    await settle(RECONNECTING_NOTICE_DELAY_MS);
    const reconnectingClassName = screen.getByTestId('terminal-failure-card').className;
    await settle(TOTAL_BACKOFF_MS);
    const failureCard = screen.getByTestId('terminal-failure-card');

    // Assert
    expect(reconnectingClassName).toContain('pointer-events-none');
    expect(failureCard.className).not.toContain('pointer-events-none');
    expect(failureCard.contains(screen.getByRole('button', { name: 'Reconnect terminal' }))).toBe(true);
  });

  it('cancels pending attach retries when the terminal unmounts', async () => {
    // Arrange
    const pane = makePane();
    resetStores(pane);
    terminalApiMock.attach.mockResolvedValue({ success: false, error: UNAUTHORIZED });
    const view = render(<InteractiveTerminal pane={pane} terminalVisible />);
    await settle(20);
    expect(terminalApiMock.attach).toHaveBeenCalledOnce();

    // Act
    view.unmount();
    await settle(TOTAL_BACKOFF_MS);

    // Assert
    expect(terminalApiMock.attach).toHaveBeenCalledOnce();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
