import { GitCommit, ArrowUpRight, Loader2, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { NormalizedMessage, NormalizedSession } from '../../../shared/agent-session-types';
import { generateRecap } from '../../api/recap.api';
import { isRealUserPrompt } from '../../lib/conversation-turns';
import { formatSessionOffset } from '../../lib/formatters';
import { EmptyState } from '../shared/EmptyState';

const PROMPTS_PER_CHUNK = 5;

interface ConversationChunk {
  index: number;
  messages: NormalizedMessage[];
  promptCount: number;
  promptStart: number;
  promptEnd: number;
  startTime?: number;
  endTime?: number;
  commits: number;
  pushes: number;
}

function extractGitActivity(messages: NormalizedMessage[]): { commits: number; pushes: number } {
  let commits = 0;
  let pushes = 0;
  for (const msg of messages) {
    for (const tc of msg.toolCalls) {
      const input = JSON.stringify(tc.input).toLowerCase();
      if (tc.name.toLowerCase() === 'bash' || input.includes('command')) {
        if (input.includes('git commit') || input.includes('git -c') && input.includes('commit')) {
          commits++;
        }
        if (input.includes('git push')) {
          pushes++;
        }
      }
    }
  }
  return { commits, pushes };
}

function groupIntoChunks(session: NormalizedSession): ConversationChunk[] {
  const chunks: ConversationChunk[] = [];
  let promptsSeen = 0;
  let chunkMessages: NormalizedMessage[] = [];
  let chunkPromptStart = 1;
  let chunkIndex = 0;

  for (const msg of session.messages) {
    chunkMessages.push(msg);

    if (msg.type === 'user' && isRealUserPrompt(msg)) {
      promptsSeen++;

      if (promptsSeen > 0 && promptsSeen % PROMPTS_PER_CHUNK === 0) {
        const git = extractGitActivity(chunkMessages);
        chunks.push({
          index: chunkIndex,
          messages: chunkMessages,
          promptCount: PROMPTS_PER_CHUNK,
          promptStart: chunkPromptStart,
          promptEnd: chunkPromptStart + PROMPTS_PER_CHUNK - 1,
          startTime: chunkMessages[0]?.timestamp,
          endTime: chunkMessages.at(-1)?.timestamp,
          ...git,
        });
        chunkIndex++;
        chunkPromptStart = promptsSeen + 1;
        chunkMessages = [];
      }
    }
  }

  if (chunkMessages.length > 0) {
    const git = extractGitActivity(chunkMessages);
    chunks.push({
      index: chunkIndex,
      messages: chunkMessages,
      promptCount: promptsSeen - (chunkPromptStart - 1),
      promptStart: chunkPromptStart,
      promptEnd: promptsSeen,
      startTime: chunkMessages[0]?.timestamp,
      endTime: chunkMessages.at(-1)?.timestamp,
      ...git,
    });
  }

  return chunks;
}

function buildRecapInput(chunk: ConversationChunk): string[] {
  return chunk.messages
    .filter((m) => (m.type === 'user' || m.type === 'assistant') && m.content.trim())
    .filter((m) => m.type !== 'user' || isRealUserPrompt(m))
    .map((m) => `[${m.type}]: ${m.content.trim().slice(0, 1000)}`);
}

interface RecapsViewProps {
  session: NormalizedSession;
  paneId: string;
}

export function RecapsView({ session, paneId }: RecapsViewProps) {
  const chunks = useMemo(() => groupIntoChunks(session), [session]);
  const [summaries, setSummaries] = useState<Map<string, string>>(new Map());
  const [loading, setLoading] = useState<Set<string>>(new Set());
  const requestedRef = useRef<Set<string>>(new Set());

  const getChunkKey = useCallback((chunk: ConversationChunk) => {
    return `chunk-${chunk.index}`;
  }, []);

  const isClosedChunk = useCallback((chunk: ConversationChunk) => {
    return chunk.promptCount === PROMPTS_PER_CHUNK;
  }, []);

  const retry = useCallback((chunk: ConversationChunk) => {
    const key = getChunkKey(chunk);
    requestedRef.current.delete(key);
    setSummaries((prev) => { const next = new Map(prev); next.delete(key); return next; });
  }, [getChunkKey]);

  useEffect(() => {
    for (const chunk of chunks) {
      const key = getChunkKey(chunk);
      if (summaries.has(key) || requestedRef.current.has(key)) continue;
      if (!isClosedChunk(chunk)) continue;

      requestedRef.current.add(key);
      setLoading((prev) => new Set(prev).add(key));

      const messages = buildRecapInput(chunk);
      generateRecap({
        messages,
        paneId,
        chunkIndex: chunk.index,
      }).then((res) => {
        if (res.summary) {
          setSummaries((prev) => new Map(prev).set(key, res.summary));
        } else {
          setSummaries((prev) => new Map(prev).set(key, ''));
        }
        setLoading((prev) => {
          const next = new Set(prev);
          next.delete(key);
          return next;
        });
      }).catch(() => {
        setSummaries((prev) => new Map(prev).set(key, 'Summary unavailable'));
        setLoading((prev) => {
          const next = new Set(prev);
          next.delete(key);
          return next;
        });
      });
    }
  }, [chunks, getChunkKey, isClosedChunk, paneId, summaries]);

  if (chunks.length === 0) {
    return (
      <EmptyState
        title="No Recaps Yet"
        description="Auto-generated summaries appear here as the conversation grows."
        className="h-full"
      />
    );
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl px-4 py-4 space-y-3">
        {chunks.map((chunk) => {
          const key = getChunkKey(chunk);
          const summary = summaries.get(key);
          const isLoading = loading.has(key);
          const startLabel = formatSessionOffset(chunk.startTime, session.startTime);
          const endLabel = formatSessionOffset(chunk.endTime, session.startTime);
          const timeRange = startLabel && endLabel ? `${startLabel} – ${endLabel}` : startLabel || endLabel;

          return (
            <div
              key={key}
              className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-3 transition-colors hover:border-[var(--accent)]/30"
            >
              <div className="flex items-center gap-2 mb-2">
                <span className="text-[10px] font-semibold text-[var(--accent)] uppercase tracking-wider">
                  Recap #{chunk.index + 1}
                </span>
                {timeRange && (
                  <span className="text-[9px] font-mono text-[var(--text-muted)]">
                    {timeRange}
                  </span>
                )}
                <span className="text-[9px] text-[var(--text-muted)]">
                  (prompts {chunk.promptStart}–{chunk.promptEnd})
                </span>
              </div>

              <div className="min-h-[24px]">
                {isLoading ? (
                  <div className="flex items-center gap-2 text-[11px] text-[var(--text-muted)]">
                    <Loader2 size={12} className="animate-spin" />
                    Generating summary...
                  </div>
                ) : summary ? (
                  <p className="text-[12px] leading-relaxed text-[var(--text)]">
                    {summary}
                  </p>
                ) : (
                  <div className="flex items-center gap-2">
                    <span className="text-[12px] italic text-[var(--text-muted)]">Summary unavailable</span>
                    <button
                      type="button"
                      onClick={() => retry(chunk)}
                      className="inline-flex items-center gap-1 text-[10px] text-[var(--accent)] hover:text-[var(--text)] transition-colors"
                    >
                      <RefreshCw size={10} />
                      Retry
                    </button>
                  </div>
                )}
              </div>

              {(chunk.commits > 0 || chunk.pushes > 0) && (
                <div className="flex items-center gap-3 mt-2 pt-2 border-t border-[var(--border)]">
                  {chunk.commits > 0 && (
                    <span className="inline-flex items-center gap-1 text-[10px] font-medium text-[var(--text-muted)]">
                      <GitCommit size={11} />
                      {chunk.commits} commit{chunk.commits > 1 ? 's' : ''}
                    </span>
                  )}
                  {chunk.pushes > 0 && (
                    <span className="inline-flex items-center gap-1 text-[10px] font-medium text-[var(--text-muted)]">
                      <ArrowUpRight size={11} />
                      {chunk.pushes} push{chunk.pushes > 1 ? 'es' : ''}
                    </span>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
