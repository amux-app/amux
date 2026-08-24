import { ArrowDown } from 'lucide-react';
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CompactionEvent, NormalizedSession, NormalizedToolResult, SubagentSession } from '../../../shared/agent-session-types';
import { useScrollToMessage } from '../../hooks/useScrollToMessage';
import { CompactionMarker, MessageGroup } from './ConversationMessageItems';

// NOTE: do not re-introduce `content-visibility: auto` / `contain-intrinsic-size`
// on individual message wrappers. Variable-height messages (long prose, tables,
// large code blocks) make any static intrinsic-size hint wrong, which corrupts
// the scroll offset on scroll-up. If virtualization becomes necessary for very
// long conversations, use a height-aware virtualizer (react-virtuoso /
// react-window) keyed by msg.id.

interface ConversationViewProps {
  session: NormalizedSession;
  paneId?: string;
}

const BOTTOM_THRESHOLD_PX = 16;
const PROGRAMMATIC_SCROLL_EVENT_LIMIT = 2;
const PROGRAMMATIC_SCROLL_GUARD_MS = 200;
const FOLLOWING_KEYS = new Set(['End', 'PageDown']);
const READING_KEYS = new Set(['ArrowUp', 'Home', 'PageUp']);
type ScrollDirection = 'down' | 'up';

export function ConversationView({ session, paneId }: ConversationViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const autoScrollRef = useRef(true);
  const lastScrollTopRef = useRef(0);
  const programmaticScrollEventsToIgnoreRef = useRef(0);
  const programmaticScrollReleaseRef = useRef<number | null>(null);
  const restoredSessionKeyRef = useRef<string | null>(null);
  const userScrollDirectionRef = useRef<ScrollDirection | null>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const sessionScrollKey = `${paneId ?? 'conversation'}:${session.sessionId}`;

  const setPinnedToBottom = useCallback((next: boolean) => {
    if (next) userScrollDirectionRef.current = null;
    autoScrollRef.current = next;
    setAutoScroll(current => (current === next ? current : next));
  }, []);

  const rememberScrollPosition = useCallback(() => {
    const el = containerRef.current;
    if (el) lastScrollTopRef.current = el.scrollTop;
  }, []);

  const markProgrammaticScroll = useCallback(() => {
    programmaticScrollEventsToIgnoreRef.current = PROGRAMMATIC_SCROLL_EVENT_LIMIT;
    if (programmaticScrollReleaseRef.current !== null) {
      window.clearTimeout(programmaticScrollReleaseRef.current);
    }
    programmaticScrollReleaseRef.current = window.setTimeout(() => {
      programmaticScrollEventsToIgnoreRef.current = 0;
      programmaticScrollReleaseRef.current = null;
    }, PROGRAMMATIC_SCROLL_GUARD_MS);
  }, []);

  const scrollToBottom = useCallback((behavior: ScrollBehavior) => {
    const bottom = bottomRef.current;
    if (!bottom) return;

    markProgrammaticScroll();
    bottom.scrollIntoView({ block: 'end', behavior });
  }, [markProgrammaticScroll]);

  useEffect(() => () => {
    if (programmaticScrollReleaseRef.current !== null) {
      window.clearTimeout(programmaticScrollReleaseRef.current);
    }
  }, []);

  const toolResultMap = useMemo(() => {
    const map = new Map<string, NormalizedToolResult>();
    for (const msg of session.messages)
      for (const tr of msg.toolResults)
        map.set(tr.toolCallId, tr);
    return map;
  }, [session.messages]);

  const subagentMap = useMemo(() => {
    const map = new Map<string, SubagentSession>();
    for (const sub of session.subagents) map.set(sub.parentToolCallId, sub);
    return map;
  }, [session.subagents]);

  const compactionByMessageId = useMemo(() => {
    const map = new Map<string, CompactionEvent>();
    for (const c of session.compactionEvents) {
      const message = session.messages[c.turnIndex];
      if (message) map.set(message.id, c);
    }
    return map;
  }, [session.compactionEvents, session.messages]);

  const visibleMessages = useMemo(() =>
    session.messages.filter(msg =>
      (msg.content?.trim().length ?? 0) > 0
      || msg.thinkingContent
      || msg.toolCalls.length > 0
      || msg.toolResults.length > 0,
    ), [session.messages]);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container || visibleMessages.length === 0) return;

    const isNewSession = restoredSessionKeyRef.current !== sessionScrollKey;
    if (!isNewSession) return;

    restoredSessionKeyRef.current = sessionScrollKey;
    setPinnedToBottom(true);
    scrollToBottom('auto');
  }, [scrollToBottom, setPinnedToBottom, visibleMessages.length, sessionScrollKey]);

  useLayoutEffect(() => {
    if (!autoScrollRef.current) return;
    scrollToBottom('auto');
  }, [scrollToBottom, session.lastUpdateTime, visibleMessages.length]);

  useLayoutEffect(() => {
    const content = contentRef.current;
    if (!content || typeof ResizeObserver === 'undefined') return;

    const observer = new ResizeObserver(() => {
      if (autoScrollRef.current) scrollToBottom('auto');
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, [scrollToBottom]);

  useScrollToMessage({
    containerRef,
    markProgrammaticScroll,
    setAutoScroll: setPinnedToBottom,
    visibleMessages,
  });

  const handleScroll = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;

    const scrollTop = el.scrollTop;
    const movedDown = scrollTop > lastScrollTopRef.current;
    const movedUp = scrollTop < lastScrollTopRef.current;
    lastScrollTopRef.current = scrollTop;

    if (programmaticScrollEventsToIgnoreRef.current > 0) {
      programmaticScrollEventsToIgnoreRef.current -= 1;
      return;
    }

    if (!isAtBottom(el)) {
      setPinnedToBottom(false);
      return;
    }

    if (movedUp || (!movedDown && userScrollDirectionRef.current === 'up')) {
      setPinnedToBottom(false);
      return;
    }

    setPinnedToBottom(true);
  }, [setPinnedToBottom]);

  const handleWheelCapture = useCallback((event: React.WheelEvent<HTMLDivElement>) => {
    if (event.deltaY === 0) return;

    rememberScrollPosition();
    userScrollDirectionRef.current = event.deltaY < 0 ? 'up' : 'down';
    if (event.deltaY < 0) setPinnedToBottom(false);
  }, [rememberScrollPosition, setPinnedToBottom]);

  const handleTouchMoveCapture = useCallback(() => {
    rememberScrollPosition();
    userScrollDirectionRef.current = 'up';
    setPinnedToBottom(false);
  }, [rememberScrollPosition, setPinnedToBottom]);

  const handleKeyDownCapture = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    rememberScrollPosition();
    if (isReadingKey(event)) {
      userScrollDirectionRef.current = 'up';
      setPinnedToBottom(false);
      return;
    }

    if (isFollowingKey(event)) {
      userScrollDirectionRef.current = 'down';
    }
  }, [rememberScrollPosition, setPinnedToBottom]);

  return (
    <div className="relative h-full bg-[var(--bg)]">
      <div
        ref={containerRef}
        onKeyDownCapture={handleKeyDownCapture}
        onScroll={handleScroll}
        onTouchMoveCapture={handleTouchMoveCapture}
        onWheelCapture={handleWheelCapture}
        className="h-full overflow-y-auto"
        role="log"
        aria-live="polite"
        aria-label="Conversation history"
        tabIndex={0}
      >
        <div ref={contentRef} className="mx-auto max-w-3xl space-y-6 px-4 pb-16 pt-6">
          {visibleMessages.map((msg) => {
            const compaction = compactionByMessageId.get(msg.id);
            return (
              <div key={msg.id} data-msg-id={msg.id}>
                {compaction && <CompactionMarker event={compaction} />}
                <MessageGroup
                  message={msg}
                  paneId={paneId}
                  subagentMap={subagentMap}
                  toolResultMap={toolResultMap}
                />
              </div>
            );
          })}

          <div ref={bottomRef} aria-hidden="true" />
        </div>
      </div>

      {!autoScroll && (
        <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center">
          <button
            aria-label="Jump to latest message"
            onClick={() => {
              setPinnedToBottom(true);
              scrollToBottom('smooth');
            }}
            className="pointer-events-auto inline-flex items-center gap-1.5 rounded-full border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5 text-[10px] font-medium text-[var(--tool-item-muted)] shadow-sm transition-colors hover:text-[var(--text)]"
          >
            <ArrowDown size={12} aria-hidden="true" />
            Latest
          </button>
        </div>
      )}
    </div>
  );
}

function isAtBottom(el: HTMLElement): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= BOTTOM_THRESHOLD_PX;
}

function isReadingKey(event: React.KeyboardEvent<HTMLDivElement>): boolean {
  return READING_KEYS.has(event.key) || (event.key === ' ' && event.shiftKey);
}

function isFollowingKey(event: React.KeyboardEvent<HTMLDivElement>): boolean {
  return FOLLOWING_KEYS.has(event.key) || (event.key === ' ' && !event.shiftKey);
}
