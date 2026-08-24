const LOOPBACK_HOSTNAME = /^(localhost|\[::1\]|::1|127(?:\.\d{1,3}){3})$/;

function isLoopbackHostname(hostname: string): boolean {
  return LOOPBACK_HOSTNAME.test(hostname);
}

export function isSafeExternalUrl(value: string): boolean {
  try {
    const { protocol, hostname } = new URL(value);
    if (protocol === 'https:') return true;
    if (protocol === 'http:') return isLoopbackHostname(hostname);
    return false;
  } catch {
    return false;
  }
}
