import type { BrowserWindow } from 'electron';
import { ElectronSettingsService } from './ElectronSettingsService.js';
import { TerminalManager } from './TerminalManager.js';

let terminalManager: TerminalManager | null = null;

interface TerminalStreamBridgePort {
  getWindow(): BrowserWindow | null;
  recordTerminalActivity(paneId: string, data: string, source: 'live' | 'replay'): void;
}

export function getTerminalManager(bridge: TerminalStreamBridgePort): TerminalManager {
  const settings = ElectronSettingsService.getInstance().getAll();
  const browserWindow = bridge.getWindow();
  const windowVisible = Boolean(
    browserWindow
    && !browserWindow.isDestroyed()
    && browserWindow.isVisible()
    && !browserWindow.isMinimized(),
  );

  if (!terminalManager) {
    terminalManager = new TerminalManager(browserWindow, {
      pollIntervalMs: settings.pollingInterval,
      onTerminalData: (paneId, data, source) => bridge.recordTerminalActivity(paneId, data, source),
      transportMode: settings.terminalTransport,
    });
    if (!windowVisible) {
      terminalManager.suspendRendererDelivery();
    }
  } else {
    if (browserWindow) terminalManager.setWindow(browserWindow);
    terminalManager.setOptions({
      pollIntervalMs: settings.pollingInterval,
      transportMode: settings.terminalTransport,
    });
    if (windowVisible) {
      void terminalManager.resumeRendererDelivery();
    } else {
      terminalManager.suspendRendererDelivery();
    }
  }
  return terminalManager;
}

export function detachTerminalPane(paneId: string): void {
  terminalManager?.removePane(paneId);
}

export function getPreferredTerminalLaunchSize(): { cols: number; rows: number } | null {
  return terminalManager?.getPreferredLaunchSize() ?? null;
}

export function setTerminalRendererVisibility(visible: boolean): Promise<void> {
  if (!terminalManager) return Promise.resolve();
  if (!visible) {
    terminalManager.suspendRendererDelivery();
    return Promise.resolve();
  }
  return terminalManager.resumeRendererDelivery();
}

export function resetTerminalManager(): void {
  terminalManager?.destroyAll();
  terminalManager = null;
}
