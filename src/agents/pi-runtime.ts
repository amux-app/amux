import { open, readFile, readdir, stat, type FileHandle } from 'fs/promises';
import { homedir } from 'os';
import path from 'path';
import { shQuote } from '../utils/shellEscape.js';

const ANSI_CSI_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const PI_SESSION_HEADER_BYTES = 64 * 1024;
const PI_SETTINGS_MAX_BYTES = 1024 * 1024;

export interface PiSessionDirectory {
  path: string;
  shared: boolean;
}

export interface PiLaunchTuning {
  model?: string;
  effort?: string;
}

export function buildPiFlags(tuning: PiLaunchTuning): string {
  const flags = [
    tuning.model ? `--model ${shQuote(tuning.model)}` : '',
    tuning.effort ? `--thinking ${shQuote(tuning.effort)}` : '',
  ].filter(Boolean);
  return flags.length > 0 ? ` ${flags.join(' ')}` : '';
}

export function buildPiResumeCommand(
  sessionId?: string,
  mode: 'fork' | 'resume' = 'resume',
  executable: string = 'pi',
): string {
  const command = executable === 'pi' ? executable : shQuote(executable);
  if (!sessionId) return `${command} --continue`;
  return `${command} --${mode === 'fork' ? 'fork' : 'session'} ${shQuote(sessionId)}`;
}

export function resolvePiDefaultSessionDirectory(projectRoot: string, sessionsRoot: string): string {
  const resolved = path.resolve(projectRoot);
  const encoded = `--${resolved.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`;
  return path.join(sessionsRoot, encoded);
}

function expandTilde(value: string): string {
  if (value === '~') return homedir();
  return value.startsWith('~/') ? path.join(homedir(), value.slice(2)) : value;
}

function resolveConfiguredPath(value: string, projectRoot: string): string {
  const expanded = expandTilde(value.trim());
  return path.isAbsolute(expanded) ? path.resolve(expanded) : path.resolve(projectRoot, expanded);
}

function resolvePiAgentDirectory(projectRoot: string): string {
  const configured = process.env.PI_CODING_AGENT_DIR?.trim();
  return configured
    ? resolveConfiguredPath(configured, projectRoot)
    : path.join(homedir(), '.pi', 'agent');
}

async function readConfiguredSessionDirectory(settingsPath: string, projectRoot: string): Promise<string | null> {
  try {
    const fileStat = await stat(settingsPath);
    if (!fileStat.isFile() || fileStat.size > PI_SETTINGS_MAX_BYTES) return null;
    const parsed = JSON.parse(await readFile(settingsPath, 'utf8')) as Record<string, unknown>;
    return typeof parsed.sessionDir === 'string' && parsed.sessionDir.trim()
      ? resolveConfiguredPath(parsed.sessionDir, projectRoot)
      : null;
  } catch {
    return null;
  }
}

export function resolvePiSessionDirectorySync(projectRoot: string): PiSessionDirectory {
  const resolvedProjectRoot = path.resolve(projectRoot);
  const environmentOverride = process.env.PI_CODING_AGENT_SESSION_DIR?.trim();
  if (environmentOverride) {
    return { path: resolveConfiguredPath(environmentOverride, resolvedProjectRoot), shared: true };
  }
  const agentDir = resolvePiAgentDirectory(resolvedProjectRoot);
  return {
    path: resolvePiDefaultSessionDirectory(resolvedProjectRoot, path.join(agentDir, 'sessions')),
    shared: false,
  };
}

export async function resolvePiSessionDirectoryForProject(projectRoot: string): Promise<PiSessionDirectory> {
  const resolvedProjectRoot = path.resolve(projectRoot);
  const sync = resolvePiSessionDirectorySync(resolvedProjectRoot);
  if (sync.shared) return sync;

  const agentDir = resolvePiAgentDirectory(resolvedProjectRoot);
  const projectOverride = await readConfiguredSessionDirectory(
    path.join(resolvedProjectRoot, '.pi', 'settings.json'),
    resolvedProjectRoot,
  );
  if (projectOverride) return { path: projectOverride, shared: true };

  const globalOverride = await readConfiguredSessionDirectory(
    path.join(agentDir, 'settings.json'),
    resolvedProjectRoot,
  );
  if (globalOverride) return { path: globalOverride, shared: true };

  return sync;
}

async function readPiSessionHeader(filePath: string): Promise<{ cwd: string; id: string } | null> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(filePath, 'r');
    const buffer = Buffer.alloc(PI_SESSION_HEADER_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    for (const line of buffer.subarray(0, bytesRead).toString('utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as Record<string, unknown>;
        if (entry.type !== 'session') continue;
        return typeof entry.cwd === 'string' && typeof entry.id === 'string'
          ? { cwd: entry.cwd, id: entry.id }
          : null;
      } catch {
        continue;
      }
    }
    return null;
  } catch {
    return null;
  } finally {
    await handle?.close();
  }
}

/** Resolve a UI-selected Pi session ID to its trusted source file before changing cwd. */
export async function findPiSessionFile(projectRoot: string, sessionId: string): Promise<string | null> {
  const resolvedProjectRoot = path.resolve(projectRoot);
  const { path: sessionDirectory } = await resolvePiSessionDirectoryForProject(resolvedProjectRoot);
  let names: string[];
  try {
    names = (await readdir(sessionDirectory)).filter((name) => name.endsWith('.jsonl'));
  } catch {
    return null;
  }

  for (const name of names) {
    const filePath = path.join(sessionDirectory, name);
    const header = await readPiSessionHeader(filePath);
    if (header?.id === sessionId && path.resolve(header.cwd) === resolvedProjectRoot) return filePath;
  }
  return null;
}

export function isPiCliIdentity(helpOutput: string): boolean {
  const normalized = helpOutput.replace(ANSI_CSI_PATTERN, '').toLowerCase();
  return normalized.includes('pi - ai coding assistant')
    && normalized.includes('usage:')
    && normalized.includes('read')
    && normalized.includes('bash')
    && normalized.includes('edit')
    && normalized.includes('write');
}

function executableBasename(token: string): string {
  const normalized = token.trim().replace(/^['"]|['"]$/g, '').toLowerCase();
  const parts = normalized.split('/');
  return parts[parts.length - 1] ?? normalized;
}

function tokenizeCommand(command: string): string[] {
  return command.trim().split(/\s+/).filter(Boolean);
}

export function isPiProcessCommand(command: string): boolean {
  const tokens = tokenizeCommand(command);
  if (tokens.length === 0) return false;

  const executable = executableBasename(tokens[0]);
  if (executable === 'pi') return true;
  if (executable === 'env' && tokens[1] && executableBasename(tokens[1]) === 'pi') return true;

  if (executable === 'node' || executable === 'bun') {
    // Homebrew/npm shims preserve the unresolved `pi` symlink as the runtime's
    // entrypoint (for example, `node /opt/homebrew/bin/pi`).
    if (tokens[1] && executableBasename(tokens[1]) === 'pi') return true;
    return tokens.slice(1).some((token) => {
      const normalized = token.replace(/^['"]|['"]$/g, '').toLowerCase();
      return normalized.includes('/pi-coding-agent/') && /\/cli\.(?:c?js|mjs|ts)$/.test(normalized);
    });
  }

  return false;
}
