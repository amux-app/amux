import {
  AGENT_TERMINAL_ENVIRONMENT,
  AGENT_TERMINAL_ENV_UNSETS,
  execAsync,
  shQuote,
} from 'aumx/core';
import type { ThemeMode } from '../../shared/theme-mode.js';
import { getTerminalThemeMode } from '../services/app-theme.js';
import { log } from '../services/Logger.js';

export interface TmuxSessionResult {
  sessionName: string;
  paneId: string;
  created: boolean;
}

const MAX_SUFFIX = 99;
const PROJECT_ROOT_OPTION = '@aumx_project_root';
const TMUX_HISTORY_LIMIT = 50000;

// TUIs that probe COLORFGBG read it as "<foreground>;<background>" ANSI indices.
const COLORFGBG_BY_THEME_MODE: Record<ThemeMode, string> = {
  dark: '15;0',
  light: '0;15',
};

/**
 * Agents inherit COLORFGBG from the session environment at launch, so every
 * theme change has to re-publish it for panes created before the next ensure.
 */
export async function publishSessionColorHint(sessionName: string): Promise<void> {
  if (!sessionName) return;
  await execAsync(
    `tmux set-environment -t ${shQuote(sessionName)} COLORFGBG ${shQuote(COLORFGBG_BY_THEME_MODE[getTerminalThemeMode()])}`,
    { silent: true },
  ).catch(() => {});
}

function parseTmuxOptionValue(output: string, optionName: string): string {
  const value = output.trim();
  const prefix = `${optionName} `;
  return value.startsWith(prefix) ? value.slice(prefix.length).trim() : value;
}

async function tmuxSessionExists(name: string): Promise<boolean> {
  try {
    await execAsync(`tmux has-session -t ${shQuote(name)}`, { silent: true });
    return true;
  } catch {
    return false;
  }
}

async function getSessionProjectRoot(sessionName: string): Promise<string | null> {
  try {
    const root = await execAsync(
      `tmux show -t ${shQuote(sessionName)} ${PROJECT_ROOT_OPTION}`,
      { silent: true },
    );
    return parseTmuxOptionValue(root, PROJECT_ROOT_OPTION) || null;
  } catch {
    return null;
  }
}

async function queryFirstPaneId(sessionName: string): Promise<string | null> {
  try {
    const output = await execAsync(
      `tmux list-panes -t ${shQuote(sessionName)} -F "#{pane_id}"`,
      { silent: true },
    );
    const ids = output.split('\n').filter(Boolean);
    return ids[0] || null;
  } catch {
    return null;
  }
}

async function setSessionMetadata(
  sessionName: string,
  projectRoot: string,
  projectName: string,
): Promise<void> {
  const quotedSessionName = shQuote(sessionName);
  await Promise.all([
    execAsync(`tmux set-option -t ${quotedSessionName} window-size manual`, { silent: true }),
    execAsync(`tmux set-option -t ${quotedSessionName} history-limit ${TMUX_HISTORY_LIMIT}`, { silent: true }),
    execAsync(`tmux set -t ${quotedSessionName} @aumx_project_root ${shQuote(projectRoot)}`),
    execAsync(`tmux set -t ${quotedSessionName} @aumx_project_name ${shQuote(projectName)}`),
    ...AGENT_TERMINAL_ENV_UNSETS.map((name) => execAsync(
      `tmux set-environment -t ${quotedSessionName} -r ${name}`,
      { silent: true },
    )),
    ...AGENT_TERMINAL_ENVIRONMENT.map(([name, value]) => execAsync(
      `tmux set-environment -t ${quotedSessionName} ${name} ${shQuote(value)}`,
      { silent: true },
    )),
    publishSessionColorHint(sessionName),
  ]).catch(() => {});
}

async function createSession(sessionName: string, projectRoot: string, projectName: string): Promise<string> {
  const output = await execAsync(
    `tmux new-session -d -s ${shQuote(sessionName)} -c ${shQuote(projectRoot)} -P -F '#{pane_id}'`,
  );
  const paneId = output.trim();
  if (!paneId) {
    throw new Error(`Failed to create tmux session '${sessionName}': no pane ID returned`);
  }

  await setSessionMetadata(sessionName, projectRoot, projectName);
  return paneId;
}

async function findAvailableSessionName(baseName: string): Promise<string> {
  let existing: Set<string>;
  try {
    const output = await execAsync('tmux list-sessions -F "#{session_name}"', { silent: true });
    existing = new Set(output.split('\n').filter(Boolean));
  } catch {
    existing = new Set();
  }

  for (let i = 1; i <= MAX_SUFFIX; i++) {
    const candidate = `${baseName}_${String(i).padStart(2, '0')}`;
    if (!existing.has(candidate)) return candidate;
  }
  throw new Error(`No available session name for '${baseName}' (tried _01 through _${MAX_SUFFIX})`);
}

async function findExistingSessionForRoot(baseName: string, projectRoot: string): Promise<string | null> {
  let sessions: string[];
  try {
    const output = await execAsync('tmux list-sessions -F "#{session_name}"', { silent: true });
    sessions = output.split('\n').filter(Boolean);
  } catch {
    return null;
  }

  const escapedBase = baseName.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
  const suffixPattern = new RegExp(String.raw`^${escapedBase}(_\d{2})?$`);
  const candidates = sessions.filter((s) => suffixPattern.test(s));

  for (const candidate of candidates) {
    const root = await getSessionProjectRoot(candidate);
    if (root === projectRoot) return candidate;
  }
  return null;
}

export async function ensureTmuxSession(
  desiredName: string,
  projectRoot: string,
  projectName: string,
): Promise<TmuxSessionResult> {
  // Always check first whether ANY existing session is already tagged for this
  // projectRoot — even if the desired name is free. Without this, two concurrent
  // calls (e.g. WORKSPACE_CREATE_SESSION + bridge.switchProject) racing on the
  // same root can each create their own session and we end up with duplicates.
  const existingForRoot = await findExistingSessionForRoot(desiredName, projectRoot);
  if (existingForRoot) {
    log.info('tmux-session', 'Reusing existing session for project root', {
      sessionName: existingForRoot,
      projectRoot,
    });
    await setSessionMetadata(existingForRoot, projectRoot, projectName);
    const paneId = await queryFirstPaneId(existingForRoot);
    if (paneId) {
      return { sessionName: existingForRoot, paneId, created: false };
    }
    log.warn('tmux-session', 'Session exists but has no panes, recreating', { sessionName: existingForRoot });
    await execAsync(`tmux kill-session -t ${shQuote(existingForRoot)}`, { silent: true }).catch(() => {});
    const newPaneId = await createSession(existingForRoot, projectRoot, projectName);
    return { sessionName: existingForRoot, paneId: newPaneId, created: true };
  }

  const exists = await tmuxSessionExists(desiredName);

  if (exists) {
    const storedRoot = await getSessionProjectRoot(desiredName);

    if (storedRoot === projectRoot || !storedRoot) {
      log.info('tmux-session', 'Reusing existing session', { sessionName: desiredName, projectRoot });

      await setSessionMetadata(desiredName, projectRoot, projectName);

      const paneId = await queryFirstPaneId(desiredName);
      if (paneId) {
        return { sessionName: desiredName, paneId, created: false };
      }

      log.warn('tmux-session', 'Session exists but has no panes, recreating', { sessionName: desiredName });
      await execAsync(`tmux kill-session -t ${shQuote(desiredName)}`, { silent: true }).catch(() => {});
      const newPaneId = await createSession(desiredName, projectRoot, projectName);
      return { sessionName: desiredName, paneId: newPaneId, created: true };
    }

    log.info('tmux-session', 'Session name taken by different project, allocating suffix', {
      desiredName,
      storedRoot,
      projectRoot,
    });
    const suffixedName = await findAvailableSessionName(desiredName);
    const paneId = await createSession(suffixedName, projectRoot, projectName);
    return { sessionName: suffixedName, paneId, created: true };
  }

  log.info('tmux-session', 'Creating new session', { sessionName: desiredName, projectRoot });
  const paneId = await createSession(desiredName, projectRoot, projectName);
  return { sessionName: desiredName, paneId, created: true };
}
