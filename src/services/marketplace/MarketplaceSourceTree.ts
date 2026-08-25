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

export interface MarketplaceSourceTreeEntry {
  contentHash?: string;
  entryType: 'directory' | 'file';
  relativePath: string;
}

interface MarketplaceSourceTreeVisitor {
  onDirectory: (relativePath: string) => void;
  onFile: (sourcePath: string, relativePath: string) => void;
}

function isPathWithin(rootPath: string, candidatePath: string): boolean {
  const relativePath = path.relative(rootPath, candidatePath);
  return relativePath === ''
    || (!relativePath.startsWith(`..${path.sep}`) && relativePath !== '..' && !path.isAbsolute(relativePath));
}

function walkMarketplaceSourceTree(
  sourcePath: string,
  relativePath: string,
  containmentRoot: string,
  activeDirectories: Set<string>,
  visitor: MarketplaceSourceTreeVisitor,
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
    walkMarketplaceSourceTree(
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
      walkMarketplaceSourceTree(
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

function visitMarketplaceSourceTree(
  sourcePath: string,
  containmentRoot: string,
  visitor: MarketplaceSourceTreeVisitor,
): void {
  const canonicalContainmentRoot = realpathSync(containmentRoot);
  let canonicalSourcePath: string;
  try {
    canonicalSourcePath = realpathSync(sourcePath);
  } catch {
    let isSymlink = false;
    try { isSymlink = lstatSync(sourcePath).isSymbolicLink(); } catch { /* missing source */ }
    if (isSymlink) throw new Error(`Marketplace artifact has a broken or cyclic symlink: ${sourcePath}`);
    throw new Error(`Marketplace artifact source cannot be resolved: ${sourcePath}`);
  }
  if (!isPathWithin(canonicalContainmentRoot, canonicalSourcePath)) {
    throw new Error(`Marketplace artifact source is outside the marketplace source: ${sourcePath}`);
  }
  walkMarketplaceSourceTree(sourcePath, '.', canonicalContainmentRoot, new Set(), visitor);
}

export function collectMarketplaceSourceTreeEntries(
  sourcePath: string,
  containmentRoot: string,
): MarketplaceSourceTreeEntry[] {
  const entries: MarketplaceSourceTreeEntry[] = [];
  visitMarketplaceSourceTree(sourcePath, containmentRoot, {
    onDirectory: (relativePath) => entries.push({ entryType: 'directory', relativePath }),
    onFile: (filePath, relativePath) => entries.push({
      contentHash: createHash('sha256').update(readFileSync(filePath)).digest('hex'),
      entryType: 'file',
      relativePath,
    }),
  });
  return entries;
}

export function materializeMarketplaceSourceTree(
  sourcePath: string,
  destinationPath: string,
  containmentRoot: string,
): void {
  mkdirSync(path.dirname(destinationPath), { recursive: true });
  mkdirSync(destinationPath);
  try {
    visitMarketplaceSourceTree(sourcePath, containmentRoot, {
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
