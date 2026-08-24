import { existsSync, readdirSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

// Codex writes user content twice in a rollout: `response_item` (raw model-API
// payload that includes injected AGENTS.md / <environment_context>) and
// `event_msg` with payload.type === 'user_message' (the real typed input).
// Native `codex resume` uses ONLY the latter for the picker label — we match.
// Reference: openai/codex codex-rs/rollout/src/list.rs::event_msg_preview.

const CODEX_SESSIONS_DIR = join(homedir(), '.codex', 'sessions');
const MS_PER_DAY = 86_400_000;
const MAX_LINES_SCANNED = 500;

function candidateDirs(updatedAtMs: number): string[] {
  const timestamps = updatedAtMs > 0
    ? [updatedAtMs - MS_PER_DAY, updatedAtMs, updatedAtMs + MS_PER_DAY]
    : [Date.now()];
  const dirs = new Set<string>();
  for (const ts of timestamps) {
    const d = new Date(ts);
    const year = String(d.getFullYear());
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    const path = join(CODEX_SESSIONS_DIR, year, month, day);
    if (existsSync(path)) dirs.add(path);
  }
  return [...dirs];
}

function findRolloutFile(sessionId: string, updatedAtMs: number): string | null {
  const suffix = `-${sessionId}.jsonl`;
  for (const dir of candidateDirs(updatedAtMs)) {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    const match = names.find((n) => n.endsWith(suffix));
    if (match) return join(dir, match);
  }
  return null;
}

function extractUserMessage(entry: Record<string, unknown>): string | null {
  if (entry.type !== 'event_msg') return null;
  const payload = entry.payload as Record<string, unknown> | undefined;
  if (!payload || payload.type !== 'user_message') return null;
  const message = payload.message;
  if (typeof message !== 'string') return null;
  const trimmed = message.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function extractThreadGoal(entry: Record<string, unknown>): string | null {
  if (entry.type !== 'event_msg') return null;
  const payload = entry.payload as Record<string, unknown> | undefined;
  if (!payload || payload.type !== 'thread_goal_updated') return null;
  const goal = payload.goal as Record<string, unknown> | undefined;
  const objective = goal?.objective;
  if (typeof objective !== 'string') return null;
  const trimmed = objective.trim();
  return trimmed.length > 0 ? trimmed : null;
}

// Returns the first real typed user message from the matching rollout file,
// or the first thread goal objective as a secondary fallback. Reads at most
// MAX_LINES_SCANNED lines for the picker — full-content parsing is in
// CodexLogParser; we only need a label here.
export function extractCodexRolloutPreview(sessionId: string, updatedAtMs: number): string | null {
  const filePath = findRolloutFile(sessionId, updatedAtMs);
  if (!filePath) return null;

  let content: string;
  try {
    content = readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }

  const lines = content.split('\n');
  let goalFallback: string | null = null;
  const limit = Math.min(lines.length, MAX_LINES_SCANNED);
  for (let i = 0; i < limit; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const userMessage = extractUserMessage(entry);
    if (userMessage) return userMessage;
    if (!goalFallback) {
      const goal = extractThreadGoal(entry);
      if (goal) goalFallback = goal;
    }
  }
  return goalFallback;
}
