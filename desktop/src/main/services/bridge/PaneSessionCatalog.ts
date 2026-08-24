import { execFile } from 'node:child_process';
import { assertNever, type AgentName } from 'aumx/core';
import type { PaneSessionListResponse, PastSession } from '../../../shared/ipc-types.js';
import { formatError } from '../../utils/formatError.js';
import { listClaudeSessions } from '../agent-session/ClaudeSessionLister.js';
import { listCodexSessions } from '../agent-session/CodexSessionLister.js';
import { listPiSessions } from '../agent-session/PiSessionLister.js';
import { SESSION_UNTITLED, applySessionLimit, truncateTitle } from '../agent-session/session-list-constants.js';
import { OpencodeLogParser } from '../parsing/OpencodeLogParser.js';
import { isOpencodeDefaultTitle } from '../parsing/opencode-titles.js';

interface OpencodeSessionRow {
  id: string;
  title?: string;
  updated?: number;
}

function isOpencodeSessionRow(value: unknown): value is OpencodeSessionRow {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return typeof row.id === 'string'
    && row.id.trim().length > 0
    && (row.title === undefined || typeof row.title === 'string')
    && (row.updated === undefined
      || typeof row.updated === 'number' && Number.isFinite(row.updated));
}

interface PaneSessionCatalogDependencies {
  listClaude(projectRoot: string, limit?: number): Promise<PaneSessionListResponse>;
  listCodex(limit?: number): PaneSessionListResponse;
  listOpencodeRows(cwd: string): Promise<unknown>;
  listPi(projectRoot: string, limit?: number): Promise<PaneSessionListResponse>;
  rescueOpencodeTitles(cwd: string, sessionIds: string[]): Promise<Map<string, string>>;
}

const defaultDependencies: PaneSessionCatalogDependencies = {
  listClaude: listClaudeSessions,
  listCodex: listCodexSessions,
  listOpencodeRows: (cwd) => new Promise((resolve) => {
    execFile(
      'opencode',
      ['session', 'list', '--format', 'json'],
      { cwd, encoding: 'utf-8', timeout: 8000, env: { ...process.env, OPENCODE_DISABLE_AUTOUPDATE: '1' } },
      (error, stdout) => {
        if (error || !stdout.trim()) {
          resolve([]);
          return;
        }
        try {
          resolve(JSON.parse(stdout) as unknown);
        } catch {
          resolve([]);
        }
      },
    );
  }),
  listPi: listPiSessions,
  rescueOpencodeTitles: (cwd, sessionIds) => (
    new OpencodeLogParser().getFirstUserMessageTexts(cwd, sessionIds)
  ),
};

export class PaneSessionCatalog {
  constructor(private readonly dependencies: PaneSessionCatalogDependencies = defaultDependencies) {}

  async list(
    agent: AgentName,
    projectRoot: string,
    limit?: number,
  ): Promise<PaneSessionListResponse> {
    try {
      switch (agent) {
        case 'claude':
          return await this.dependencies.listClaude(projectRoot, limit);
        case 'codex':
          return this.dependencies.listCodex(limit);
        case 'opencode':
          return await this.listOpencode(projectRoot, limit);
        case 'pi':
          return await this.dependencies.listPi(projectRoot, limit);
        default:
          return assertNever(agent);
      }
    } catch (error) {
      return { sessions: [], error: formatError(error) };
    }
  }

  private async listOpencode(cwd: string, limit?: number): Promise<PaneSessionListResponse> {
    const parsed = await this.dependencies.listOpencodeRows(cwd);
    if (!Array.isArray(parsed)) return { sessions: [], total: 0 };
    const rows = parsed.filter(isOpencodeSessionRow);
    return {
      sessions: await this.toOpencodeSessions(cwd, applySessionLimit(rows, limit)),
      total: rows.length,
    };
  }

  private async toOpencodeSessions(cwd: string, rows: OpencodeSessionRow[]): Promise<PastSession[]> {
    const placeholders = rows.filter((row) => isOpencodeDefaultTitle(row.title));
    const rescued = placeholders.length > 0
      ? await this.dependencies.rescueOpencodeTitles(
        cwd,
        placeholders.map((row) => row.id),
      ).catch(() => new Map<string, string>())
      : new Map<string, string>();

    return rows.map((row) => {
      const rawTitle = row.title?.trim();
      if (!isOpencodeDefaultTitle(rawTitle) && rawTitle) {
        return { id: row.id, title: truncateTitle(rawTitle), updatedAt: row.updated ?? 0 };
      }
      const fallback = rescued.get(row.id);
      return {
        id: row.id,
        title: fallback ? truncateTitle(fallback) : SESSION_UNTITLED,
        updatedAt: row.updated ?? 0,
      };
    });
  }
}
