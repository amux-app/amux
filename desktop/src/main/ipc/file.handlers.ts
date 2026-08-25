import { randomBytes } from 'node:crypto';
import {
  access,
  cp,
  link,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { shell } from 'electron';
import { IPC } from '../../shared/ipc-channels.js';
import type {
  FileCreateRequest,
  FileCopyRequest,
  FileDeleteRequest,
  FileEntry,
  FileListRequest,
  FileListResponse,
  FileMoveRequest,
  FileMoveResponse,
  FileReadBinaryRequest,
  FileReadBinaryResponse,
  FileReadRequest,
  FileReadResponse,
  FileWriteRequest,
  FileWriteResponse,
  FileMutationResponse,
  FileRenameRequest,
  FileWatchRootRequest,
} from '../../shared/ipc-types.js';
import type { MuxBaseBridge } from '../services/MuxBaseBridge.js';
import { EditorRuntimeMetrics } from '../services/EditorRuntimeMetrics.js';
import { log } from '../services/Logger.js';
import {
  decodeFileContent,
  encodeFileContent,
  hashFileContent,
} from '../services/fileContent.js';
import { projectSearchService } from '../services/ProjectSearchService.js';
import { formatError } from '../utils/formatError.js';
import {
  isPathWithinRoot,
  resolveAuthorizedFileRoot,
  validateFilePath,
} from '../utils/file-root-authorization.js';
import { generateCopyName, hasErrorCode } from '../utils/fileSystem.js';
import { applyFileMove } from './file-move.js';
import { secureHandle } from './ipc-security.js';

const MAX_FILE_SIZE = 1024 * 1024; // 1 MB
const MAX_BINARY_FILE_SIZE = 5 * 1024 * 1024; // 5 MB

const BINARY_MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.bmp': 'image/bmp',
};

function elapsedMs(startedAt: number): number {
  return Math.round(performance.now() - startedAt);
}

interface FileWriteMetadata {
  mode: number;
}

async function readFileWriteMetadata(path: string): Promise<FileWriteMetadata | null> {
  try {
    const { mode } = await stat(path);
    return { mode };
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) {
      return null;
    }
    throw error;
  }
}

async function resolveExistingWriteTarget(
  rootPath: string,
  requestedTarget: string,
): Promise<string | null> {
  let isSymbolicLink: boolean;
  try {
    isSymbolicLink = (await lstat(requestedTarget)).isSymbolicLink();
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) {
      return null;
    }
    throw error;
  }

  if (!isSymbolicLink) {
    return requestedTarget;
  }

  try {
    const canonicalTarget = await realpath(requestedTarget);
    if (!isPathWithinRoot(rootPath, canonicalTarget)) {
      throw new Error('Path traversal blocked');
    }
    return canonicalTarget;
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) {
      return null;
    }
    throw error;
  }
}

async function writeFileAtomically(
  target: string,
  content: Buffer,
  options: { beforePublish?: () => Promise<void>; mode?: number; replace: boolean },
): Promise<void> {
  const tempPath = join(
    dirname(target),
    `.${basename(target)}.${randomBytes(8).toString('hex')}.tmp`,
  );

  try {
    await writeFile(tempPath, content, {
      flag: 'wx',
      mode: options.mode,
    });
    await options.beforePublish?.();
    if (options.replace) {
      await rename(tempPath, target);
    } else {
      // A hard link publishes the completed inode without overwriting a file
      // that may have reappeared since the editor observed its deletion.
      await link(tempPath, target);
    }
  } finally {
    await unlink(tempPath).catch(() => {});
  }
}

const fileWriteQueues = new Map<string, Promise<void>>();

async function serializeFileWrite<T>(filePath: string, operation: () => Promise<T>): Promise<T> {
  const previous = fileWriteQueues.get(filePath) ?? Promise.resolve();
  const result = previous.catch(() => undefined).then(operation);
  const settled = result.then(() => undefined, () => undefined);
  fileWriteQueues.set(filePath, settled);
  try {
    return await result;
  } finally {
    if (fileWriteQueues.get(filePath) === settled) {
      fileWriteQueues.delete(filePath);
    }
  }
}

async function readBoundedBytes(filePath: string): Promise<Buffer | 'too-large' | null> {
  let fd;
  try {
    fd = await open(filePath, 'r');
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) return null;
    throw error;
  }

  try {
    const { size } = await fd.stat();
    if (size > MAX_FILE_SIZE) return 'too-large';
    const bytes = Buffer.alloc(size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await fd.read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    return offset === bytes.length ? bytes : bytes.subarray(0, offset);
  } finally {
    await fd.close();
  }
}

function writeIdentity(request: FileWriteRequest) {
  return {
    documentVersion: request.documentVersion,
    editorSessionId: request.editorSessionId,
    saveSequence: request.saveSequence,
  };
}

function readErrorResponse(error: unknown): FileReadResponse {
  if (hasErrorCode(error, 'ENOENT')) {
    return { kind: 'error', code: 'NOT_FOUND', message: 'File not found' };
  }
  if (
    hasErrorCode(error, 'EACCES')
    || hasErrorCode(error, 'EPERM')
    || (error instanceof Error && /unauthorized|path traversal/i.test(error.message))
  ) {
    return { kind: 'error', code: 'NOT_AUTHORIZED', message: 'File access is not authorized' };
  }
  return { kind: 'error', code: 'IO_ERROR', message: 'Failed to read file' };
}

function writeConflict(
  request: FileWriteRequest,
  conflictType: 'deleted' | 'modified',
  error: string,
  currentContentVersion?: string,
): FileWriteResponse {
  return {
    ...writeIdentity(request),
    success: false,
    conflict: true,
    conflictType,
    currentContentVersion,
    error,
  };
}

class FileChangedBeforePublishError extends Error {
  constructor(readonly currentContentVersion?: string) {
    super('File changed before publication');
  }
}

export function registerFileHandlers(bridge: MuxBaseBridge): void {
  secureHandle(IPC.FILE_WATCH_ROOT, async (_event, request: FileWatchRootRequest) => {
    log.debug('ipc:file', 'FILE_WATCH_ROOT', { rootPath: request.rootPath });
    try {
      const rootPath = request.rootPath
        ? resolveAuthorizedFileRoot(bridge.getProjectRoot(), bridge.getPanes(), request.rootPath)
        : null;
      log.info('ipc:file', 'FILE_WATCH_ROOT resolved', {
        dirPathCount: request.dirPaths?.length ?? 0,
        requestedRootPath: request.rootPath ?? null,
        resolvedRootPath: rootPath,
      });
      await bridge.setFileWatchRoot(rootPath, request.dirPaths ?? [], request.rootPath ?? rootPath);
    } catch (error) {
      log.error('ipc:file', 'FILE_WATCH_ROOT failed', error);
      await bridge.setFileWatchRoot(null);
    }
  });

  secureHandle(IPC.FILE_LIST, async (_event, request: FileListRequest) => {
    log.debug('ipc:file', 'FILE_LIST', { rootPath: request.rootPath, dirPath: request.dirPath });
    try {
      const rootPath = resolveAuthorizedFileRoot(bridge.getProjectRoot(), bridge.getPanes(), request.rootPath);
      const target = request.dirPath
        ? validateFilePath(rootPath, request.dirPath)
        : rootPath;

      const dirents = await readdir(target, { withFileTypes: true });
      const entries: FileEntry[] = dirents
        .filter((d) => d.name !== '.git')
        .map((d) => ({
          name: d.name,
          path: request.dirPath ? `${request.dirPath}/${d.name}` : d.name,
          isDirectory: d.isDirectory(),
        }))
        .sort((a, b) => {
          if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
          return a.name.localeCompare(b.name);
        });

      const response: FileListResponse = { entries };
      return response;
    } catch (error) {
      log.error('ipc:file', 'FILE_LIST failed', error);
      return { entries: [], error: formatError(error) } satisfies FileListResponse;
    }
  });

  secureHandle(IPC.FILE_READ, async (_event, request: FileReadRequest) => {
    EditorRuntimeMetrics.getInstance().recordFileContentRead();
    const startedAt = performance.now();
    log.debug('ipc:file', 'FILE_READ', { relativePath: request.relativePath, rootPath: request.rootPath });
    try {
      const authorizationStartedAt = performance.now();
      const rootPath = resolveAuthorizedFileRoot(bridge.getProjectRoot(), bridge.getPanes(), request.rootPath);
      const target = validateFilePath(rootPath, request.relativePath);
      const authorizationDurationMs = elapsedMs(authorizationStartedAt);
      const diskReadStartedAt = performance.now();
      const fd = await open(target, 'r');
      try {
        const { size } = await fd.stat();
        const truncated = size > MAX_FILE_SIZE;
        const readSize = Math.min(size, MAX_FILE_SIZE);
        const buf = Buffer.alloc(readSize);
        let offset = 0;
        while (offset < readSize) {
          const { bytesRead } = await fd.read(buf, offset, readSize - offset, offset);
          if (bytesRead === 0) break;
          offset += bytesRead;
        }
        const bytesRead = offset === readSize ? buf : buf.subarray(0, offset);
        log.info('ipc:file', 'FILE_READ completed', {
          authorizationDurationMs,
          diskReadDurationMs: elapsedMs(diskReadStartedAt),
          readSize,
          relativePath: request.relativePath,
          rootPath,
          size,
          totalDurationMs: elapsedMs(startedAt),
          truncated,
        });
        return decodeFileContent(bytesRead, size, truncated);
      } finally {
        await fd.close();
      }
    } catch (error) {
      log.error('ipc:file', 'FILE_READ failed', {
        durationMs: elapsedMs(startedAt),
        error: formatError(error),
        relativePath: request.relativePath,
        rootPath: request.rootPath,
      });
      return readErrorResponse(error);
    }
  });

  secureHandle(IPC.FILE_READ_BINARY, async (_event, request: FileReadBinaryRequest) => {
    const startedAt = performance.now();
    log.debug('ipc:file', 'FILE_READ_BINARY', { relativePath: request.relativePath, rootPath: request.rootPath });
    const mimeType = BINARY_MIME_BY_EXT[extname(request.relativePath).toLowerCase()] ?? 'application/octet-stream';
    try {
      const rootPath = resolveAuthorizedFileRoot(bridge.getProjectRoot(), bridge.getPanes(), request.rootPath);
      const target = validateFilePath(rootPath, request.relativePath);
      const fd = await open(target, 'r');
      try {
        const { size } = await fd.stat();
        if (size > MAX_BINARY_FILE_SIZE) {
          return { data: '', mimeType, error: 'File too large' } satisfies FileReadBinaryResponse;
        }
        const buf = Buffer.allocUnsafe(size);
        await fd.read(buf, 0, size, 0);
        log.info('ipc:file', 'FILE_READ_BINARY completed', {
          mimeType,
          relativePath: request.relativePath,
          rootPath,
          size,
          totalDurationMs: elapsedMs(startedAt),
        });
        return { data: buf.toString('base64'), mimeType } satisfies FileReadBinaryResponse;
      } finally {
        await fd.close();
      }
    } catch (error) {
      log.error('ipc:file', 'FILE_READ_BINARY failed', {
        durationMs: elapsedMs(startedAt),
        error: formatError(error),
        relativePath: request.relativePath,
        rootPath: request.rootPath,
      });
      return { data: '', mimeType, error: formatError(error) } satisfies FileReadBinaryResponse;
    }
  });

  secureHandle(IPC.FILE_WRITE, async (_event, request: FileWriteRequest) => {
    log.info('ipc:file', 'FILE_WRITE', { relativePath: request.relativePath });
    try {
      const rootPath = resolveAuthorizedFileRoot(bridge.getProjectRoot(), bridge.getPanes(), request.rootPath);
      const target = validateFilePath(rootPath, request.relativePath);
      const requestedWriteTarget = request.expectedMissing
        ? target
        : await resolveExistingWriteTarget(rootPath, target);
      const queueKey = requestedWriteTarget ?? target;

      return await serializeFileWrite(queueKey, async (): Promise<FileWriteResponse> => {
        const bytesToPublish = encodeFileContent(request.content, request.hasBom, request.eol);
        if (bytesToPublish.length > MAX_FILE_SIZE) {
          return {
            ...writeIdentity(request),
            success: false,
            error: 'File exceeds the editable size limit',
          };
        }

        if (request.expectedMissing) {
          await mkdir(dirname(target), { recursive: true });
          try {
            await writeFileAtomically(target, bytesToPublish, { replace: false });
          } catch (error) {
            if (hasErrorCode(error, 'EEXIST')) {
              return writeConflict(
                request,
                'modified',
                'File reappeared on disk before it could be recreated',
              );
            }
            throw error;
          }
        } else {
          const writeTarget = await resolveExistingWriteTarget(rootPath, target);
          if (writeTarget === null) {
            return writeConflict(request, 'deleted', 'File was deleted on disk since it was opened');
          }
          const currentMetadata = await readFileWriteMetadata(writeTarget);
          const currentBytes = await readBoundedBytes(writeTarget);
          if (currentMetadata === null || currentBytes === null) {
            return writeConflict(request, 'deleted', 'File was deleted on disk since it was opened');
          }
          if (currentBytes === 'too-large') {
            return writeConflict(request, 'modified', 'File now exceeds the editable size limit');
          }
          const currentContentVersion = hashFileContent(currentBytes);
          if (currentContentVersion !== request.expectedContentVersion) {
            return writeConflict(
              request,
              'modified',
              'File was modified on disk since it was opened',
              currentContentVersion,
            );
          }

          try {
            await writeFileAtomically(writeTarget, bytesToPublish, {
              mode: currentMetadata.mode & 0o7777,
              replace: true,
              beforePublish: async () => {
                const latestBytes = await readBoundedBytes(writeTarget);
                const latestVersion = latestBytes instanceof Buffer
                  ? hashFileContent(latestBytes)
                  : undefined;
                if (latestVersion !== request.expectedContentVersion) {
                  throw new FileChangedBeforePublishError(latestVersion);
                }
              },
            });
          } catch (error) {
            if (error instanceof FileChangedBeforePublishError) {
              return writeConflict(
                request,
                error.currentContentVersion === undefined ? 'deleted' : 'modified',
                'File changed before the save could be published',
                error.currentContentVersion,
              );
            }
            throw error;
          }
        }

        return {
          ...writeIdentity(request),
          success: true,
          contentVersion: hashFileContent(bytesToPublish),
        };
      });
    } catch (error) {
      log.error('ipc:file', 'FILE_WRITE failed', error);
      return {
        ...writeIdentity(request),
        success: false,
        error: formatError(error),
      } satisfies FileWriteResponse;
    }
  });

  secureHandle(IPC.FILE_CREATE, async (_event, request: FileCreateRequest) => {
    log.info('ipc:file', 'FILE_CREATE', { relativePath: request.relativePath });
    try {
      const rootPath = resolveAuthorizedFileRoot(bridge.getProjectRoot(), bridge.getPanes(), request.rootPath);
      const target = validateFilePath(rootPath, request.relativePath);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, '', { flag: 'wx' });
      projectSearchService.invalidate(rootPath);
      return { success: true } satisfies FileMutationResponse;
    } catch (error) {
      log.error('ipc:file', 'FILE_CREATE failed', error);
      return { success: false, error: formatError(error) } satisfies FileMutationResponse;
    }
  });

  secureHandle(IPC.FILE_CREATE_DIR, async (_event, request: FileCreateRequest) => {
    log.info('ipc:file', 'FILE_CREATE_DIR', { relativePath: request.relativePath });
    try {
      const rootPath = resolveAuthorizedFileRoot(bridge.getProjectRoot(), bridge.getPanes(), request.rootPath);
      const target = validateFilePath(rootPath, request.relativePath);
      await mkdir(target, { recursive: true });
      projectSearchService.invalidate(rootPath);
      return { success: true } satisfies FileMutationResponse;
    } catch (error) {
      log.error('ipc:file', 'FILE_CREATE_DIR failed', error);
      return { success: false, error: formatError(error) } satisfies FileMutationResponse;
    }
  });

  secureHandle(IPC.FILE_DELETE, async (_event, request: FileDeleteRequest) => {
    log.info('ipc:file', 'FILE_DELETE', { relativePath: request.relativePath });
    try {
      const rootPath = resolveAuthorizedFileRoot(bridge.getProjectRoot(), bridge.getPanes(), request.rootPath);
      const target = validateFilePath(rootPath, request.relativePath);
      await shell.trashItem(target);
      projectSearchService.invalidate(rootPath);
      return { success: true } satisfies FileMutationResponse;
    } catch (error) {
      log.error('ipc:file', 'FILE_DELETE failed', error);
      return { success: false, error: formatError(error) } satisfies FileMutationResponse;
    }
  });

  secureHandle(IPC.FILE_RENAME, async (_event, request: FileRenameRequest) => {
    log.info('ipc:file', 'FILE_RENAME', { oldPath: request.oldPath, newPath: request.newPath });
    try {
      const rootPath = resolveAuthorizedFileRoot(bridge.getProjectRoot(), bridge.getPanes(), request.rootPath);
      const source = validateFilePath(rootPath, request.oldPath);
      const dest = validateFilePath(rootPath, request.newPath);
      const destExists = await access(dest).then(() => true, () => false);
      if (destExists) {
        return { success: false, error: 'A file with that name already exists' } satisfies FileMutationResponse;
      }
      await mkdir(dirname(dest), { recursive: true });
      await rename(source, dest);
      projectSearchService.invalidate(rootPath);
      return { success: true } satisfies FileMutationResponse;
    } catch (error) {
      log.error('ipc:file', 'FILE_RENAME failed', error);
      return { success: false, error: formatError(error) } satisfies FileMutationResponse;
    }
  });

  secureHandle(IPC.FILE_COPY, async (_event, request: FileCopyRequest) => {
    log.info('ipc:file', 'FILE_COPY', {
      sourceRootPath: request.sourceRootPath,
      sourcePath: request.sourcePath,
      destRootPath: request.destRootPath,
      destDir: request.destDir,
    });
    try {
      const sourceRoot = resolveAuthorizedFileRoot(bridge.getProjectRoot(), bridge.getPanes(), request.sourceRootPath);
      const destRoot = resolveAuthorizedFileRoot(bridge.getProjectRoot(), bridge.getPanes(), request.destRootPath);
      const source = validateFilePath(sourceRoot, request.sourcePath);
      const destDirAbs = validateFilePath(destRoot, request.destDir);
      const sourceName = basename(source);
      const finalName = await generateCopyName(destDirAbs, sourceName);
      const dest = resolve(destDirAbs, finalName);
      validateFilePath(destRoot, dest.slice(destRoot.length + 1));
      await cp(source, dest, { recursive: true, force: false, errorOnExist: true });
      projectSearchService.invalidate(destRoot);
      if (sourceRoot !== destRoot) {
        projectSearchService.invalidate(sourceRoot);
      }
      return { success: true } satisfies FileMutationResponse;
    } catch (error) {
      log.error('ipc:file', 'FILE_COPY failed', error);
      return { success: false, error: formatError(error) } satisfies FileMutationResponse;
    }
  });

  secureHandle(IPC.FILE_MOVE, async (_event, request: FileMoveRequest) => {
    log.info('ipc:file', 'FILE_MOVE', {
      destDir: request.destDir,
      mode: request.mode,
      sourceCount: request.sourcePaths.length,
    });
    try {
      const rootPath = resolveAuthorizedFileRoot(bridge.getProjectRoot(), bridge.getPanes(), request.rootPath);
      const response = await applyFileMove(rootPath, request);
      projectSearchService.invalidate(rootPath);
      return response;
    } catch (error) {
      log.error('ipc:file', 'FILE_MOVE failed', error);
      return { results: [], code: 'INVALID', error: formatError(error) } satisfies FileMoveResponse;
    }
  });
}
