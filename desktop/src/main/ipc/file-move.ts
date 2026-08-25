import {
  cp,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readlink,
  rename,
  rm,
  rmdir,
  symlink,
  unlink,
} from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { normalizeOperationPaths } from '../../shared/filePolicy.js';
import type {
  FileMoveErrorCode,
  FileMoveItemResult,
  FileMoveMode,
  FileMoveRequest,
  FileMoveResponse,
} from '../../shared/ipc-types.js';
import { isPathWithinRoot, validateFilePath } from '../utils/file-root-authorization.js';
import { exists, generateCopyName, hasErrorCode } from '../utils/fileSystem.js';
import { formatError } from '../utils/formatError.js';

const MAPPED_ERROR_CODES = ['EACCES', 'EEXIST', 'ENOENT'] as const;

const DUPLICATE_TARGET_MESSAGE = 'Two items would land on the same name';
const SELF_CONTAINMENT_MESSAGE = 'A folder cannot be moved into itself';
const UNAUTHORIZED_PATH_MESSAGE = 'The requested path is outside the project root';

type MoveOutcome =
  | { status: 'succeeded'; finalPath: string }
  | { status: 'partial'; finalPath: string; code: FileMoveErrorCode; error: string }
  | { status: 'failed'; code: FileMoveErrorCode; error: string };

interface PlannedMoveOperation {
  isDirectory: boolean;
  isSymbolicLink: boolean;
  sourceAbs: string;
  sourcePath: string;
  targetAbs: string;
  targetPath: string;
}

interface PreflightPlan {
  operations: PlannedMoveOperation[];
  /** Items rejected during preflight — already-existing move targets, unreadable sources. */
  results: FileMoveItemResult[];
}

interface PreflightRejection {
  code: FileMoveErrorCode;
  message: string;
}

function toMoveErrorCode(error: unknown): FileMoveErrorCode {
  return MAPPED_ERROR_CODES.find((code) => hasErrorCode(error, code)) ?? 'UNKNOWN';
}

function failedResult(sourcePath: string, error: unknown): FileMoveItemResult {
  return {
    code: toMoveErrorCode(error),
    error: formatError(error),
    sourcePath,
    status: 'failed',
  };
}

/**
 * The default macOS and Windows filesystems are case-insensitive, so `Foo` and `foo` are one entry
 * and a batch containing both would have its first result silently replaced by its second. Folding
 * the dedup key can over-reject that pathological pair on a case-sensitive volume, which is the
 * safe direction to be wrong in.
 */
function caseFold(targetAbs: string): string {
  return targetAbs.toLowerCase();
}

function joinRelative(destDir: string, name: string): string {
  return destDir ? `${destDir}/${name}` : name;
}

async function planOne(
  rootPath: string,
  sourcePath: string,
  destDirAbs: string,
  destDir: string,
  mode: FileMoveMode,
): Promise<PlannedMoveOperation | FileMoveItemResult | PreflightRejection> {
  let sourceAbs: string;
  try {
    sourceAbs = validateFilePath(rootPath, sourcePath);
  } catch {
    return { code: 'INVALID', message: UNAUTHORIZED_PATH_MESSAGE };
  }

  if (isPathWithinRoot(sourceAbs, destDirAbs)) {
    return { code: 'INVALID', message: SELF_CONTAINMENT_MESSAGE };
  }

  // `lstat`, not `stat`: a symlink is an entry in its own right, and a dangling one is still
  // listed in the tree, so following it here would make it permanently unmovable with ENOENT.
  let stats: Stats;
  try {
    stats = await lstat(sourceAbs);
  } catch (error) {
    return failedResult(sourcePath, error);
  }

  const sourceName = basename(sourceAbs);
  const targetName = mode === 'copy'
    ? await generateCopyName(destDirAbs, sourceName)
    : sourceName;

  return {
    isDirectory: stats.isDirectory(),
    isSymbolicLink: stats.isSymbolicLink(),
    sourceAbs,
    sourcePath,
    targetAbs: join(destDirAbs, targetName),
    targetPath: joinRelative(destDir, targetName),
  };
}

function isRejection(value: object): value is PreflightRejection {
  return 'message' in value;
}

async function preflightMove(
  rootPath: string,
  sourcePaths: string[],
  destDir: string,
  mode: FileMoveMode,
): Promise<PreflightPlan | PreflightRejection> {
  let destDirAbs: string;
  try {
    destDirAbs = validateFilePath(rootPath, destDir);
  } catch {
    return { code: 'INVALID', message: UNAUTHORIZED_PATH_MESSAGE };
  }

  const operations: PlannedMoveOperation[] = [];
  const results: FileMoveItemResult[] = [];
  const claimedTargets = new Set<string>();

  for (const sourcePath of sourcePaths) {
    const planned = await planOne(rootPath, sourcePath, destDirAbs, destDir, mode);
    if (isRejection(planned)) return planned;
    if ('status' in planned) {
      results.push(planned);
      continue;
    }

    if (claimedTargets.has(caseFold(planned.targetAbs))) {
      return { code: 'DUPLICATE_TARGET', message: DUPLICATE_TARGET_MESSAGE };
    }
    claimedTargets.add(caseFold(planned.targetAbs));

    if (mode === 'move' && await exists(planned.targetAbs)) {
      results.push({
        code: 'EEXIST',
        error: `${planned.targetPath} already exists`,
        sourcePath,
        status: 'failed',
      });
      continue;
    }

    operations.push(planned);
  }

  return { operations, results };
}

/**
 * Publishes the target without overwriting an existing one, so a lost race fails with EEXIST
 * instead of destroying data — `link` for a regular file, `symlink` for a link, both of which
 * refuse an existing destination. The source removal is the second failure point: a half-completed
 * move is rolled back, and a failed rollback is reported as `partial` rather than a clean failure.
 */
async function publishThenUnlink(operation: PlannedMoveOperation): Promise<MoveOutcome> {
  if (operation.isSymbolicLink) {
    await symlink(await readlink(operation.sourceAbs), operation.targetAbs);
  } else {
    await link(operation.sourceAbs, operation.targetAbs);
  }

  try {
    await unlink(operation.sourceAbs);
  } catch (unlinkError) {
    const code = toMoveErrorCode(unlinkError);
    const error = formatError(unlinkError);
    try {
      await unlink(operation.targetAbs);
      return { code, error, status: 'failed' };
    } catch {
      return { code, error, finalPath: operation.targetPath, status: 'partial' };
    }
  }

  return { finalPath: operation.targetPath, status: 'succeeded' };
}

/**
 * Reserves a directory target without clobbering a raced-in entry, then replaces only the empty
 * directory this operation created. If the rename fails, `rmdir` removes the reservation only
 * while it is still empty; it can never recursively remove content another process added.
 */
async function publishReservedDirectory(sourceAbs: string, targetAbs: string): Promise<void> {
  await mkdir(targetAbs);
  try {
    await rename(sourceAbs, targetAbs);
  } catch (error) {
    try {
      await rmdir(targetAbs);
    } catch {
      // Preserve the original publication error. A non-empty reservation may contain raced-in
      // user data and must not be removed recursively.
    }
    throw error;
  }
}

/**
 * Copies into an atomically created sibling staging directory so a failed recursive copy cannot
 * leak a partial final destination. Publication uses only no-clobber primitives.
 */
async function copyThenPublish(operation: PlannedMoveOperation): Promise<MoveOutcome> {
  const stagingRoot = await mkdtemp(join(dirname(operation.targetAbs), '.muxbase-copy-'));
  const stagingAbs = join(stagingRoot, basename(operation.targetAbs));

  try {
    await cp(operation.sourceAbs, stagingAbs, {
      errorOnExist: true,
      force: false,
      recursive: true,
    });

    if (operation.isDirectory && !operation.isSymbolicLink) {
      await publishReservedDirectory(stagingAbs, operation.targetAbs);
      return { finalPath: operation.targetPath, status: 'succeeded' };
    }

    return await publishThenUnlink({ ...operation, sourceAbs: stagingAbs });
  } finally {
    // `mkdtemp` is the ownership proof for this exact path, so recursive cleanup cannot touch a
    // user-owned staging-name collision.
    await rm(stagingRoot, { force: true, recursive: true });
  }
}

async function applyOneMove(
  operation: PlannedMoveOperation,
  mode: FileMoveMode,
): Promise<MoveOutcome> {
  try {
    if (mode === 'copy') {
      return await copyThenPublish(operation);
    }

    if (operation.isDirectory) {
      await publishReservedDirectory(operation.sourceAbs, operation.targetAbs);
      return { finalPath: operation.targetPath, status: 'succeeded' };
    }

    return await publishThenUnlink(operation);
  } catch (error) {
    return { code: toMoveErrorCode(error), error: formatError(error), status: 'failed' };
  }
}

/**
 * Moves or copies every source into `destDir`, returning exactly one result per normalized source
 * path. Nothing touches the filesystem until the whole batch passes preflight.
 */
export async function applyFileMove(
  rootPath: string,
  request: FileMoveRequest,
): Promise<FileMoveResponse> {
  const sourcePaths = normalizeOperationPaths(request.sourcePaths);
  const plan = await preflightMove(rootPath, sourcePaths, request.destDir, request.mode);
  if (isRejection(plan)) {
    return { code: plan.code, error: plan.message, results: [] };
  }

  const results = [...plan.results];
  for (const operation of plan.operations) {
    const outcome = await applyOneMove(operation, request.mode);
    results.push({ ...outcome, sourcePath: operation.sourcePath });
  }

  return { results };
}
