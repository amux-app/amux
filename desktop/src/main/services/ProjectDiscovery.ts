import { existsSync, readFileSync, statSync } from 'fs';
import { basename, isAbsolute, relative, resolve } from 'path';
import { execAsync, getProjectConfigPath, shQuote, type MuxBaseConfig } from 'muxbase/core';
import type { ProjectInfo } from '../../shared/ipc-types.js';
import { isTerminalPtyViewSessionName } from './terminal-pty-session.js';

export interface CurrentProjectInfo {
  sessionName: string;
  projectName: string;
  projectRoot: string;
}

export async function discoverCurrentProject(): Promise<CurrentProjectInfo | null> {
  if (process.env.MUXBASE_E2E === '1') return null;

  try {
    const sessionList = await execAsync(
      'tmux list-sessions -F "#{session_name}"',
      { silent: true },
    );

    const muxbaseSessions = sessionList
      .split('\n')
      .filter((s) => isMuxBaseProjectSessionName(s));

    const projects = (await Promise.all(muxbaseSessions.map(resolveProjectInfo)))
      .filter((project): project is ProjectInfo => project !== null);

    const preferred = chooseCurrentProject(projects);
    if (!preferred) return null;

    return {
      sessionName: preferred.sessionName,
      projectName: preferred.name,
      projectRoot: preferred.root,
    };
  } catch {
    return null;
  }
}

export async function discoverProjects(): Promise<ProjectInfo[]> {
  const byRoot = new Map<string, ProjectInfo>();

  try {
    const sessionList = await execAsync(
      'tmux list-sessions -F "#{session_name}"',
      { silent: true },
    );

    const muxbaseSessions = sessionList
      .split('\n')
      .filter((s) => isMuxBaseProjectSessionName(s));

    // Resolve sessions concurrently, then fold results in original session order
    // so the preferSession dedupe stays deterministic.
    const resolved = await Promise.all(muxbaseSessions.map(resolveProjectInfo));

    for (const info of resolved) {
      if (!info) continue;
      // Dedupe by root: if multiple tmux sessions point to the same project root,
      // surface only the canonical one (no _NN suffix wins over a suffixed one).
      const existing = byRoot.get(info.root);
      if (!existing || preferSession(info.sessionName, existing.sessionName)) {
        byRoot.set(info.root, info);
      }
    }
  } catch {
    // tmux not running or no sessions
  }

  return Array.from(byRoot.values());
}

function isMuxBaseProjectSessionName(sessionName: string): boolean {
  return sessionName.startsWith('muxbase-') && !isTerminalPtyViewSessionName(sessionName);
}

function preferSession(candidate: string, current: string): boolean {
  const candidateSuffixed = /_\d{2}$/.test(candidate);
  const currentSuffixed = /_\d{2}$/.test(current);
  if (candidateSuffixed === currentSuffixed) return false;
  return !candidateSuffixed;
}

async function resolveProjectInfo(sessionName: string): Promise<ProjectInfo | null> {
  let projectRoot = '';
  let projectName = sessionName.replace('muxbase-', '');

  // Try session metadata first
  try {
    const root = await execAsync(
      `tmux show -t ${shQuote(sessionName)} @muxbase_project_root`,
      { silent: true },
    );
    if (root) {
      projectRoot = root.replace(/^@muxbase_project_root\s+/, '').trim();
    }
  } catch {
    // Not set
  }

  if (!projectRoot) {
    try {
      const name = await execAsync(
        `tmux show -t ${shQuote(sessionName)} @muxbase_project_name`,
        { silent: true },
      );
      if (name) {
        projectName = name.replace(/^@muxbase_project_name\s+/, '').trim();
      }
    } catch {
      // Not set
    }
  }

  // Fallback: get pane cwd
  if (!projectRoot) {
    try {
      const cwd = await execAsync(
        `tmux display-message -t ${shQuote(sessionName)} -p "#{pane_current_path}"`,
        { silent: true },
      );
      if (cwd) projectRoot = cwd.trim();
    } catch {
      return null;
    }
  }

  if (!isUsableProjectRoot(projectRoot)) return null;

  const configPath = getProjectConfigPath(projectRoot);
  let paneCount = 0;

  if (existsSync(configPath)) {
    try {
      const raw = readFileSync(configPath, 'utf-8');
      const config: MuxBaseConfig = JSON.parse(raw);
      paneCount = config.panes?.length || 0;
      if (config.projectName) projectName = config.projectName;
    } catch {
      // Corrupt config
    }
  }

  return {
    name: projectName || basename(projectRoot),
    root: projectRoot,
    sessionName,
    configPath,
    paneCount,
  };
}

function isUsableProjectRoot(projectRoot: string): boolean {
  if (!projectRoot) return false;
  try {
    return existsSync(projectRoot) && statSync(projectRoot).isDirectory();
  } catch {
    return false;
  }
}

function chooseCurrentProject(projects: ProjectInfo[]): ProjectInfo | null {
  if (projects.length === 0) return null;

  const cwd = resolve(process.cwd());
  const exactMatch = projects.find((project) => resolve(project.root) === cwd);
  if (exactMatch) return exactMatch;

  const containingProject = projects
    .filter((project) => {
      const rel = relative(resolve(project.root), cwd);
      return rel === '' || (!!rel && !rel.startsWith('..') && !isAbsolute(rel));
    })
    .sort((a, b) => resolve(b.root).length - resolve(a.root).length)[0];

  return containingProject ?? projects[0];
}
