import type { NewArtifact, SourceUpdate } from 'muxbase/core';
import { Bot, Check, Download, Package, Plug, Sparkles, Webhook, X } from 'lucide-react';
import { useState } from 'react';
import { cn } from '../../lib/cn';
import { useMarketplaceUpdatesStore } from '../../stores';
import { Spinner } from '../shared/Spinner';

const TYPE_META: Record<NewArtifact['type'], { label: string; icon: typeof Sparkles }> = {
  skill: { label: 'Skill', icon: Sparkles },
  mcpServer: { label: 'MCP', icon: Plug },
  agent: { label: 'Agent', icon: Bot },
  jsPlugin: { label: 'Plugin', icon: Package },
  hook: { label: 'Hook', icon: Webhook },
};

const artifactKey = (a: NewArtifact) => `${a.type}:${a.name}`;

function formatChangedAt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function ArtifactRow({
  artifact,
  checked,
  onToggle,
}: {
  artifact: NewArtifact;
  checked: boolean;
  onToggle: () => void;
}) {
  const meta = TYPE_META[artifact.type];
  const Icon = meta.icon;
  const changedAt = formatChangedAt(artifact.changedAt);
  return (
    <div className="flex items-start gap-2.5 py-2">
      <button
        type="button"
        role="checkbox"
        aria-checked={checked}
        onClick={onToggle}
        className={cn(
          'mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors',
          checked
            ? 'border-[var(--accent)] bg-[var(--accent)] text-[var(--bg)]'
            : 'border-[var(--border)] text-transparent hover:border-[var(--text-muted)]',
        )}
      >
        <Check size={11} strokeWidth={3} />
      </button>
      <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center text-[var(--text-muted)]">
        <Icon size={12} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-[12px] font-medium text-[var(--text)]">{artifact.name}</span>
          <span className="shrink-0 text-[9px] font-semibold uppercase tracking-[0.08em] text-[var(--text-muted)]">
            {meta.label}
          </span>
        </div>
        {artifact.description && (
          <p className="mt-0.5 line-clamp-2 text-[11px] leading-snug text-[var(--text-muted)]">
            {artifact.description}
          </p>
        )}
        {changedAt && (
          <p className="mt-0.5 text-[10px] text-[var(--text-muted)]">
            {artifact.changeType === 'new' ? 'Added' : 'Changed'} {changedAt}
          </p>
        )}
      </div>
    </div>
  );
}

// Groups artifacts of one changeType under a colored header so new vs. updated
// read differently at a glance.
function ChangeGroup({
  changeType,
  artifacts,
  selected,
  onToggle,
}: {
  changeType: NewArtifact['changeType'];
  artifacts: NewArtifact[];
  selected: Set<string>;
  onToggle: (a: NewArtifact) => void;
}) {
  if (artifacts.length === 0) return null;
  const isNew = changeType === 'new';
  return (
    <div>
      <div className="mb-1 flex items-center gap-1.5">
        <span
          className={cn(
            'inline-flex h-1.5 w-1.5 rounded-full',
            isNew ? 'bg-[var(--success)]' : 'bg-amber-500',
          )}
        />
        <span
          className={cn(
            'text-[9px] font-semibold uppercase tracking-[0.1em]',
            isNew ? 'text-[var(--success)]' : 'text-amber-500',
          )}
        >
          {isNew ? 'New' : 'Updated'} · {artifacts.length}
        </span>
      </div>
      <div className="divide-y divide-[var(--border)]/40 rounded-md border border-[var(--border)]/40 px-2">
        {artifacts.map((artifact) => (
          <ArtifactRow
            key={artifactKey(artifact)}
            artifact={artifact}
            checked={selected.has(artifactKey(artifact))}
            onToggle={() => onToggle(artifact)}
          />
        ))}
      </div>
    </div>
  );
}

function UpdateCard({ update }: { update: SourceUpdate }) {
  const installUpdate = useMarketplaceUpdatesStore((s) => s.installUpdate);
  const installing = useMarketplaceUpdatesStore((s) => s.installing);
  const isInstalling = installing.has(`${update.sourceUrl}::${update.pluginId}`);

  // Default to all items selected — the user is on the marketplace window to act.
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(update.newArtifacts.map(artifactKey)),
  );

  const toggle = (a: NewArtifact) =>
    setSelected((prev) => {
      const next = new Set(prev);
      const k = artifactKey(a);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });

  const newItems = update.newArtifacts.filter((a) => a.changeType === 'new');
  const updatedItems = update.newArtifacts.filter((a) => a.changeType === 'updated');
  const verb = updatedItems.length > 0 ? 'Install / Update' : 'Install';
  const selectedCount = selected.size;

  const install = () => {
    const picked = update.newArtifacts.filter((a) => selected.has(artifactKey(a)));
    if (picked.length > 0) void installUpdate(update, picked);
  };

  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-3">
      <div className="mb-2 min-w-0">
        <p className="truncate text-[12px] font-semibold text-[var(--text)]">{update.pluginName}</p>
        <p className="truncate text-[10px] text-[var(--text-muted)]">{update.sourceName}</p>
      </div>

      <div className="space-y-2.5">
        <ChangeGroup changeType="new" artifacts={newItems} selected={selected} onToggle={toggle} />
        <ChangeGroup changeType="updated" artifacts={updatedItems} selected={selected} onToggle={toggle} />
      </div>

      <div className="mt-2.5 flex items-center justify-between">
        <span className="text-[10px] text-[var(--text-muted)]">
          {selectedCount} of {update.newArtifacts.length} selected
        </span>
        <button
          type="button"
          onClick={install}
          disabled={isInstalling || selectedCount === 0}
          className="flex items-center gap-1.5 rounded-lg bg-[var(--accent)] px-3 py-1.5 text-[11px] font-medium text-[var(--bg)] transition-opacity hover:opacity-90 disabled:opacity-40"
        >
          {isInstalling ? <Spinner /> : <Download size={12} />}
          {verb}
        </button>
      </div>
    </div>
  );
}

export function MarketplaceUpdatesSection() {
  const updates = useMarketplaceUpdatesStore((s) => s.updates);
  const dismissAll = useMarketplaceUpdatesStore((s) => s.dismissAll);
  if (updates.length === 0) return null;

  return (
    <section>
      <div className="mb-2 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Sparkles size={13} className="text-[var(--accent)]" />
          <h3 className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--text-muted)]">
            Updates
          </h3>
        </div>
        <button
          type="button"
          onClick={dismissAll}
          className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-[var(--text-muted)] transition-colors hover:bg-[var(--surface)] hover:text-[var(--text)]"
          aria-label="Dismiss all updates"
        >
          <X size={11} />
          Dismiss
        </button>
      </div>
      <div className="space-y-2">
        {updates.map((update) => (
          <UpdateCard key={`${update.sourceUrl}::${update.pluginId}`} update={update} />
        ))}
      </div>
    </section>
  );
}
