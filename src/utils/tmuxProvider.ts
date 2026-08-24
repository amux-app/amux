import { accessSync, constants, existsSync, realpathSync } from 'fs';
import { delimiter, join } from 'path';
import { execFileAsync, getEnhancedPathAsync, prependEnhancedPathDir } from './execAsync.js';
import { isSupportedTmuxVersion, parseTmuxVersion } from './tmuxVersion.js';

const TMUX_BINARY = 'tmux';
const BREW_BINARY = 'brew';

export type TmuxProviderStatus = 'ok' | 'missing' | 'old' | 'unparseable';

export interface TmuxProviderResult {
  status: TmuxProviderStatus;
  path?: string;
  version?: string;
  source?: 'path' | 'homebrew';
  prependedBinDir?: string;
  detected?: string;
}

type ProbeVersion = (binPath: string) => Promise<string | null>;
type ResolveBrewPrefix = (brewPath: string) => Promise<string | null>;

export interface TmuxProviderDeps {
  probeVersion: ProbeVersion;
  resolveBrewPrefix: ResolveBrewPrefix;
}

const defaultProbeVersion: ProbeVersion = async (binPath) => {
  const stdout = await execFileAsync(binPath, ['-V'], { timeout: 5_000, silent: true });
  return stdout || null;
};

const defaultResolveBrewPrefix: ResolveBrewPrefix = async (brewPath) => {
  const stdout = await execFileAsync(brewPath, ['--prefix', TMUX_BINARY], { timeout: 5_000, silent: true });
  return stdout.trim() || null;
};

function isExecutableFile(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return existsSync(path);
  } catch {
    return false;
  }
}

function findExecutableOnPath(name: string, pathValue: string): string | null {
  for (const dir of pathValue.split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    if (isExecutableFile(candidate)) return candidate;
  }
  return null;
}

function canonicalPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function classifyUnsupported(version: string | null): TmuxProviderResult {
  if (!version) return { status: 'missing' };
  if (!parseTmuxVersion(version)) return { status: 'unparseable', detected: version.trim() };
  return { status: 'old', detected: version.trim() };
}

export async function resolveTmuxProvider(
  minimum: string,
  pathValue: string,
  deps: TmuxProviderDeps = { probeVersion: defaultProbeVersion, resolveBrewPrefix: defaultResolveBrewPrefix },
): Promise<TmuxProviderResult> {
  const pathCandidate = findExecutableOnPath(TMUX_BINARY, pathValue);
  const pathVersion = pathCandidate ? await deps.probeVersion(pathCandidate) : null;
  if (pathCandidate && pathVersion && isSupportedTmuxVersion(pathVersion, minimum)) {
    return { status: 'ok', path: canonicalPath(pathCandidate), version: pathVersion.trim(), source: 'path' };
  }

  const brewProvider = await resolveViaHomebrew(minimum, pathValue, deps);
  if (brewProvider) return brewProvider;

  return classifyUnsupported(pathVersion);
}

async function resolveViaHomebrew(
  minimum: string,
  pathValue: string,
  deps: TmuxProviderDeps,
): Promise<TmuxProviderResult | null> {
  const brewPath = findExecutableOnPath(BREW_BINARY, pathValue);
  if (!brewPath) return null;

  const prefix = await deps.resolveBrewPrefix(brewPath);
  if (!prefix) return null;

  const binDir = join(prefix, 'bin');
  const brewTmux = join(binDir, TMUX_BINARY);
  if (!isExecutableFile(brewTmux)) return null;

  const version = await deps.probeVersion(brewTmux);
  if (!version || !isSupportedTmuxVersion(version, minimum)) return null;

  return {
    status: 'ok',
    path: canonicalPath(brewTmux),
    version: version.trim(),
    source: 'homebrew',
    prependedBinDir: binDir,
  };
}

export async function selectAndFreezeTmuxProvider(minimum: string): Promise<TmuxProviderResult> {
  const enhancedPath = await getEnhancedPathAsync();
  const result = await resolveTmuxProvider(minimum, enhancedPath);
  if (result.status === 'ok' && result.prependedBinDir
    && !enhancedPath.split(delimiter).includes(result.prependedBinDir)) {
    process.env.PATH = `${result.prependedBinDir}${delimiter}${process.env.PATH ?? enhancedPath}`;
    prependEnhancedPathDir(result.prependedBinDir);
  }
  return result;
}
