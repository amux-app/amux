import type { MuxBasePane } from 'muxbase/core';
import { IPC } from '../../shared/ipc-channels.js';
import type {
  PaneCreateRequest,
  PaneCloseRequest,
  PaneMergeRequest,
  PaneRenameRequest,
  PaneResumeFullscreenRequest,
  PaneJumpRequest,
  PaneSendKeysRequest,
  PaneGetContentRequest,
  PaneCreateWorktreeRequest,
  PaneAttachWorktreeRequest,
  PaneDuplicateRequest,
  PaneSessionListRequest,
  PaneStartReviewRequest,
  PaneSendFixRequest,
  PaneDuelCreateRequest,
  PaneDuelResolveRequest,
} from '../../shared/ipc-types.js';
import type { MuxBaseBridge } from '../services/MuxBaseBridge.js';
import { ElectronSettingsService } from '../services/ElectronSettingsService.js';
import { formatError } from '../utils/formatError.js';
import { authorizeProjectRoot } from '../services/projectRootAuthorization.js';
import { secureHandle } from './ipc-security.js';
import { log } from '../services/Logger.js';

const REVIEW_AGENT_DISABLED_MESSAGE = 'Code Review Agent is disabled — enable it in Settings → Advanced before using this feature';
const UNAUTHORIZED_PANE_MESSAGE = 'Unauthorized pane';

/** tmux targets must come from main state, never from a renderer supplied identifier. */
function resolveRegisteredPane(bridge: MuxBaseBridge, channel: string, paneId: string): MuxBasePane | undefined {
  const pane = bridge.getPanes().find((candidate) => candidate.id === paneId);
  if (!pane) {
    log.warn('ipc:pane', 'Rejected request for an unregistered pane', { channel, paneId });
  }
  return pane;
}

export function registerPaneHandlers(bridge: MuxBaseBridge): void {
  const settings = ElectronSettingsService.getInstance();
  const isReviewAgentEnabled = (): boolean => settings.get('enableReviewAgent') === true;
  secureHandle(IPC.PANE_LIST, async (_event, request?: { projectRoot?: string }) => {
    try {
      const projectRoot = await authorizeProjectRoot(request?.projectRoot, bridge.getProjectRoot(), bridge.getPanes());
      const panes = projectRoot
        ? bridge.getPanes().filter((pane) => pane.projectRoot === projectRoot || pane.worktreePath === projectRoot)
        : bridge.getPanes();
      log.debug('ipc:pane', 'PANE_LIST', { count: panes.length });
      return panes;
    } catch (error) {
      log.error('ipc:pane', 'PANE_LIST failed', error);
      return { error: formatError(error) };
    }
  });

  secureHandle(IPC.PANE_CREATE, async (_event, request: PaneCreateRequest) => {
    log.info('ipc:pane', 'PANE_CREATE invoked', { type: request.type, agent: request.agent, promptLength: request.prompt.length });
    try {
      return await bridge.runProjectMutation(async () => {
        const projectRoot = await authorizeProjectRoot(request.projectRoot, bridge.getProjectRoot(), bridge.getPanes());
        if (request.type === 'shell') {
          return bridge.createTerminalPane(projectRoot);
        }
        const result = await bridge.createPane(request.prompt, request.agent, {
          useWorktree: request.useWorktree,
          projectRoot,
          paneTitle: request.paneName,
          slugBase: request.paneName,
          model: request.model,
          effort: request.effort,
          claudeRenderer: request.claudeRenderer,
          resumeSessionId: request.resumeSessionId,
        });
        log.info('ipc:pane', 'PANE_CREATE result', { success: result.success, needsAgent: result.needsAgentChoice });
        return result;
      });
    } catch (error) {
      log.error('ipc:pane', 'PANE_CREATE failed', error);
      return { success: false, error: formatError(error) };
    }
  });

  secureHandle(IPC.PANE_CLOSE, async (_event, request: PaneCloseRequest) => {
    log.info('ipc:pane', 'PANE_CLOSE invoked', { paneId: request.paneId });
    try {
      return await bridge.runProjectMutation(() => bridge.closePaneAction(request.paneId));
    } catch (error) {
      log.error('ipc:pane', 'PANE_CLOSE failed', error);
      return { type: 'error' as const, message: formatError(error), error: formatError(error) };
    }
  });

  secureHandle(IPC.PANE_MERGE, async (_event, request: PaneMergeRequest) => {
    log.info('ipc:pane', 'PANE_MERGE invoked', { paneId: request.paneId });
    try {
      return await bridge.runProjectMutation(() => bridge.mergePaneAction(request.paneId));
    } catch (error) {
      log.error('ipc:pane', 'PANE_MERGE failed', error);
      return { type: 'error' as const, message: formatError(error), error: formatError(error) };
    }
  });

  secureHandle(IPC.PANE_RENAME, async (_event, request: PaneRenameRequest) => {
    log.info('ipc:pane', 'PANE_RENAME invoked', { paneId: request.paneId, newName: request.newName });
    try {
      return await bridge.runProjectMutation(() => bridge.renamePaneAction(request.paneId, request.newName));
    } catch (error) {
      log.error('ipc:pane', 'PANE_RENAME failed', error);
      return { type: 'error' as const, message: formatError(error), error: formatError(error) };
    }
  });

  secureHandle(IPC.PANE_RESUME_FULLSCREEN, async (_event, request: PaneResumeFullscreenRequest) => {
    log.info('ipc:pane', 'PANE_RESUME_FULLSCREEN invoked', { paneId: request.paneId });
    try {
      return await bridge.runProjectMutation(() => bridge.resumePaneInFullscreenAction(request.paneId));
    } catch (error) {
      log.error('ipc:pane', 'PANE_RESUME_FULLSCREEN failed', error);
      return { type: 'error' as const, message: formatError(error), error: formatError(error) };
    }
  });

  secureHandle(IPC.PANE_JUMP, async (_event, request: PaneJumpRequest) => {
    const pane = resolveRegisteredPane(bridge, IPC.PANE_JUMP, request.paneId);
    if (!pane) return { error: UNAUTHORIZED_PANE_MESSAGE, success: false };

    log.info('ipc:pane', 'PANE_JUMP invoked', { paneId: request.paneId, tmuxPaneId: pane.paneId });
    try {
      const tmux = bridge.getTmuxService();
      await tmux.selectPane(pane.paneId);
      return { success: true };
    } catch (error) {
      log.error('ipc:pane', 'PANE_JUMP failed', error);
      return { error: formatError(error), success: false };
    }
  });

  secureHandle(IPC.PANE_SEND_KEYS, async (_event, request: PaneSendKeysRequest) => {
    const pane = resolveRegisteredPane(bridge, IPC.PANE_SEND_KEYS, request.paneId);
    if (!pane) return { error: UNAUTHORIZED_PANE_MESSAGE, success: false };

    log.info('ipc:pane', 'PANE_SEND_KEYS invoked', { paneId: request.paneId, commandLength: request.command.length });
    try {
      await bridge.sendCommandToPane(pane.id, request.command);
      return { success: true };
    } catch (error) {
      log.error('ipc:pane', 'PANE_SEND_KEYS failed', error);
      return { error: formatError(error), success: false };
    }
  });

  secureHandle(IPC.PANE_GET_CONTENT, async (_event, request: PaneGetContentRequest) => {
    const pane = resolveRegisteredPane(bridge, IPC.PANE_GET_CONTENT, request.paneId);
    if (!pane) return { error: UNAUTHORIZED_PANE_MESSAGE, success: false };

    log.debug('ipc:pane', 'PANE_GET_CONTENT invoked', { paneId: request.paneId, tmuxPaneId: pane.paneId });
    try {
      const tmux = bridge.getTmuxService();
      const content = await tmux.getPaneContent(pane.paneId);
      return { content };
    } catch (error) {
      log.error('ipc:pane', 'PANE_GET_CONTENT failed', error);
      return { error: formatError(error) };
    }
  });

  secureHandle(IPC.PANE_DUEL_CREATE, async (_event, request: PaneDuelCreateRequest) => {
    log.info('ipc:pane', 'PANE_DUEL_CREATE invoked', { agentA: request.sides[0].agent, agentB: request.sides[1].agent });
    try {
      return await bridge.runProjectMutation(async () => {
        const projectRoot = await authorizeProjectRoot(request.projectRoot, bridge.getProjectRoot(), bridge.getPanes());
        return bridge.createDuelPanes({ ...request, projectRoot });
      });
    } catch (error) {
      log.error('ipc:pane', 'PANE_DUEL_CREATE failed', error);
      return { success: false, error: formatError(error) };
    }
  });

  secureHandle(IPC.PANE_DUEL_RESOLVE, async (_event, request: PaneDuelResolveRequest) => {
    log.info('ipc:pane', 'PANE_DUEL_RESOLVE invoked', { winnerPaneId: request.winnerPaneId });
    try {
      return await bridge.runProjectMutation(() => bridge.resolveDuel(request.winnerPaneId));
    } catch (error) {
      log.error('ipc:pane', 'PANE_DUEL_RESOLVE failed', error);
      return { success: false, error: formatError(error) };
    }
  });

  secureHandle(IPC.PANE_DUPLICATE, async (_event, request: PaneDuplicateRequest) => {
    log.info('ipc:pane', 'PANE_DUPLICATE invoked', { paneId: request.paneId });
    try {
      return await bridge.runProjectMutation(() => bridge.duplicatePane(request.paneId));
    } catch (error) {
      log.error('ipc:pane', 'PANE_DUPLICATE failed', error);
      return { success: false, error: formatError(error) };
    }
  });

  secureHandle(IPC.PANE_CREATE_WORKTREE, async (_event, request: PaneCreateWorktreeRequest) => {
    log.info('ipc:pane', 'PANE_CREATE_WORKTREE invoked', { paneId: request.paneId });
    try {
      return await bridge.runProjectMutation(() => bridge.createWorktreeForPaneAction(request.paneId));
    } catch (error) {
      log.error('ipc:pane', 'PANE_CREATE_WORKTREE failed', error);
      return { success: false, error: formatError(error) };
    }
  });

  secureHandle(IPC.PANE_ATTACH_WORKTREE, async (_event, request: PaneAttachWorktreeRequest) => {
    log.info('ipc:pane', 'PANE_ATTACH_WORKTREE invoked', { paneId: request.paneId, worktreePath: request.worktreePath });
    try {
      return await bridge.runProjectMutation(() => (
        bridge.attachWorktreeToPaneAction(request.paneId, request.worktreePath)
      ));
    } catch (error) {
      log.error('ipc:pane', 'PANE_ATTACH_WORKTREE failed', error);
      return { success: false, error: formatError(error) };
    }
  });

  secureHandle(IPC.PANE_START_REVIEW, async (_event, request: PaneStartReviewRequest) => {
    log.info('ipc:pane', 'PANE_START_REVIEW invoked', { paneId: request.paneId, agent: request.agent });
    if (!isReviewAgentEnabled()) {
      log.warn('ipc:pane', 'PANE_START_REVIEW blocked: feature disabled');
      return { success: false, error: REVIEW_AGENT_DISABLED_MESSAGE };
    }
    try {
      return await bridge.runProjectMutation(() => bridge.startReviewAction(request.paneId, request.agent));
    } catch (error) {
      log.error('ipc:pane', 'PANE_START_REVIEW failed', error);
      return { success: false, error: formatError(error) };
    }
  });

  secureHandle(IPC.PANE_SEND_FIX, async (_event, request: PaneSendFixRequest) => {
    log.info('ipc:pane', 'PANE_SEND_FIX invoked', { reviewPaneId: request.reviewPaneId });
    if (!isReviewAgentEnabled()) {
      log.warn('ipc:pane', 'PANE_SEND_FIX blocked: feature disabled');
      return { success: false, error: REVIEW_AGENT_DISABLED_MESSAGE };
    }
    try {
      return await bridge.runProjectMutation(() => bridge.startFixHandoffAction(request.reviewPaneId));
    } catch (error) {
      log.error('ipc:pane', 'PANE_SEND_FIX failed', error);
      return { success: false, error: formatError(error) };
    }
  });

  secureHandle(IPC.PANE_SESSION_LIST, async (_event, request: PaneSessionListRequest) => {
    log.debug('ipc:pane', 'PANE_SESSION_LIST invoked', { agent: request.agent, limit: request.limit });
    const projectRoot = await authorizeProjectRoot(request.projectRoot, bridge.getProjectRoot(), bridge.getPanes());
    return bridge.listPaneSessions(request.agent, projectRoot ?? bridge.getProjectRoot(), request.limit);
  });
}
