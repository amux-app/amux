import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';
import { AGENT_IDS, type AgentName } from '../agents/agent-contract.js';
import { isPiCliIdentity } from '../agents/pi-runtime.js';
import { getEnhancedPathAsync } from './execAsync.js';

const execFileAsync = promisify(execFile);

interface AgentSpec {
  readonly name: AgentName;
  readonly binary: string;
  readonly fallbackPaths: readonly string[];
  readonly verify?: (command: string) => Promise<boolean>;
}

function home(suffix: string): string {
  return `${process.env.HOME ?? ''}${suffix}`;
}

const PI_IDENTITY_CACHE = new Map<string, boolean>();
const PI_IDENTITY_TIMEOUT_MS = 15_000;

async function verifyPiCommand(command: string): Promise<boolean> {
  const cached = PI_IDENTITY_CACHE.get(command);
  if (cached !== undefined) return cached;

  let verified = false;
  try {
    const resolvedCommand = (await fs.realpath(command)).replaceAll('\\', '/').toLowerCase();
    if (
      resolvedCommand.includes('/pi-coding-agent/')
      && /\/cli\.(?:c?js|mjs|ts)$/.test(resolvedCommand)
    ) {
      PI_IDENTITY_CACHE.set(command, true);
      return true;
    }

    const { stderr, stdout } = await execFileAsync(command, ['--help'], {
      encoding: 'utf-8',
      // Pi starts a Node runtime before printing help. Cold caches and a busy
      // desktop can push that beyond five seconds, so keep this bounded without
      // incorrectly hiding a valid installation during startup or refresh.
      timeout: PI_IDENTITY_TIMEOUT_MS,
    });
    verified = isPiCliIdentity(`${stdout}\n${stderr}`);
  } catch {
    verified = false;
  }
  PI_IDENTITY_CACHE.set(command, verified);
  return verified;
}

const AGENT_SPECS: readonly AgentSpec[] = [
  {
    name: 'claude',
    binary: 'claude',
    fallbackPaths: [
      home('/.claude/local/claude'),
      home('/.local/bin/claude'),
      '/usr/local/bin/claude',
      '/opt/homebrew/bin/claude',
      '/usr/bin/claude',
      home('/bin/claude'),
    ],
  },
  {
    name: 'codex',
    binary: 'codex',
    fallbackPaths: [
      '/usr/local/bin/codex',
      '/opt/homebrew/bin/codex',
      home('/.local/bin/codex'),
      home('/bin/codex'),
      home('/.npm-global/bin/codex'),
    ],
  },
  {
    name: 'opencode',
    binary: 'opencode',
    fallbackPaths: [
      '/opt/homebrew/bin/opencode',
      '/usr/local/bin/opencode',
      home('/.local/bin/opencode'),
      home('/.bun/bin/opencode'),
      home('/.npm-global/bin/opencode'),
      home('/bin/opencode'),
    ],
  },
  {
    name: 'pi',
    binary: 'pi',
    fallbackPaths: [
      '/opt/homebrew/bin/pi',
      '/usr/local/bin/pi',
      home('/.local/bin/pi'),
      home('/.npm-global/bin/pi'),
      home('/bin/pi'),
    ],
    verify: verifyPiCommand,
  },
];

async function fileIsExecutable(candidate: string): Promise<boolean> {
  try {
    // X_OK alone is insufficient: directories carry the search bit, so also
    // require a regular file. This matches `command -v`'s executable-only match.
    if (!(await fs.stat(candidate)).isFile()) return false;
    await fs.access(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function findOnDiskCandidates(binary: string, fallbackPaths: readonly string[]): Promise<string[]> {
  const pathDirs = (await getEnhancedPathAsync()).split(path.delimiter).filter(Boolean);
  const candidates = Array.from(new Set([
    ...pathDirs.map((dir) => path.join(dir, binary)),
    ...fallbackPaths,
  ]));
  const executableCandidates: string[] = [];
  for (const candidate of candidates) {
    if (await fileIsExecutable(candidate)) executableCandidates.push(candidate);
  }
  return executableCandidates;
}

async function findViaShellProbe(binary: string): Promise<string | null> {
  const userShell = process.env.SHELL || '/bin/bash';
  try {
    const { stdout } = await execFileAsync(
      userShell,
      ['-i', '-c', `command -v ${binary} 2>/dev/null || which ${binary} 2>/dev/null`],
      { encoding: 'utf-8', timeout: 5_000 }
    );
    const first = stdout.trim().split('\n')[0];
    return first || null;
  } catch {
    return null;
  }
}

function specFor(name: AgentName): AgentSpec {
  const spec = AGENT_SPECS.find((s) => s.name === name);
  if (!spec) throw new Error(`Unknown agent: ${name}`);
  return spec;
}

async function findAgentCommand(name: AgentName): Promise<string | null> {
  const spec = specFor(name);
  // Identity-sensitive names (notably `pi`) may collide with unrelated tools.
  // Keep walking PATH and fallbacks until one candidate verifies instead of
  // treating the first executable basename as authoritative.
  const candidates = await findOnDiskCandidates(spec.binary, spec.fallbackPaths);
  if (!spec.verify && candidates.length > 0) return candidates[0];

  // Start identity-sensitive probes together so several unrelated or stalled
  // basename collisions consume one bounded verification window, not one
  // timeout per candidate. Await them in PATH order to retain deterministic
  // executable precedence without waiting for lower-priority probes afterward.
  const verificationResults = candidates.map((candidate) => spec.verify!(candidate));
  for (let index = 0; index < candidates.length; index++) {
    if (await verificationResults[index]) return candidates[index];
  }

  // The interactive shell probe is only needed for aliases/functions that do
  // not resolve to an executable file in the enhanced PATH.
  const shellCandidate = await findViaShellProbe(spec.binary);
  if (!shellCandidate) return null;
  return !spec.verify || await spec.verify(shellCandidate) ? shellCandidate : null;
}

export function findClaudeCommand(): Promise<string | null> {
  return findAgentCommand('claude');
}

export function findOpencodeCommand(): Promise<string | null> {
  return findAgentCommand('opencode');
}

export function findCodexCommand(): Promise<string | null> {
  return findAgentCommand('codex');
}

export function findPiCommand(): Promise<string | null> {
  return findAgentCommand('pi');
}

export interface AgentDetectionOptions {
  /** Re-probe identity-sensitive binaries after an explicit user refresh. */
  refreshIdentity?: boolean;
}

export async function getAvailableAgents(options: AgentDetectionOptions = {}): Promise<AgentName[]> {
  if (options.refreshIdentity) PI_IDENTITY_CACHE.clear();
  const results = await Promise.all(
    AGENT_IDS.map(async (name) => ((await findAgentCommand(name)) !== null ? name : null)),
  );
  return results.filter((name): name is AgentName => name !== null);
}
