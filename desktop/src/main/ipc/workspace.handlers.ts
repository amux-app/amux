import { getProjectConfigPath } from 'aumx/core';
import { dialog } from 'electron';
import { existsSync } from 'fs';
import { basename } from 'path';
import { IPC } from '../../shared/ipc-channels.js';
import type {
  ProjectInfo,
  WorkspaceCreateSessionRequest,
  WorkspaceCreateSessionResponse,
  WorkspaceHistoryRemoveRequest,
  WorkspaceHistoryTouchRequest,
  WorkspaceNewProjectResponse,
  WorkspaceOpenFolderResponse,
} from '../../shared/ipc-types.js';
import { log } from '../services/Logger.js';
import { discoverProjects } from '../services/ProjectDiscovery.js';
import {
  approveProjectRoot,
  isApprovedProjectRoot,
  UNAUTHORIZED_PROJECT_ROOT_ERROR,
} from '../services/projectRootAuthorization.js';
import { WorkspaceHistoryService } from '../services/WorkspaceHistoryService.js';
import { formatError } from '../utils/formatError.js';
import { ensureTmuxSession } from '../utils/tmuxSession.js';
import { secureHandle } from './ipc-security.js';

function resolveProjectFromDiscovery(
  projects: ProjectInfo[],
  folderPath: string,
  sessionName: string,
): ProjectInfo | undefined {
  return projects.find((project) => project.root === folderPath && project.sessionName === sessionName)
    ?? projects.find((project) => project.root === folderPath);
}

export function registerWorkspaceHandlers(): void {
  const history = WorkspaceHistoryService.getInstance();

  secureHandle(IPC.WORKSPACE_HISTORY_LIST, async () => {
    try {
      return history.getAll();
    } catch (error) {
      log.error('ipc:workspace', 'HISTORY_LIST failed', error);
      return { error: formatError(error) };
    }
  });

  secureHandle(IPC.WORKSPACE_HISTORY_TOUCH, async (_event, request: WorkspaceHistoryTouchRequest) => {
    try {
      if (!(await isApprovedProjectRoot(request.root))) {
        log.warn('ipc:workspace', 'HISTORY_TOUCH skipped an unapproved root', { root: request.root });
        return history.getAll();
      }
      return history.touch(request);
    } catch (error) {
      log.error('ipc:workspace', 'HISTORY_TOUCH failed', error);
      return { error: formatError(error) };
    }
  });

  secureHandle(IPC.WORKSPACE_HISTORY_REMOVE, async (_event, request: WorkspaceHistoryRemoveRequest) => {
    try {
      return history.remove(request.root);
    } catch (error) {
      log.error('ipc:workspace', 'HISTORY_REMOVE failed', error);
      return { error: formatError(error) };
    }
  });

  secureHandle(IPC.WORKSPACE_OPEN_FOLDER, async (): Promise<WorkspaceOpenFolderResponse> => {
    try {
      const result = await dialog.showOpenDialog({
        properties: ['openDirectory'],
        title: 'Open Project Folder',
      });
      if (result.canceled || result.filePaths.length === 0) {
        return { canceled: true };
      }
      approveProjectRoot(result.filePaths[0]);
      return { canceled: false, path: result.filePaths[0] };
    } catch (error) {
      log.error('ipc:workspace', 'OPEN_FOLDER failed', error);
      return { canceled: true };
    }
  });

  secureHandle(IPC.WORKSPACE_NEW_PROJECT, async (): Promise<WorkspaceNewProjectResponse> => {
    try {
      const result = await dialog.showOpenDialog({
        title: 'New Project',
        buttonLabel: 'Create',
        properties: ['openDirectory', 'createDirectory'],
      });
      if (result.canceled || result.filePaths.length === 0) {
        return { canceled: true };
      }
      approveProjectRoot(result.filePaths[0]);
      return { canceled: false, path: result.filePaths[0] };
    } catch (error) {
      log.error('ipc:workspace', 'NEW_PROJECT failed', error);
      return { canceled: false, error: formatError(error) };
    }
  });

  secureHandle(
    IPC.WORKSPACE_CREATE_SESSION,
    async (_event, request: WorkspaceCreateSessionRequest): Promise<WorkspaceCreateSessionResponse> => {
      const { folderPath } = request;
      log.info('ipc:workspace', 'CREATE_SESSION', { folderPath });

      try {
        if (!existsSync(folderPath)) {
          return { success: false, error: `Folder does not exist: ${folderPath}` };
        }
        if (!(await isApprovedProjectRoot(folderPath))) {
          log.warn('ipc:workspace', 'CREATE_SESSION rejected an unapproved folder', { folderPath });
          return { success: false, error: UNAUTHORIZED_PROJECT_ROOT_ERROR };
        }

        const projectName = basename(folderPath);
        const sessionName = `aumx-${projectName}`;
        const session = await ensureTmuxSession(sessionName, folderPath, projectName);
        const discoveredProject = resolveProjectFromDiscovery(
          await discoverProjects(),
          folderPath,
          session.sessionName,
        );

        const project: ProjectInfo = {
          name: discoveredProject?.name ?? projectName,
          root: folderPath,
          sessionName: session.sessionName,
          configPath: discoveredProject?.configPath ?? getProjectConfigPath(folderPath),
          paneCount: discoveredProject?.paneCount ?? 0,
        };

        history.touch({ name: project.name, root: project.root, paneCount: project.paneCount });

        log.info('ipc:workspace', 'Session ready', {
          created: session.created,
          folderPath,
          sessionName: session.sessionName,
        });
        return { success: true, project };
      } catch (error) {
        log.error('ipc:workspace', 'CREATE_SESSION failed', error);
        return { success: false, error: formatError(error) };
      }
    },
  );
}
