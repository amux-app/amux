import { lstat } from 'node:fs/promises';
import { basename, extname, resolve } from 'node:path';

const MAX_COPY_SUFFIX = 1000;

/**
 * `lstat`, not `access`: a dangling symlink is an entry that occupies its name, but `access`
 * follows the link and reports it absent — which would let a move be planned straight over it.
 */
export async function exists(path: string): Promise<boolean> {
  return lstat(path).then(() => true, () => false);
}

export function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error
    && 'code' in error
    && (error as Error & { code?: unknown }).code === code;
}

export async function generateCopyName(destDir: string, sourceName: string): Promise<string> {
  if (!(await exists(resolve(destDir, sourceName)))) return sourceName;

  const ext = extname(sourceName);
  const base = ext ? basename(sourceName, ext) : sourceName;

  const copyName = `${base} copy${ext}`;
  if (!(await exists(resolve(destDir, copyName)))) return copyName;

  for (let i = 2; i < MAX_COPY_SUFFIX; i++) {
    const numbered = `${base} copy ${i}${ext}`;
    if (!(await exists(resolve(destDir, numbered)))) return numbered;
  }

  throw new Error('Too many copies exist');
}
