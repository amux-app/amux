import { ipcMain, type IpcMainInvokeEvent, type WebContents } from 'electron';
import { validateIpcInvokeArgs } from './ipc-request-validation.js';

interface TrustCheckOptions {
  isDev?: boolean;
  rendererUrl?: string | undefined;
}

interface SecureHandleOptions {
  mainWindowOnly?: boolean;
}

let mainWindowWebContentsResolver: (() => WebContents | null) | null = null;

export function setMainWindowResolver(fn: () => WebContents | null): void {
  mainWindowWebContentsResolver = fn;
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1';
}

export function isTrustedIpcUrl(url: string, options: TrustCheckOptions = {}): boolean {
  if (!url) return false;
  if (url.startsWith('file://') || url.startsWith('app://')) return true;

  const inferredDevMode = !!process.env['ELECTRON_RENDERER_URL'] || process.env.NODE_ENV === 'development';
  const isDevMode = options.isDev ?? inferredDevMode;
  if (!isDevMode) return false;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;

  const configuredRendererUrl = options.rendererUrl ?? process.env['ELECTRON_RENDERER_URL'];
  if (configuredRendererUrl) {
    try {
      const configured = new URL(configuredRendererUrl);
      if (configured.protocol === parsed.protocol && configured.host === parsed.host) {
        return true;
      }
      return false;
    } catch {
      // Fall back to loopback-only dev allowance below.
    }
  }

  return isLoopbackHostname(parsed.hostname);
}

function assertTrustedIpc(event: IpcMainInvokeEvent): void {
  const url = event.senderFrame?.url ?? event.sender?.getURL?.() ?? '';
  if (!isTrustedIpcUrl(url)) {
    throw new Error('Untrusted IPC sender');
  }
}

export function assertMainWindowSender(event: IpcMainInvokeEvent): void {
  const resolved = mainWindowWebContentsResolver?.();
  if (
    !resolved
    || event.sender !== resolved
    || event.senderFrame !== resolved.mainFrame
  ) {
    throw new Error('IPC sender is not the main window');
  }
}

export function secureHandle(
  channel: string,
  handler: Parameters<typeof ipcMain.handle>[1],
  options?: SecureHandleOptions,
): void {
  ipcMain.handle(channel, (event, ...args) => {
    assertTrustedIpc(event);
    if (options?.mainWindowOnly !== false) assertMainWindowSender(event);
    const validatedArgs = validateIpcInvokeArgs(channel, args);
    return handler(event, ...validatedArgs);
  });
}
