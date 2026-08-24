import { resolve } from 'node:path';
import type {
  FormatDocumentRequest,
  FormatDocumentResponse,
} from '../../shared/ipc-types.js';
import { formatDocument } from './formatDocument.js';

function identity(request: FormatDocumentRequest) {
  return {
    documentVersion: request.documentVersion,
    editorSessionId: request.editorSessionId,
    fileKey: request.fileKey,
    requestId: request.requestId,
  };
}

process.parentPort.on('message', async (event) => {
  const request = event.data as FormatDocumentRequest;
  let response: FormatDocumentResponse;
  try {
    const result = await formatDocument({
      content: request.content,
      eol: request.eol,
      filePath: resolve(request.rootPath, request.relativePath),
      projectRoot: request.rootPath,
    });
    response = {
      ...identity(request),
      success: true,
      status: result.kind,
      changes: result.kind === 'formatted' ? result.changes : [],
    };
  } catch (error) {
    response = {
      ...identity(request),
      success: false,
      code: 'FORMAT_ERROR',
      error: error instanceof Error ? error.message : String(error),
    };
  }
  process.parentPort.postMessage(response);
});
