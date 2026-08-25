import { stat } from 'fs/promises';
import { findClaudeCommand } from './agentDetection.js';
import { execFileAsync } from './execAsync.js';

export type ClaudeVersion = readonly [major: number, minor: number, patch: number];

export const CLAUDE_FULLSCREEN_MINIMUM_VERSION: ClaudeVersion = [2, 1, 220];

export interface ClaudeVersionPreflightResult {
  command: string;
  version: ClaudeVersion;
}

export class ClaudeFullscreenVersionError extends Error {
  constructor(message: string) {
    super(`${message} Update Claude or Use classic compatibility mode.`);
    this.name = 'ClaudeFullscreenVersionError';
  }
}

interface ClaudeVersionPreflightDependencies {
  execVersion: (command: string) => Promise<string>;
  findCommand: () => Promise<string | null>;
  getMtimeMs: (command: string) => Promise<number>;
}

const VERSION_PATTERN = /(?:^|[^\d.])(\d+)\.(\d+)\.(\d+)(?![\d.])/;

export function parseClaudeVersion(output: string): ClaudeVersion | null {
  const match = VERSION_PATTERN.exec(output.trim());
  if (!match) return null;

  const version: ClaudeVersion = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (version.some((part) => !Number.isSafeInteger(part))) return null;
  return version;
}

export function compareClaudeVersions(left: ClaudeVersion, right: ClaudeVersion): number {
  for (let index = 0; index < left.length; index += 1) {
    const difference = left[index] - right[index];
    if (difference !== 0) return difference;
  }
  return 0;
}

function formatVersion(version: ClaudeVersion): string {
  return version.join('.');
}

export function createClaudeVersionPreflight(
  dependencies: ClaudeVersionPreflightDependencies,
): () => Promise<ClaudeVersionPreflightResult> {
  const cache = new Map<string, Promise<ClaudeVersionPreflightResult>>();

  return async () => {
    const command = await dependencies.findCommand();
    if (!command) {
      throw new ClaudeFullscreenVersionError('Claude Code was not found.');
    }

    let mtimeMs: number;
    try {
      mtimeMs = await dependencies.getMtimeMs(command);
    } catch {
      throw new ClaudeFullscreenVersionError(`Claude Code at ${command} could not be inspected.`);
    }

    const cacheKey = `${command}:${mtimeMs}`;
    const cached = cache.get(cacheKey);
    if (cached) return cached;

    const result = (async (): Promise<ClaudeVersionPreflightResult> => {
      let output: string;
      try {
        output = await dependencies.execVersion(command);
      } catch {
        throw new ClaudeFullscreenVersionError(`Claude Code at ${command} did not report its version.`);
      }

      const version = parseClaudeVersion(output);
      if (!version) {
        throw new ClaudeFullscreenVersionError(`Claude Code returned an unrecognized version: ${output || '(empty output)'}.`);
      }
      if (compareClaudeVersions(version, CLAUDE_FULLSCREEN_MINIMUM_VERSION) < 0) {
        throw new ClaudeFullscreenVersionError(
          `Claude Code ${formatVersion(version)} is unsupported for fullscreen rendering; MuxBase requires ${formatVersion(CLAUDE_FULLSCREEN_MINIMUM_VERSION)} or newer.`,
        );
      }

      return { command, version };
    })();
    cache.set(cacheKey, result);
    try {
      return await result;
    } catch (error) {
      cache.delete(cacheKey);
      throw error;
    }
  };
}

export const assertClaudeFullscreenSupported = createClaudeVersionPreflight({
  execVersion: (command) => execFileAsync(command, ['--version'], { timeout: 5_000 }),
  findCommand: findClaudeCommand,
  getMtimeMs: async (command) => (await stat(command)).mtimeMs,
});
