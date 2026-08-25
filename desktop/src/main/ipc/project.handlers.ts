import { IPC } from '../../shared/ipc-channels.js';
import type { ProjectFileSearchRequest, ProjectInfo, ProjectSwitchRequest, ProjectTextSearchRequest } from '../../shared/ipc-types.js';
import type { MuxBaseBridge } from '../services/MuxBaseBridge.js';
import { discoverProjects } from '../services/ProjectDiscovery.js';
import { isApprovedProjectRoot, UNAUTHORIZED_PROJECT_ROOT_ERROR } from '../services/projectRootAuthorization.js';
import { projectSearchService, resolveProjectSearchRoot } from '../services/ProjectSearchService.js';
import { WorkspaceHistoryService } from '../services/WorkspaceHistoryService.js';
import { log } from '../services/Logger.js';
import { formatError } from '../utils/formatError.js';
import { secureHandle } from './ipc-security.js';

function mergeWithBridgeProject(projects: ProjectInfo[], bridge: MuxBaseBridge): ProjectInfo[] {
  const root = bridge.getProjectRoot();
  if (!root) return projects;

  const bridgeProject: ProjectInfo = {
    name: bridge.getProjectName(),
    root,
    sessionName: bridge.getSessionName(),
    configPath: bridge.getConfigPath(),
    paneCount: bridge.getPanes().length,
  };

  const existingIndex = projects.findIndex((project) => project.root === root);
  if (existingIndex < 0) {
    return [bridgeProject, ...projects];
  }

  const next = [...projects];
  next[existingIndex] = {
    ...next[existingIndex],
    ...bridgeProject,
    paneCount: bridgeProject.paneCount,
  };
  return next;
}

export function registerProjectHandlers(bridge: MuxBaseBridge): void {
  secureHandle(IPC.PROJECT_LIST, async () => {
    try {
      const projects = mergeWithBridgeProject(await discoverProjects(), bridge);
      log.info('ipc:project', 'PROJECT_LIST', { count: projects.length });
      return projects;
    } catch (error) {
      log.error('ipc:project', 'PROJECT_LIST failed', error);
      return { error: formatError(error) };
    }
  });

  secureHandle(IPC.PROJECT_SWITCH, async (_event, request: ProjectSwitchRequest) => {
    log.info('ipc:project', 'PROJECT_SWITCH', { projectRoot: request.projectRoot });
    try {
      // A non-fresh switch to the active root is a no-op inside the bridge, so it
      // reaches nothing the renderer does not already have open.
      const isRedundantSwitch = request.fresh !== true && request.projectRoot === bridge.getProjectRoot();
      if (!isRedundantSwitch && !(await isApprovedProjectRoot(request.projectRoot))) {
        log.warn('ipc:project', 'PROJECT_SWITCH rejected an unapproved root', { projectRoot: request.projectRoot });
        return { error: UNAUTHORIZED_PROJECT_ROOT_ERROR };
      }

      await bridge.switchProject(request.projectRoot, { fresh: request.fresh === true });

      const project: ProjectInfo = {
        name: bridge.getProjectName(),
        root: bridge.getProjectRoot(),
        sessionName: bridge.getSessionName(),
        configPath: bridge.getConfigPath(),
        paneCount: bridge.getPanes().length,
      };

      WorkspaceHistoryService.getInstance().touch({
        name: project.name,
        root: project.root,
        paneCount: project.paneCount,
      });

      return { success: true, project };
    } catch (error) {
      log.error('ipc:project', 'PROJECT_SWITCH failed', error);
      return { error: formatError(error) };
    }
  });

  log.info('ipc:project', 'Search handlers registered', { channels: ['PROJECT_FILE_SEARCH', 'PROJECT_TEXT_SEARCH'] });

  secureHandle(IPC.PROJECT_FILE_SEARCH, async (_event, request: ProjectFileSearchRequest) => {
    try {
      const rootPath = resolveProjectSearchRoot(bridge.getProjectRoot(), bridge.getPanes(), request.rootPath);
      if (!rootPath) return [];
      return await projectSearchService.searchFiles(rootPath, request.query);
    } catch (error) {
      log.error('ipc:project', 'FILE_SEARCH failed', error);
      return [];
    }
  });

  secureHandle(IPC.PROJECT_TEXT_SEARCH, async (_event, request: ProjectTextSearchRequest) => {
    try {
      const rootPath = resolveProjectSearchRoot(bridge.getProjectRoot(), bridge.getPanes(), request.rootPath);
      if (!rootPath) return [];
      return await projectSearchService.searchText(rootPath, request.query);
    } catch (error) {
      log.error('ipc:project', 'TEXT_SEARCH failed', error);
      return [];
    }
  });
}
