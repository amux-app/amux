import { IPC } from '../../shared/ipc-channels.js';
import type {
  WorktreeInspectRequest,
  WorktreeRemoveRequest,
  WorktreeReopenRequest,
} from '../../shared/ipc-types.js';
import type { AumxBridge } from '../services/AumxBridge.js';
import { log } from '../services/Logger.js';
import { formatError } from '../utils/formatError.js';
import { secureHandle } from './ipc-security.js';

export function registerWorktreeHandlers(bridge: AumxBridge): void {
  secureHandle(IPC.WORKTREE_ORPHAN_INSPECT, async (_event, request: WorktreeInspectRequest) => {
    log.debug('ipc:worktree', 'WORKTREE_ORPHAN_INSPECT invoked');
    try {
      return await bridge.inspectPreservedWorktree(request.worktreePath);
    } catch (error) {
      log.error('ipc:worktree', 'WORKTREE_ORPHAN_INSPECT failed', error);
      return { success: false, error: formatError(error) };
    }
  });

  secureHandle(IPC.WORKTREE_ORPHANS_LIST, async () => {
    log.debug('ipc:worktree', 'WORKTREE_ORPHANS_LIST invoked');
    try {
      return await bridge.listOrphanedWorktrees();
    } catch (error) {
      log.error('ipc:worktree', 'WORKTREE_ORPHANS_LIST failed', error);
      return { success: false, worktrees: [], error: formatError(error) };
    }
  });

  secureHandle(IPC.WORKTREE_REMOVE, async (_event, request: WorktreeRemoveRequest) => {
    log.info('ipc:worktree', 'WORKTREE_REMOVE invoked', { worktreePath: request.worktreePath });
    try {
      return await bridge.runProjectMutation(() => bridge.removePreservedWorktree(
        request.worktreePath,
        request.allowDataLoss,
        request.expectedState,
      ));
    } catch (error) {
      log.error('ipc:worktree', 'WORKTREE_REMOVE failed', error);
      return { success: false, error: formatError(error) };
    }
  });

  secureHandle(IPC.WORKTREE_REOPEN, async (_event, request: WorktreeReopenRequest) => {
    log.info('ipc:worktree', 'WORKTREE_REOPEN invoked', { worktreePath: request.worktreePath });
    try {
      return await bridge.runProjectMutation(() => bridge.reopenWorktreePane(request.worktreePath));
    } catch (error) {
      log.error('ipc:worktree', 'WORKTREE_REOPEN failed', error);
      return { success: false, error: formatError(error) };
    }
  });
}
