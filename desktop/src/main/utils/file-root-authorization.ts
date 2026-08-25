import { realpathSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import type { MuxBasePane } from 'muxbase/core';

type FileRootPane = Pick<MuxBasePane, 'projectRoot' | 'worktreePath'>;

export function resolveAuthorizedFileRoot(
  projectRoot: string,
  panes: readonly FileRootPane[],
  requestedRootPath: string,
): string {
  const requestedRoot = normalizeRootPath(requestedRootPath);

  if (isAuthorizedRoot(projectRoot, requestedRoot)) {
    return requestedRoot;
  }

  for (const pane of panes) {
    if (isAuthorizedRoot(pane.projectRoot, requestedRoot) || isAuthorizedRoot(pane.worktreePath, requestedRoot)) {
      return requestedRoot;
    }
  }

  throw new Error('Unauthorized file root');
}

export function validateFilePath(rootPath: string, relativePath: string): string {
  const root = normalizeRootPath(rootPath);
  const target = resolve(root, relativePath);

  assertWithinRoot(root, target);
  assertCanonicalWithinRoot(root, target);

  return target;
}

export function isPathWithinRoot(rootPath: string, targetPath: string): boolean {
  return isWithinRoot(normalizeRootPath(rootPath), normalizeRootPath(targetPath));
}

function isWithinRoot(root: string, target: string): boolean {
  const rootPrefix = root.endsWith(sep) ? root : root + sep;
  return target === root || target.startsWith(rootPrefix);
}

function assertWithinRoot(root: string, target: string): void {
  if (!isWithinRoot(root, target)) {
    throw new Error('Path traversal blocked');
  }
}

function assertCanonicalWithinRoot(root: string, target: string): void {
  const canonical = canonicalizeWalkingUp(target);
  if (canonical === null) {
    return;
  }
  assertWithinRoot(root, canonical);
}

function canonicalizeWalkingUp(target: string): string | null {
  let current = target;
  const trailingSegments: string[] = [];

  while (true) {
    try {
      const canonicalCurrent = realpathSync.native(current);
      return trailingSegments.length === 0
        ? canonicalCurrent
        : resolve(canonicalCurrent, ...trailingSegments.reverse());
    } catch {
      const parent = dirname(current);
      if (parent === current) {
        return null;
      }
      trailingSegments.push(relative(parent, current));
      current = parent;
    }
  }
}

function isAuthorizedRoot(rootPath: string | undefined, requestedRoot: string): boolean {
  return rootPath !== undefined && rootPath !== '' && normalizeRootPath(rootPath) === requestedRoot;
}

export function normalizeRootPath(rootPath: string): string {
  const resolved = resolve(rootPath);
  try {
    return realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}
