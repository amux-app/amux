import { createHash } from 'crypto';
import {
  copyFileSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  readdirSync,
  rmSync,
} from 'fs';
import path from 'path';

export interface NativeMarketplaceTreeEntry {
  contentHash?: string;
  entryType: 'directory' | 'file';
  relativePath: string;
}

interface NativeMarketplaceTreeVisitor {
  onDirectory: (relativePath: string) => void;
  onFile: (sourcePath: string, relativePath: string) => void;
}

function isPathWithin(rootPath: string, candidatePath: string): boolean {
  const relativePath = path.relative(rootPath, candidatePath);
  return relativePath === ''
    || (!relativePath.startsWith(`..${path.sep}`) && relativePath !== '..' && !path.isAbsolute(relativePath));
}

function walkNativeMarketplaceTree(
  sourcePath: string,
  relativePath: string,
  containmentRoot: string,
  activeDirectories: Set<string>,
  visitor: NativeMarketplaceTreeVisitor,
  symlinkPath?: string,
): void {
  const sourceStat = lstatSync(sourcePath);
  if (sourceStat.isSymbolicLink()) {
    const linkTarget = readlinkSync(sourcePath);
    if (path.isAbsolute(linkTarget)) {
      throw new Error(`Marketplace artifact has an absolute symlink target: ${sourcePath}`);
    }

    let resolvedPath: string;
    try {
      resolvedPath = realpathSync(sourcePath);
    } catch {
      throw new Error(`Marketplace artifact has a broken or cyclic symlink: ${sourcePath}`);
    }
    if (!isPathWithin(containmentRoot, resolvedPath)) {
      throw new Error(`Marketplace artifact symlink escapes source tree: ${sourcePath}`);
    }
    walkNativeMarketplaceTree(
      resolvedPath,
      relativePath,
      containmentRoot,
      activeDirectories,
      visitor,
      sourcePath,
    );
    return;
  }

  if (sourceStat.isFile()) {
    visitor.onFile(sourcePath, relativePath);
    return;
  }
  if (!sourceStat.isDirectory()) {
    throw new Error(`Unsupported marketplace artifact type: ${sourcePath}`);
  }

  const canonicalDirectory = realpathSync(sourcePath);
  if (activeDirectories.has(canonicalDirectory)) {
    throw new Error(`Marketplace artifact contains a symlink cycle: ${symlinkPath ?? sourcePath}`);
  }

  activeDirectories.add(canonicalDirectory);
  try {
    visitor.onDirectory(relativePath);
    for (const entryName of readdirSync(sourcePath).sort((left, right) => left.localeCompare(right))) {
      walkNativeMarketplaceTree(
        path.join(sourcePath, entryName),
        relativePath === '.' ? entryName : path.join(relativePath, entryName),
        containmentRoot,
        activeDirectories,
        visitor,
      );
    }
  } finally {
    activeDirectories.delete(canonicalDirectory);
  }
}

function visitNativeMarketplaceTree(
  sourcePath: string,
  containmentRoot: string,
  visitor: NativeMarketplaceTreeVisitor,
): void {
  const canonicalContainmentRoot = realpathSync(containmentRoot);
  const canonicalSourcePath = realpathSync(sourcePath);
  if (!isPathWithin(canonicalContainmentRoot, canonicalSourcePath)) {
    throw new Error(`Marketplace artifact source is outside the native clone: ${sourcePath}`);
  }
  walkNativeMarketplaceTree(sourcePath, '.', canonicalContainmentRoot, new Set(), visitor);
}

export function collectNativeMarketplaceTreeEntries(
  sourcePath: string,
  containmentRoot: string,
): NativeMarketplaceTreeEntry[] {
  const entries: NativeMarketplaceTreeEntry[] = [];
  visitNativeMarketplaceTree(sourcePath, containmentRoot, {
    onDirectory: (relativePath) => entries.push({ entryType: 'directory', relativePath }),
    onFile: (filePath, relativePath) => entries.push({
      contentHash: createHash('sha256').update(readFileSync(filePath)).digest('hex'),
      entryType: 'file',
      relativePath,
    }),
  });
  return entries;
}

export function materializeNativeMarketplaceTree(
  sourcePath: string,
  destinationPath: string,
  containmentRoot: string,
): void {
  mkdirSync(path.dirname(destinationPath), { recursive: true });
  mkdirSync(destinationPath);
  try {
    visitNativeMarketplaceTree(sourcePath, containmentRoot, {
      onDirectory: (relativePath) => {
        if (relativePath !== '.') mkdirSync(path.join(destinationPath, relativePath));
      },
      onFile: (filePath, relativePath) => copyFileSync(filePath, path.join(destinationPath, relativePath)),
    });
  } catch (error) {
    rmSync(destinationPath, { force: true, recursive: true });
    throw error;
  }
}
