import type { ProjectInfo, ProjectSwitchRequest, ProjectSwitchResponse, SessionInfoResult } from '../../shared/ipc-types';
import { IPC } from '../../shared/ipc-channels';
import { invoke } from './ipc';

export function listProjects(): Promise<ProjectInfo[]> {
  return invoke<ProjectInfo[]>(IPC.PROJECT_LIST);
}

export function switchProject(req: ProjectSwitchRequest): Promise<ProjectSwitchResponse> {
  return invoke<ProjectSwitchResponse>(IPC.PROJECT_SWITCH, req);
}

export function getSessionInfo(): Promise<SessionInfoResult> {
  return invoke<SessionInfoResult>(IPC.SESSION_INFO);
}
