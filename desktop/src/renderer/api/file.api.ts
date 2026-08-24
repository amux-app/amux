import type {
  FileCreateRequest,
  FileCopyRequest,
  FileDeleteRequest,
  FileListRequest,
  FileListResponse,
  FileMoveRequest,
  FileMoveResponse,
  FileReadBinaryRequest,
  FileReadBinaryResponse,
  FileReadRequest,
  FileReadResponse,
  FileMutationResponse,
  FileRenameRequest,
  FileWatchRootRequest,
  FileWriteRequest,
  FileWriteResponse,
  FormatDocumentRequest,
  FormatDocumentResponse,
} from '../../shared/ipc-types';
import { normalizeOperationPaths } from '../../shared/filePolicy';
import { IPC } from '../../shared/ipc-channels';
import { invoke } from './ipc';
import { sanitizeFileListResponse, sanitizeFileMutationResponse, sanitizeFileReadBinaryResponse, sanitizeFileReadResponse, sanitizeFileWriteResponse, sanitizeFormatDocumentResponse, validateFileMoveResponse, warnDroppedItems, warnInvalidPayload } from '../lib/runtimeValidation';

export async function listFiles(req: FileListRequest): Promise<FileListResponse> {
  const payload = await invoke<unknown>(IPC.FILE_LIST, req);
  const response = sanitizeFileListResponse(payload);

  if (!response) {
    warnInvalidPayload('file-list', payload);
    return { entries: [], error: 'Invalid file list response' };
  }

  if (payload && typeof payload === 'object' && 'entries' in payload && Array.isArray(payload.entries) && response.entries.length !== payload.entries.length) {
    warnDroppedItems('file-list', payload.entries.length, response.entries.length);
  }

  return response;
}

export async function readFileContent(req: FileReadRequest): Promise<FileReadResponse> {
  const payload = await invoke<unknown>(IPC.FILE_READ, req);
  const response = sanitizeFileReadResponse(payload);

  if (!response) {
    warnInvalidPayload('file-read', payload);
    return { kind: 'error', code: 'IO_ERROR', message: 'Invalid file read response' };
  }

  return response;
}

export async function readFileBinary(req: FileReadBinaryRequest): Promise<FileReadBinaryResponse> {
  const payload = await invoke<unknown>(IPC.FILE_READ_BINARY, req);
  const response = sanitizeFileReadBinaryResponse(payload);

  if (!response) {
    warnInvalidPayload('file-read-binary', payload);
    return { data: '', mimeType: 'application/octet-stream', error: 'Invalid file read binary response' };
  }

  return response;
}

export async function writeFileContent(req: FileWriteRequest): Promise<FileWriteResponse> {
  const payload = await invoke<unknown>(IPC.FILE_WRITE, req);
  const response = sanitizeFileWriteResponse(payload);

  if (!response) {
    warnInvalidPayload('file-write', payload);
    return {
      documentVersion: req.documentVersion,
      editorSessionId: req.editorSessionId,
      saveSequence: req.saveSequence,
      success: false,
      error: 'Invalid file write response',
    };
  }

  return response;
}

export async function formatFileContent(req: FormatDocumentRequest): Promise<FormatDocumentResponse> {
  const payload = await invoke<unknown>(IPC.FILE_FORMAT, req);
  const response = sanitizeFormatDocumentResponse(payload);
  if (response) return response;
  warnInvalidPayload('file-format', payload);
  return {
    documentVersion: req.documentVersion,
    editorSessionId: req.editorSessionId,
    fileKey: req.fileKey,
    requestId: req.requestId,
    success: false,
    code: 'INVALID_RESPONSE',
    error: 'Invalid formatter response',
  };
}

export function cancelFormatFileContent(requestId: string): Promise<{ cancelled: boolean }> {
  return invoke<{ cancelled: boolean }>(IPC.FILE_FORMAT_CANCEL, { requestId });
}

export async function createFile(req: FileCreateRequest): Promise<FileMutationResponse> {
  const payload = await invoke<unknown>(IPC.FILE_CREATE, req);
  const response = sanitizeFileMutationResponse(payload);

  if (!response) {
    warnInvalidPayload('file-create', payload);
    return { success: false, error: 'Invalid file create response' };
  }

  return response;
}

export async function createDir(req: FileCreateRequest): Promise<FileMutationResponse> {
  const payload = await invoke<unknown>(IPC.FILE_CREATE_DIR, req);
  const response = sanitizeFileMutationResponse(payload);

  if (!response) {
    warnInvalidPayload('file-create-dir', payload);
    return { success: false, error: 'Invalid file create dir response' };
  }

  return response;
}

export async function deleteFile(req: FileDeleteRequest): Promise<FileMutationResponse> {
  const payload = await invoke<unknown>(IPC.FILE_DELETE, req);
  const response = sanitizeFileMutationResponse(payload);

  if (!response) {
    warnInvalidPayload('file-delete', payload);
    return { success: false, error: 'Invalid file delete response' };
  }

  return response;
}

export async function renameFile(req: FileRenameRequest): Promise<FileMutationResponse> {
  const payload = await invoke<unknown>(IPC.FILE_RENAME, req);
  const response = sanitizeFileMutationResponse(payload);

  if (!response) {
    warnInvalidPayload('file-rename', payload);
    return { success: false, error: 'Invalid file rename response' };
  }

  return response;
}

export async function copyFile(req: FileCopyRequest): Promise<FileMutationResponse> {
  const payload = await invoke<unknown>(IPC.FILE_COPY, req);
  const response = sanitizeFileMutationResponse(payload);

  if (!response) {
    warnInvalidPayload('file-copy', payload);
    return { success: false, error: 'Invalid file copy response' };
  }

  return response;
}

/**
 * Normalizes here rather than relying on callers: the handler returns one result per *normalized*
 * source path, so an unnormalized request would be judged corrupt against its own response.
 */
export async function moveFiles(req: FileMoveRequest): Promise<FileMoveResponse> {
  const sourcePaths = normalizeOperationPaths(req.sourcePaths);
  const payload = await invoke<unknown>(IPC.FILE_MOVE, { ...req, sourcePaths });
  const response = validateFileMoveResponse(payload, sourcePaths);

  if (!response) {
    warnInvalidPayload('file-move', payload);
    return { results: [], code: 'UNKNOWN', error: 'Invalid file move response' };
  }

  return response;
}

export function setFileWatchRoot(req: FileWatchRootRequest): Promise<void> {
  return invoke<void>(IPC.FILE_WATCH_ROOT, req);
}
