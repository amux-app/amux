import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  detachTerminalPane,
  getTerminalManager,
  resetTerminalManager,
  setTerminalRendererVisibility,
} from '../../src/main/services/TerminalStreamService';

const settingsState = vi.hoisted(() => ({
  pollingInterval: 250,
  terminalTransport: 'classic',
}));

const managerInstances = vi.hoisted(() => [] as Array<{
  opts: unknown;
  window: unknown;
  manager: {
    destroyAll: ReturnType<typeof vi.fn>;
    detach: ReturnType<typeof vi.fn>;
    removePane: ReturnType<typeof vi.fn>;
    resumeRendererDelivery: ReturnType<typeof vi.fn>;
    setOptions: ReturnType<typeof vi.fn>;
    suspendRendererDelivery: ReturnType<typeof vi.fn>;
  };
}>);

vi.mock('../../src/main/services/ElectronSettingsService.js', () => ({
  ElectronSettingsService: {
    getInstance: () => ({
      getAll: () => ({ ...settingsState }),
    }),
  },
}));

vi.mock('../../src/main/services/TerminalManager.js', () => ({
  TerminalManager: vi.fn().mockImplementation((window: unknown, opts: unknown) => {
    const manager = {
      destroyAll: vi.fn(),
      detach: vi.fn(),
      removePane: vi.fn(),
      resumeRendererDelivery: vi.fn().mockResolvedValue(undefined),
      setOptions: vi.fn(),
      suspendRendererDelivery: vi.fn(),
    };
    managerInstances.push({ manager, opts, window });
    return manager;
  }),
}));

function bridgeWithWindow(label: string, visible = true) {
  const window = {
    isDestroyed: () => false,
    isMinimized: () => false,
    isVisible: () => visible,
    label,
  };
  return {
    getWindow: () => window,
    recordTerminalActivity: vi.fn(),
  } as never;
}

describe('TerminalStreamService', () => {
  beforeEach(() => {
    resetTerminalManager();
    managerInstances.length = 0;
    settingsState.pollingInterval = 250;
    settingsState.terminalTransport = 'classic';
  });

  it('removes logical panes through the shared terminal manager', () => {
    // Arrange
    const manager = getTerminalManager(bridgeWithWindow('main-window'));

    // Act
    detachTerminalPane('pane-1');

    // Assert
    expect(manager.removePane).toHaveBeenCalledWith('pane-1');
    expect(manager.detach).not.toHaveBeenCalled();
    expect(managerInstances).toHaveLength(1);
    expect(managerInstances[0].opts).toEqual({
      onTerminalData: expect.any(Function),
      pollIntervalMs: 250,
      transportMode: 'classic',
    });
  });

  it('forwards terminal data to the bridge activity boundary', () => {
    const bridge = bridgeWithWindow('main-window') as unknown as {
      recordTerminalActivity: ReturnType<typeof vi.fn>;
    };
    getTerminalManager(bridge as never);
    const opts = managerInstances[0].opts as {
      onTerminalData: (paneId: string, data: string, source: 'live' | 'replay') => void;
    };

    opts.onTerminalData('pane-1', 'working', 'live');

    expect(bridge.recordTerminalActivity).toHaveBeenCalledWith('pane-1', 'working', 'live');
  });

  it('resets active streams and recreates the manager cleanly', () => {
    // Arrange
    const first = getTerminalManager(bridgeWithWindow('first-window'));

    // Act
    resetTerminalManager();
    settingsState.pollingInterval = 500;
    settingsState.terminalTransport = 'control';
    const second = getTerminalManager(bridgeWithWindow('second-window'));

    // Assert
    expect(first.destroyAll).toHaveBeenCalledTimes(1);
    expect(second).not.toBe(first);
    expect(managerInstances).toHaveLength(2);
    expect(managerInstances[1].opts).toEqual({
      onTerminalData: expect.any(Function),
      pollIntervalMs: 500,
      transportMode: 'control',
    });
  });

  it('forwards window visibility without creating a terminal manager', async () => {
    setTerminalRendererVisibility(false);
    await setTerminalRendererVisibility(true);
    expect(managerInstances).toHaveLength(0);

    const manager = getTerminalManager(bridgeWithWindow('main-window'));
    setTerminalRendererVisibility(false);
    await setTerminalRendererVisibility(true);

    expect(manager.suspendRendererDelivery).toHaveBeenCalledOnce();
    expect(manager.resumeRendererDelivery).toHaveBeenCalledOnce();
  });

  it('creates the terminal manager suspended when the window is already hidden', () => {
    const manager = getTerminalManager(bridgeWithWindow('main-window', false));

    expect(manager.suspendRendererDelivery).toHaveBeenCalledOnce();
    expect(manager.resumeRendererDelivery).not.toHaveBeenCalled();
  });

  it('uses the BrowserWindow as authority when a pre-manager visibility event is stale', () => {
    setTerminalRendererVisibility(false);

    const manager = getTerminalManager(bridgeWithWindow('main-window', true));

    expect(manager.suspendRendererDelivery).not.toHaveBeenCalled();
  });
});
