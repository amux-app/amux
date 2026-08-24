const REDACTED_PREFIX = '<REDACTED:';
const PRIVATE_KEY_KIND = 'private-key';
const SECRET_ASSIGNMENT_KIND = 'secret-assignment';
const URL_CREDENTIALS_KIND = 'url-credentials';
const AWS_SECRET_KIND = 'aws-secret-access-key';
const CREDENTIAL_SCHEMES = 'https?|postgres|postgresql|mysql|redis|mongodb(?:\\+srv)?|amqp|git\\+ssh|ssh';
const SECRET_KEY_NAMES =
  'password|passwd|pwd|passphrase|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|' +
  'db[_-]?pass(?:word)?|auth|authorization|bearer|credentials?|x[_-]?api[_-]?key|x[_-]?api[_-]?token|' +
  'access[_-]?token|refresh[_-]?token|session|cookie|connection[_-]?string';
const NON_SECRET_VALUE = /^(?:true|false|yes|no|on|off|null|none|bearer|basic|digest|\d+)$/i;
const REDACTION_PLACEHOLDER = /^<REDACTED:/;

const ANSI_ESCAPE_PATTERN = /\x1b[[\]()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-PR-TZcf-nqry=><]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const CONTROL_CHAR_PATTERN = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

interface SecretRule {
  kind: string;
  pattern: RegExp;
  replace?: (match: string, ...groups: string[]) => string;
}

const SECRET_RULES: SecretRule[] = [
  { kind: PRIVATE_KEY_KIND, pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g },
  { kind: PRIVATE_KEY_KIND, pattern: /---- BEGIN SSH2(?: [A-Z0-9]+)* PRIVATE KEY ----[\s\S]*?---- END SSH2(?: [A-Z0-9]+)* PRIVATE KEY ----/g },
  { kind: PRIVATE_KEY_KIND, pattern: /PuTTY-User-Key-File-[23]:[\s\S]*?Private-MAC:[ \t]*\S+/g },
  { kind: 'jwt', pattern: /eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g },
  { kind: 'anthropic-key', pattern: /sk-ant-[A-Za-z0-9_-]{20,}/g },
  { kind: 'openai-key', pattern: /sk-(?:proj-)?[A-Za-z0-9_-]{16,}/g },
  { kind: 'github-token', pattern: /gh[pousr]_[A-Za-z0-9]{20,}/g },
  { kind: 'gitlab-token', pattern: /glpat-[A-Za-z0-9_-]{20,}/g },
  { kind: 'aws-access-key-id', pattern: /AKIA[0-9A-Z]{16}/g },
  { kind: 'google-api-key', pattern: /AIza[0-9A-Za-z_-]{35}/g },
  { kind: 'stripe-key', pattern: /(?:sk|rk)_(?:live|test)_[0-9A-Za-z]{16,}/g },
  { kind: 'huggingface-token', pattern: /hf_[0-9A-Za-z]{34}/g },
  { kind: 'xai-key', pattern: /xai-[0-9A-Za-z]{20,}/g },
  { kind: 'npm-token', pattern: /npm_[0-9A-Za-z]{36}/g },
  { kind: 'slack-token', pattern: /xox[baprs]-[A-Za-z0-9-]{10,}/g },
  {
    kind: 'authorization-bearer',
    pattern: /(Authorization:\s*Bearer\s+)\S+/gi,
    replace: (_match, prefix) => `${prefix}${redacted('authorization-bearer')}`,
  },
  { kind: 'bearer-token', pattern: /Bearer\s+[A-Za-z0-9._~+/-]{8,}=*/g },
  {
    kind: AWS_SECRET_KIND,
    pattern: /(aws_secret_access_key\s*[:=]\s*)(["']?)([A-Za-z0-9/+]{40})\2/gi,
    replace: (_match, prefix, quote) => `${prefix}${quote}${redacted(AWS_SECRET_KIND)}${quote}`,
  },
  { kind: AWS_SECRET_KIND, pattern: /(?<![A-Za-z0-9/+])(?=[A-Za-z0-9]*[/+])[A-Za-z0-9/+]{40}(?![A-Za-z0-9/+])/g },
  {
    kind: SECRET_ASSIGNMENT_KIND,
    pattern: new RegExp(`((?:${SECRET_KEY_NAMES})\\s*[:=]\\s*)(["']?)([^\\s"']{6,})\\2`, 'gi'),
    replace: replaceSecretAssignment,
  },
  {
    kind: URL_CREDENTIALS_KIND,
    pattern: new RegExp(`((?:${CREDENTIAL_SCHEMES}):\\/\\/)[^/\\s:@]+:[^/\\s:@]+@`, 'gi'),
    replace: (_match, scheme) => `${scheme}${redacted(URL_CREDENTIALS_KIND)}@`,
  },
];

function redacted(kind: string): string {
  return `${REDACTED_PREFIX}${kind}>`;
}

function replaceSecretAssignment(match: string, prefix: string, quote: string, value: string): string {
  if (NON_SECRET_VALUE.test(value) || REDACTION_PLACEHOLDER.test(value)) return match;
  return `${prefix}${quote}${redacted(SECRET_ASSIGNMENT_KIND)}${quote}`;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function stripAnsi(text: string): string {
  return text.replace(ANSI_ESCAPE_PATTERN, '').replace(CONTROL_CHAR_PATTERN, '');
}

export function buildPathTokenizer(opts: {
  homeDir: string;
  projectRoot: string;
  worktrees: Array<{ slug: string; path: string }>;
}): (text: string) => string {
  const replacements = buildPathReplacements(opts);
  if (replacements.length === 0) return (text) => text;

  return (text) => {
    let output = text;
    for (const { pattern, token } of replacements) {
      output = output.replace(pattern, token);
    }
    return output;
  };
}

function isTokenizablePath(path: string): boolean {
  return path.length >= 2 && path !== '/';
}

function buildPathReplacements(opts: {
  homeDir: string;
  projectRoot: string;
  worktrees: Array<{ slug: string; path: string }>;
}): Array<{ pattern: RegExp; token: string }> {
  const candidates: Array<{ path: string; token: string }> = [];
  for (const worktree of opts.worktrees) {
    if (isTokenizablePath(worktree.path)) candidates.push({ path: worktree.path, token: `<WORKTREE:${worktree.slug}>` });
  }
  if (isTokenizablePath(opts.projectRoot)) candidates.push({ path: opts.projectRoot, token: '<PROJECT>' });
  if (isTokenizablePath(opts.homeDir)) candidates.push({ path: opts.homeDir, token: '<HOME>' });

  return candidates
    .sort((left, right) => right.path.length - left.path.length)
    .map((candidate) => ({
      pattern: buildPathPattern(candidate.path),
      token: candidate.token,
    }));
}

function buildPathPattern(path: string): RegExp {
  const escaped = escapeRegExp(path);
  const jsonEscaped = escapeRegExp(jsonEscapePath(path));
  const boundary = '(?=[/\\\\\\s"\':]|$)';
  return new RegExp(`(?:${escaped}|${jsonEscaped})${boundary}`, 'g');
}

function jsonEscapePath(path: string): string {
  return path.replace(/\\/g, '\\\\');
}

export function redactSecrets(text: string): { text: string; hits: Record<string, number> } {
  const hits: Record<string, number> = {};
  let output = text;

  for (const rule of SECRET_RULES) {
    output = output.replace(rule.pattern, (...args) => {
      const groups = args.slice(0, -2) as string[];
      const replacement = rule.replace ? rule.replace(groups[0], ...groups.slice(1)) : redacted(rule.kind);
      if (replacement !== groups[0]) hits[rule.kind] = (hits[rule.kind] ?? 0) + 1;
      return replacement;
    });
  }

  return { text: output, hits };
}

export function mergeHits(target: Record<string, number>, source: Record<string, number>): void {
  for (const [kind, count] of Object.entries(source)) {
    target[kind] = (target[kind] ?? 0) + count;
  }
}
