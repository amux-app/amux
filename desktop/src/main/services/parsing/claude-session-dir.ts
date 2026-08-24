import { existsSync } from 'fs';
import { homedir } from 'os';
import { basename, join } from 'path';
import { JSONL_EXTENSION, listDirectoryEntries, statFile } from './session-files.js';

export function claudeProjectsDir(): string {
  return join(homedir(), '.claude', 'projects');
}

/**
 * Claude Code encodes a project root into a directory name, and has used more than
 * one encoding, so every candidate is tried before falling back to the newest
 * directory whose name still looks like this project. The result is where session
 * files are expected, whether or not it exists yet.
 */
export function resolveClaudeProjectDir(projectRoot: string): string {
  const projectsDir = claudeProjectsDir();
  const candidateRoots = buildProjectRootCandidates(projectRoot);

  let firstExisting: string | null = null;
  for (const candidateRoot of candidateRoots) {
    const candidateDir = join(projectsDir, candidateRoot);
    if (!existsSync(candidateDir)) continue;
    if (!firstExisting) firstExisting = candidateDir;
    if (dirHasJsonlFiles(candidateDir)) return candidateDir;
  }

  const fuzzy = findNewestSimilarDir(projectsDir, basename(projectRoot));
  if (fuzzy) return fuzzy;
  return firstExisting ?? join(projectsDir, candidateRoots[candidateRoots.length - 1]);
}

function buildProjectRootCandidates(projectRoot: string): string[] {
  const trimmedRoot = projectRoot.replace(/\/+$/, '');
  const standard = trimmedRoot.replace(/[^a-zA-Z0-9]/g, '-');
  const strict = trimmedRoot.replace(/[/.]/g, '-');
  const broad = standard.replace(/-+/g, '-');
  return Array.from(new Set([standard, strict, broad]));
}

function findNewestSimilarDir(projectsDir: string, projectName: string): string | null {
  const normalizedName = normalizeLookupKey(projectName);
  const match = listDirectoryEntries(projectsDir)
    .filter((dir) => dir.includes(projectName) || normalizeLookupKey(dir).includes(normalizedName))
    .map((dir) => ({ dir, mtime: readPathMtime(join(projectsDir, dir)) }))
    .sort((a, b) => b.mtime - a.mtime)[0]?.dir;
  return match ? join(projectsDir, match) : null;
}

function normalizeLookupKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function dirHasJsonlFiles(dir: string): boolean {
  return listDirectoryEntries(dir).some((file) => file.endsWith(JSONL_EXTENSION));
}

function readPathMtime(path: string): number {
  return statFile(path)?.mtimeMs ?? 0;
}
