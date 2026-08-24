import { execAsync, shQuote } from 'aumx/core';

const MAX_VIEW_SESSION_NAME_LENGTH = 80;

export function isTerminalPtyViewSessionName(sessionName: string): boolean {
  return /--view-[A-Za-z0-9_-]+$/.test(sessionName);
}

export async function cleanupDetachedTerminalPtyViewSessions(
  exec: typeof execAsync = execAsync,
): Promise<number> {
  // '|' as separator: tmux sanitizes control characters (incl. tabs) to '_'
  // in list-sessions output, so tab-separated formats can never be parsed.
  const sessionList = await exec(
    'tmux list-sessions -F "#{session_name}|#{session_attached}|#{@aumx_view_session}"',
    { silent: true },
  );
  // Both the Amux marker option and the name pattern are required before a
  // session is killed: the name alone could match a user-created session.
  // A foreign session name containing '|' shifts the fields and fails the
  // marker check, which is the safe direction.
  const detachedViewSessions = sessionList
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      const [sessionName, attachedCount, viewMarker] = line.split('|');
      if (!sessionName || viewMarker !== '1' || !isTerminalPtyViewSessionName(sessionName)) return [];
      return Number.parseInt(attachedCount ?? '0', 10) === 0 ? [sessionName] : [];
    });

  for (const sessionName of detachedViewSessions) {
    await exec(`tmux kill-session -t ${shQuote(`=${sessionName}`)}`, { silent: true });
  }

  return detachedViewSessions.length;
}

export function makeTerminalPtyViewSessionName(sessionName: string, paneId: string): string {
  const base = sanitizeTmuxSessionNamePart(sessionName, 'aumx').slice(0, 48);
  const pane = sanitizeTmuxSessionNamePart(paneId, 'pane');
  const prefix = `${base}--view-`;
  const availablePaneChars = MAX_VIEW_SESSION_NAME_LENGTH - prefix.length;
  const boundedPane = pane.length > availablePaneChars ? pane.slice(0, availablePaneChars) : pane;
  return `${prefix}${boundedPane}`;
}

function sanitizeTmuxSessionNamePart(value: string, fallback: string): string {
  const sanitized = value
    .trim()
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
  return sanitized || fallback;
}
