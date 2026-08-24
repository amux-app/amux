import { IPC } from '../../shared/ipc-channels.js';
import type { FormatDocumentCancelRequest, FormatDocumentRequest } from '../../shared/ipc-types.js';
import type { AumxBridge } from '../services/AumxBridge.js';
import { FormatterService } from '../services/FormatterService.js';
import {
  resolveAuthorizedFileRoot,
  validateFilePath,
} from '../utils/file-root-authorization.js';
import { secureHandle } from './ipc-security.js';

let formatterService: FormatterService | undefined;

function getFormatterService(): FormatterService {
  formatterService ??= new FormatterService();
  return formatterService;
}

export function registerFormatHandlers(bridge: AumxBridge): void {
  secureHandle(IPC.FILE_FORMAT, async (_event, request: FormatDocumentRequest) => {
    const rootPath = resolveAuthorizedFileRoot(
      bridge.getProjectRoot(),
      bridge.getPanes(),
      request.rootPath,
    );
    validateFilePath(rootPath, request.relativePath);
    return getFormatterService().format({ ...request, rootPath });
  });

  secureHandle(IPC.FILE_FORMAT_CANCEL, (_event, request: FormatDocumentCancelRequest) => ({
    cancelled: formatterService?.cancel(request.requestId) ?? false,
  }));
}
