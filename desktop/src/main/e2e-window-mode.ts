type Environment = Readonly<Record<string, string | undefined>>;

/**
 * Keep automated Electron runs off-screen unless a developer explicitly asks
 * to watch them. The renderer still paints normally, so Playwright screenshots
 * and DOM-based assertions work in either mode.
 */
export function isHeadlessE2E(environment: Environment): boolean {
  return environment.NODE_ENV === 'test'
    && environment.AUMX_E2E === '1'
    && environment.AUMX_E2E_HEADED !== '1';
}

/**
 * Accessory apps do not claim the macOS Dock or menu bar at launch. Keeping
 * this decision test-only lets Playwright drive real BrowserWindows without
 * switching Spaces or replacing the user's frontmost application.
 */
export function resolveE2EActivationPolicy(
  environment: Environment,
  platform: string,
): 'accessory' | undefined {
  return platform === 'darwin' && isHeadlessE2E(environment) ? 'accessory' : undefined;
}

/** Persisted window settings must not make an automated headless run visible. */
export function resolveWindowOpacity(environment: Environment, configuredOpacity: number): number {
  return isHeadlessE2E(environment) ? 0 : configuredOpacity;
}
