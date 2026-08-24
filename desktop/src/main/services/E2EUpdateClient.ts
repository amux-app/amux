import type { ElectronUpdaterLike } from './ElectronUpdateService.js';

const E2E_UPDATE_SCENARIOS = [
  'ready',
  'manual-error',
  'not-available',
  'not-in-applications',
] as const;

type E2EUpdateScenario = (typeof E2E_UPDATE_SCENARIOS)[number];

interface E2EUpdateEnvironment extends NodeJS.ProcessEnv {
  AUMX_E2E?: string;
  AUMX_E2E_UPDATE_CURRENT_VERSION?: string;
  AUMX_E2E_UPDATE_SCENARIO?: string;
  AUMX_E2E_UPDATE_VERSION?: string;
  NODE_ENV?: string;
}

interface E2EUpdateHarness {
  currentVersion: string;
  inApplicationsFolder: boolean;
  updater: ElectronUpdaterLike;
}

/**
 * Deterministic updater used by packaged-flow Electron tests. The double guard
 * prevents a production invocation from selecting a synthetic update feed.
 */
export function createE2EUpdateHarness(
  environment: E2EUpdateEnvironment,
): E2EUpdateHarness | null {
  if (environment.NODE_ENV !== 'test' || environment.AUMX_E2E !== '1') return null;

  const scenario = E2E_UPDATE_SCENARIOS.find(
    (candidate) => candidate === environment.AUMX_E2E_UPDATE_SCENARIO,
  );
  if (!scenario) return null;

  return {
    currentVersion: environment.AUMX_E2E_UPDATE_CURRENT_VERSION ?? '0.0.1',
    inApplicationsFolder: scenario !== 'not-in-applications',
    updater: new E2EUpdateClient(scenario, environment.AUMX_E2E_UPDATE_VERSION ?? '0.0.2'),
  };
}

class E2EUpdateClient implements ElectronUpdaterLike {
  allowDowngrade = true;
  allowPrerelease = true;
  autoDownload = false;
  autoInstallOnAppQuit = false;
  channel: string | null = null;
  fullChangelog = true;

  private readonly listeners = new Map<string, Set<(payload: unknown) => void>>();

  constructor(
    private readonly scenario: E2EUpdateScenario,
    private readonly targetVersion: string,
  ) {}

  async checkForUpdates(): Promise<unknown> {
    this.emit('checking-for-update');

    if (this.scenario === 'manual-error') {
      const error = new Error('E2E network unavailable');
      this.emit('error', error);
      throw error;
    }
    if (this.scenario === 'not-available') {
      this.emit('update-not-available', { version: this.targetVersion });
      return null;
    }
    if (this.scenario === 'not-in-applications') {
      throw new Error('Disabled E2E updater must never be called');
    }

    const updateInfo = { version: this.targetVersion };
    this.emit('update-available', updateInfo);
    setTimeout(() => {
      this.emit('download-progress', {
        bytesPerSecond: 2_000_000,
        percent: 42,
        total: 1_000,
        transferred: 420,
      });
    }, 20);
    setTimeout(() => {
      this.emit('update-downloaded', updateInfo);
    }, 40);
    return updateInfo;
  }

  on(event: string, listener: (payload: unknown) => void): unknown {
    const listeners = this.listeners.get(event) ?? new Set<(payload: unknown) => void>();
    listeners.add(listener);
    this.listeners.set(event, listeners);
    return this;
  }

  removeListener(event: string, listener: (payload: unknown) => void): unknown {
    this.listeners.get(event)?.delete(listener);
    return this;
  }

  quitAndInstall(): void {
    // The actual quit/install path is covered by UpdateService and quit-guard
    // integration tests. Electron UI tests must retain their process so they can
    // assert the resulting installing state without mutating a developer machine.
  }

  private emit(event: string, payload?: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) listener(payload);
  }
}
