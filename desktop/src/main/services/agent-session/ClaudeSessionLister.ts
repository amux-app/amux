import { existsSync } from 'fs';
import { open, type FileHandle } from 'fs/promises';
import { basename } from 'path';
import type { PastSession } from '../../../shared/ipc-types.js';
import { CLAUDE_TITLE_HEAD_SCAN_BYTES, CLAUDE_TITLE_TAIL_SCAN_BYTES } from '../parsing/claude-scan-limits.js';
import { resolveClaudeProjectDir } from '../parsing/claude-session-dir.js';
import { cleanClaudeTitle, extractAiTitle } from '../parsing/claude-titles.js';
import { readRegionLines } from '../parsing/file-regions.js';
import { asRecord, getString, parseJsonRecord, type JsonRecord } from '../parsing/jsonl-values.js';
import {
  JSONL_EXTENSION,
  listSessionFilesByMtime,
  type SessionFileStat,
} from '../parsing/session-files.js';
import {
  SESSION_UNTITLED,
  applySessionLimit,
  isInjectedHarnessText,
  truncateTitle,
  type SessionListing,
} from './session-list-constants.js';

const ENTRY_LAST_PROMPT = 'last-prompt';
const ENTRY_SUMMARY = 'summary';
const ENTRY_USER = 'user';
const PROMPT_SOURCE_TYPED = 'typed';

interface TitleCandidates {
  sessionId: string | null;
  aiTitle: string | null;
  lastPrompt: string | null;
  summary: string | null;
  typedUserMessage: string | null;
  firstUserMessage: string | null;
}

function sanitizeStored(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || isInjectedHarnessText(trimmed)) return null;
  return trimmed;
}

function cleanStoredTitle(raw: string): string | null {
  const stored = sanitizeStored(raw);
  return stored ? cleanClaudeTitle(stored) : null;
}

/** First text block a user entry carries that is real input rather than injected context. */
function extractUserText(content: unknown): string | null {
  if (typeof content === 'string') return sanitizeStored(content);
  if (!Array.isArray(content)) return null;

  for (const block of content) {
    const record = asRecord(block);
    if (record?.type !== 'text') continue;
    const text = sanitizeStored(record.text);
    if (text) return text;
  }
  return null;
}

function applyUserEntry(entry: JsonRecord, acc: TitleCandidates): void {
  const text = extractUserText(asRecord(entry.message)?.content);
  if (!text) return;
  if (!acc.typedUserMessage && entry.promptSource === PROMPT_SOURCE_TYPED) acc.typedUserMessage = text;
  if (!acc.firstUserMessage) acc.firstUserMessage = text;
}

/**
 * `fromFileStart` marks a chunk that begins at byte 0: the first-user-message and
 * legacy-summary fallbacks are only meaningful there, while `ai-title` / `last-prompt`
 * are rewritten as the session evolves so the latest one seen wins.
 */
function applyEntry(entry: JsonRecord, acc: TitleCandidates, fromFileStart: boolean): void {
  if (!acc.sessionId) acc.sessionId = getString(entry.sessionId) ?? null;

  const aiTitle = extractAiTitle(entry);
  if (aiTitle) {
    acc.aiTitle = cleanStoredTitle(aiTitle) ?? acc.aiTitle;
    return;
  }
  if (entry.type === ENTRY_LAST_PROMPT) {
    acc.lastPrompt = sanitizeStored(entry.lastPrompt) ?? acc.lastPrompt;
    return;
  }
  if (!fromFileStart) return;
  if (entry.type === ENTRY_SUMMARY) {
    acc.summary ??= sanitizeStored(entry.summary);
    return;
  }
  if (entry.type === ENTRY_USER) applyUserEntry(entry, acc);
}

function scanChunk(lines: string[], acc: TitleCandidates, fromFileStart: boolean): void {
  for (const line of lines) {
    const entry = parseJsonRecord(line);
    if (entry) applyEntry(entry, acc, fromFileStart);
  }
}

/**
 * Reads at most two bounded windows of a session file instead of the whole thing:
 * the tail holds the title Claude itself would show, and the head is only touched
 * when the tail carried no title at all.
 */
async function readTitleCandidates(file: SessionFileStat): Promise<TitleCandidates | null> {
  let handle: FileHandle;
  try {
    handle = await open(file.path, 'r');
  } catch {
    return null;
  }

  try {
    const tailStart = Math.max(0, file.size - CLAUDE_TITLE_TAIL_SCAN_BYTES);
    const acc: TitleCandidates = {
      sessionId: null,
      aiTitle: null,
      lastPrompt: null,
      summary: null,
      typedUserMessage: null,
      firstUserMessage: null,
    };

    scanChunk(await readRegionLines(handle, tailStart, file.size), acc, tailStart === 0);
    if (tailStart > 0 && !acc.aiTitle && !acc.lastPrompt) {
      scanChunk(await readRegionLines(handle, 0, CLAUDE_TITLE_HEAD_SCAN_BYTES), acc, true);
    }
    return acc;
  } finally {
    await handle.close();
  }
}

/**
 * Title precedence mirrors Claude Code itself:
 *   latest ai-title → latest last-prompt → legacy summary → first typed prompt
 *   → first user message → Untitled.
 */
async function readSession(file: SessionFileStat): Promise<PastSession | null> {
  const acc = await readTitleCandidates(file);
  if (!acc) return null;

  const picked = acc.aiTitle ?? acc.lastPrompt ?? acc.summary ?? acc.typedUserMessage ?? acc.firstUserMessage;
  return {
    id: acc.sessionId ?? basename(file.path, JSONL_EXTENSION),
    title: picked ? truncateTitle(picked) : SESSION_UNTITLED,
    updatedAt: file.mtimeMs,
  };
}

/**
 * Lists the project's Claude sessions newest-first. `limit` bounds how many files
 * are opened, so the create-pane dialog only pays for the rows it shows first.
 */
export async function listClaudeSessions(projectRoot: string, limit?: number): Promise<SessionListing> {
  const dir = resolveClaudeProjectDir(projectRoot);
  if (!existsSync(dir)) return { sessions: [], total: 0 };

  const files = await listSessionFilesByMtime(dir);
  const read = await Promise.all(applySessionLimit(files, limit).map(readSession));

  return {
    sessions: read.filter((session): session is PastSession => session !== null),
    total: files.length,
  };
}
