import type { IpcMainInvokeEvent, WebContents, WebFrameMain } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  assertMainWindowSender,
  isTrustedIpcUrl,
  secureHandle,
  setMainWindowResolver,
} from '../../src/main/ipc/ipc-security';

const handleMock = vi.hoisted(() => vi.fn());

vi.mock('electron', () => ({
  ipcMain: { handle: handleMock },
}));

function webContentsWithMainFrame(): WebContents {
  return {
    mainFrame: { url: 'file:///app/index.html' } as WebFrameMain,
  } as WebContents;
}

function eventWithSender(
  sender: WebContents,
  senderFrame: WebFrameMain | null = sender.mainFrame,
): IpcMainInvokeEvent {
  return { sender, senderFrame } as unknown as IpcMainInvokeEvent;
}

describe('assertMainWindowSender', () => {
  beforeEach(() => {
    handleMock.mockReset();
  });

  afterEach(() => {
    setMainWindowResolver(() => null);
  });

  it('fails closed when no main-window resolver is available', () => {
    // Arrange
    setMainWindowResolver(() => null);
    const foreign = webContentsWithMainFrame();

    // Act & Assert
    expect(() => assertMainWindowSender(eventWithSender(foreign)))
      .toThrow('IPC sender is not the main window');
  });

  it('passes when the sender matches the resolved main window', () => {
    // Arrange
    const main = webContentsWithMainFrame();
    setMainWindowResolver(() => main);

    // Act & Assert
    expect(() => assertMainWindowSender(eventWithSender(main))).not.toThrow();
  });

  it('throws when the sender is a different webContents', () => {
    // Arrange
    const main = webContentsWithMainFrame();
    const foreign = webContentsWithMainFrame();
    setMainWindowResolver(() => main);

    // Act & Assert
    expect(() => assertMainWindowSender(eventWithSender(foreign))).toThrow('IPC sender is not the main window');
  });

  it('throws when a subframe in the main window invokes IPC', () => {
    // Arrange
    const main = webContentsWithMainFrame();
    const subframe = {} as WebFrameMain;
    setMainWindowResolver(() => main);

    // Act & Assert
    expect(() => assertMainWindowSender(eventWithSender(main, subframe)))
      .toThrow('IPC sender is not the main window');
  });

  it('protects handlers by main-window identity by default', () => {
    // Arrange
    const main = webContentsWithMainFrame();
    const foreign = webContentsWithMainFrame();
    setMainWindowResolver(() => main);
    secureHandle('test:secure', () => 'ok');
    const registered = handleMock.mock.calls[0]?.[1] as (event: IpcMainInvokeEvent) => unknown;

    // Act & Assert
    expect(() => registered(eventWithSender(foreign)))
      .toThrow('IPC sender is not the main window');
  });
});

describe('isTrustedIpcUrl', () => {
  it('allows packaged file/app URLs', () => {
    expect(isTrustedIpcUrl('file:///app/index.html', { isDev: false })).toBe(true);
    expect(isTrustedIpcUrl('app://renderer/index.html', { isDev: false })).toBe(true);
  });

  it('rejects http URLs in production', () => {
    expect(isTrustedIpcUrl('http://localhost:5173/', { isDev: false })).toBe(false);
  });

  it('allows configured dev renderer origin', () => {
    expect(
      isTrustedIpcUrl('http://localhost:5173/?foo=1', {
        isDev: true,
        rendererUrl: 'http://localhost:5173/',
      }),
    ).toBe(true);
  });

  it('rejects mismatched dev origin when renderer url is configured', () => {
    expect(
      isTrustedIpcUrl('http://127.0.0.1:5173/', {
        isDev: true,
        rendererUrl: 'http://localhost:5173/',
      }),
    ).toBe(false);
  });

  it('falls back to loopback-only allowance in dev when renderer URL is missing', () => {
    expect(isTrustedIpcUrl('http://127.0.0.1:5173/', { isDev: true, rendererUrl: undefined })).toBe(true);
    expect(isTrustedIpcUrl('http://localhost:3000/app', { isDev: true, rendererUrl: undefined })).toBe(true);
    expect(isTrustedIpcUrl('http://192.168.1.9:5173/', { isDev: true, rendererUrl: undefined })).toBe(false);
  });

  it('rejects malformed URLs', () => {
    expect(isTrustedIpcUrl('not-a-url', { isDev: true })).toBe(false);
  });
});
