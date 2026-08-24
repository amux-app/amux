export function isTerminalDebugEnabled(): boolean {
  const e2eWindow = window as typeof window & { __AUMX_E2E?: boolean };
  const isDev = (import.meta as ImportMeta & { env: { DEV: boolean } }).env.DEV;
  return e2eWindow.__AUMX_E2E === true
    || (isDev && window.location.search.includes('e2e=1'));
}
