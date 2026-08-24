import { createHash } from 'crypto';

const DEFAULT_PORTS: Record<string, string> = {
  'http:': '80',
  'https:': '443',
  'git:': '9418',
  'ssh:': '22',
};

const PREFIX_MAX_LENGTH = 40;

function sanitizeSegment(segment: string): string {
  return segment.replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase();
}

export function canonicalizeSourceUrl(url: string): string {
  const parsed = new URL(url);
  const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
  const port = parsed.port && parsed.port !== DEFAULT_PORTS[parsed.protocol] ? `:${parsed.port}` : '';
  const path = parsed.pathname.replace(/\.git$/, '').replace(/\/$/, '');
  return `${parsed.protocol}//${host}${port}${path}`;
}

export function deriveCloneDirName(url: string): string {
  const canonical = canonicalizeSourceUrl(url);
  const parsed = new URL(canonical);
  const lastSegment = parsed.pathname.split('/').filter(Boolean).pop() ?? '';
  const prefix = [parsed.hostname, lastSegment]
    .filter(Boolean)
    .map(sanitizeSegment)
    .join('-')
    .slice(0, PREFIX_MAX_LENGTH);
  const hash = createHash('sha256').update(canonical).digest('hex').slice(0, 12);
  return `${prefix}-${hash}`;
}
