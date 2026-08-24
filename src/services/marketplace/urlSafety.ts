import { lookup } from 'dns/promises';
import { isIP } from 'net';

const DOTTED_QUAD = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const NUMERIC_HOST = /^(0x[0-9a-f]+|\d+)(\.(0x[0-9a-f]+|\d+))*$/;
const BLOCKED_HOST_MESSAGE = 'That host is not allowed';

function isPrivateIpv4(ip: string): boolean {
  const match = ip.match(DOTTED_QUAD);
  if (!match) return false;
  const [a, b, c, d] = match.slice(1, 5).map(Number);
  if ([a, b, c, d].some((n) => n > 255)) return false;
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

// A trailing dotted-quad (mapped/NAT64 text form, e.g. ::ffff:127.0.0.1) becomes two hextets.
function dottedQuadToHextets(ip: string): string {
  const match = ip.match(/(?:^|:)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (!match) return ip;
  const [a, b, c, d] = match[1].split('.').map(Number);
  const hextets = `${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  return `${ip.slice(0, ip.length - match[1].length)}${hextets}`;
}

// Expand an IPv6 literal to its 8 hextets, resolving a single "::" compression.
function expandIpv6(raw: string): number[] | null {
  const ip = dottedQuadToHextets(raw);
  const [head, tail, extra] = ip.split('::');
  if (extra !== undefined) return null;
  const parse = (part: string): number[] =>
    part ? part.split(':').map((h) => parseInt(h, 16)) : [];
  const left = parse(head);
  const right = tail === undefined ? [] : parse(tail);
  const groups = tail === undefined ? left : [...left, ...new Array(8 - left.length - right.length).fill(0), ...right];
  if (groups.length !== 8 || groups.some((g) => Number.isNaN(g) || g < 0 || g > 0xffff)) return null;
  return groups;
}

// Reconstruct an IPv4 embedded in two hextets (used for mapped/NAT64/6to4 forms).
function hextetsToIpv4(high: number, low: number): string {
  return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
}

function isNat64Prefix(groups: number[]): boolean {
  if (groups[0] !== 0x64 || groups[1] !== 0xff9b) return false;
  const wellKnown = groups.slice(2, 6).every((g) => g === 0);
  const localUse = groups[2] === 1 && groups[3] === 0 && groups[4] === 0 && groups[5] === 0;
  return wellKnown || localUse;
}

function isPrivateIpv6(ip: string): boolean {
  const groups = expandIpv6(ip.toLowerCase());
  if (!groups) return false;
  if (groups.every((g) => g === 0)) return true; // ::
  if (groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1) return true; // ::1
  const first = groups[0];
  if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 ULA
  if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  // ::ffff:<v4> IPv4-mapped and ::<v4> IPv4-compatible
  if (groups.slice(0, 5).every((g) => g === 0) && (groups[5] === 0xffff || groups[5] === 0)) {
    return isPrivateIpv4(hextetsToIpv4(groups[6], groups[7]));
  }
  // 2002::/16 6to4 embeds the v4 in hextets 2-3; block only 6to4 of a private v4.
  if (first === 0x2002) {
    return isPrivateIpv4(hextetsToIpv4(groups[1], groups[2]));
  }
  // NAT64: 64:ff9b::/96 well-known + 64:ff9b:1::/48 local-use, both embed the v4 in the last two hextets.
  if (isNat64Prefix(groups)) {
    return isPrivateIpv4(hextetsToIpv4(groups[6], groups[7]));
  }
  return false;
}

export function isPrivateIp(ip: string): boolean {
  const version = isIP(ip);
  if (version === 4) return isPrivateIpv4(ip);
  if (version === 6) return isPrivateIpv6(ip);
  return false;
}

function stripTrailingDot(hostname: string): string {
  return hostname.endsWith('.') ? hostname.slice(0, -1) : hostname;
}

export function isBlockedHost(hostname: string): boolean {
  const host = stripTrailingDot(hostname.replace(/^\[|\]$/g, '').toLowerCase());
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host.includes(':')) return isPrivateIp(host);
  if (DOTTED_QUAD.test(host)) return isPrivateIp(host);
  if (NUMERIC_HOST.test(host)) return true;
  return false;
}

export function validateSourceUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'Invalid URL';
  }
  if (parsed.protocol !== 'https:') {
    return 'Only https:// URLs are supported';
  }
  if (isBlockedHost(parsed.hostname)) {
    return BLOCKED_HOST_MESSAGE;
  }
  return null;
}

// Authoritative pre-clone guard: runs the synchronous string checks as a fast pre-filter,
// then resolves the hostname and rejects if ANY resolved address is private/reserved. This
// closes the DNS-rebinding SSRF where a public hostname's A-record points at an internal IP.
// Residual TOCTOU: git re-resolves DNS after this lookup, so a rebinding attacker who flips the
// record between our lookup and git's fetch is not fully blocked — closing that fully would
// require pinning the resolved IP into the git connection, which git does not support cleanly.
export async function assertSafeCloneTarget(url: string): Promise<void> {
  const stringError = validateSourceUrl(url);
  if (stringError) throw new Error(stringError);

  const hostname = stripTrailingDot(new URL(url).hostname.replace(/^\[|\]$/g, ''));
  if (isIP(hostname)) return; // literal IP already validated by isBlockedHost above

  const resolved = await lookup(hostname, { all: true });
  if (resolved.some((entry) => isPrivateIp(entry.address))) {
    throw new Error(BLOCKED_HOST_MESSAGE);
  }
}
