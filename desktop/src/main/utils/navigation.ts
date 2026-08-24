import { isTrustedIpcUrl } from '../ipc/ipc-security.js';

interface NavigationTrustOptions {
  isDev?: boolean;
  rendererUrl?: string | undefined;
}

function isConfiguredRendererUrl(url: string, rendererUrl: string): boolean {
  try {
    const parsed = new URL(url);
    const renderer = new URL(rendererUrl);
    if (renderer.protocol === 'file:' || renderer.protocol === 'app:') {
      return parsed.protocol === renderer.protocol
        && parsed.host === renderer.host
        && parsed.pathname === renderer.pathname;
    }
    return parsed.protocol === renderer.protocol && parsed.host === renderer.host;
  } catch {
    return false;
  }
}

export function isAllowedAppNavigationUrl(
  url: string,
  options: NavigationTrustOptions = {},
): boolean {
  if (options.rendererUrl) {
    return isConfiguredRendererUrl(url, options.rendererUrl);
  }
  return isTrustedIpcUrl(url, options);
}
