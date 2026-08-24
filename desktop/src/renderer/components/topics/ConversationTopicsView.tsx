import type { AumxPane } from 'aumx/core';
import { useMemo } from 'react';
import type { ConversationTopic, PaneTopics } from '../../../shared/topic-types';
import { cn } from '../../lib/cn';
import { usePaneStore, useTopicsStore } from '../../stores';

export function ConversationTopicsView() {
  const panes = usePaneStore((s) => s.panes);
  const topicsByPane = useTopicsStore((s) => s.topicsByPane);

  const agentPanes = useMemo(() => panes.filter((pane) => pane.agent), [panes]);

  return (
    <div className="h-full overflow-y-auto bg-[var(--bg)] px-6 py-5">
      <div className="mx-auto max-w-5xl">
        <header className="mb-5">
          <h1 className="text-lg font-semibold text-[var(--text)]">Conversation Topics</h1>
        </header>

        {agentPanes.length === 0 ? (
          <EmptyState message="No active agents yet." />
        ) : (
          <div className="grid gap-4 sm:grid-cols-2">
            {agentPanes.map((pane) => (
              <PaneTopicsCard key={pane.id} pane={pane} paneTopics={topicsByPane[pane.id]} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function PaneTopicsCard({ pane, paneTopics }: { pane: AumxPane; paneTopics?: PaneTopics }) {
  const topics = paneTopics?.topics ?? [];
  const current = topics[topics.length - 1];
  const history = topics.slice(0, -1).reverse();

  return (
    <section className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-4">
      <div className="mb-3 flex items-center gap-2">
        <span className="truncate text-sm font-medium text-[var(--text)]">{pane.title || pane.slug}</span>
        {pane.agent && (
          <span className="rounded border border-[var(--border)] px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-[var(--text-muted)]">
            {pane.agent}
          </span>
        )}
      </div>

      {current ? (
        <div className="mb-3">
          <SectionLabel>Current topic</SectionLabel>
          <TopicRow topic={current} highlight />
        </div>
      ) : (
        <div className="text-xs text-[var(--text-muted)]">Waiting for conversation…</div>
      )}

      {history.length > 0 && (
        <div>
          <SectionLabel>Earlier</SectionLabel>
          <ul className="space-y-1">
            {history.map((topic) => (
              <li key={topic.id}>
                <TopicRow topic={topic} />
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function TopicRow({ topic, highlight }: { topic: ConversationTopic; highlight?: boolean }) {
  return (
    <div
      className={cn(
        'flex items-center justify-between gap-2 rounded px-2 py-1 text-xs',
        highlight ? 'bg-[var(--surface-raised)] text-[var(--text)]' : 'text-[var(--text-muted)]',
      )}
    >
      <span className="flex min-w-0 items-center gap-1.5">
        {!topic.refined && (
          <span className="inline-block h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-[var(--accent)]" aria-hidden />
        )}
        <span className="truncate">{topic.label}</span>
      </span>
      <span className="shrink-0 text-[10px] text-[var(--text-muted)]">{topic.messageCount} msg</span>
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <div className="mb-1 text-[10px] uppercase tracking-wide text-[var(--text-muted)]">{children}</div>;
}

function EmptyState({ message }: { message: string }) {
  return (
    <div className="rounded-lg border border-dashed border-[var(--border)] p-8 text-center text-sm text-[var(--text-muted)]">
      {message}
    </div>
  );
}
