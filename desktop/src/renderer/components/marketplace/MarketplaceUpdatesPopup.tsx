import { ArrowRight, Bot, Package, Plug, Sparkles, Webhook, X } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { useState } from 'react';
import type { NewArtifact } from 'muxbase/core';
import { cn } from '../../lib/cn';
import { useMarketplaceUpdatesStore, useUiStore } from '../../stores';

const TYPE_META: Record<NewArtifact['type'], { label: string; icon: typeof Sparkles }> = {
  skill: { label: 'Skill', icon: Sparkles },
  mcpServer: { label: 'MCP', icon: Plug },
  agent: { label: 'Agent', icon: Bot },
  jsPlugin: { label: 'Plugin', icon: Package },
  hook: { label: 'Hook', icon: Webhook },
};

export function MarketplaceUpdatesPopup() {
  const updates = useMarketplaceUpdatesStore((s) => s.updates);
  const openSettings = useUiStore((s) => s.openSettings);

  // Local dismissal — the popup is a per-session nicety. Updates still live in the
  // store and remain visible in the marketplace window until installed.
  const [dismissed, setDismissed] = useState(false);

  const artifacts = updates.flatMap((u) => u.newArtifacts);
  const newCount = artifacts.filter((a) => a.changeType === 'new').length;
  const updatedCount = artifacts.filter((a) => a.changeType === 'updated').length;

  const visible = !dismissed && artifacts.length > 0;

  const parts: string[] = [];
  if (newCount > 0) parts.push(`${newCount} new`);
  if (updatedCount > 0) parts.push(`${updatedCount} update${updatedCount !== 1 ? 's' : ''}`);
  const summary = parts.join(' · ');

  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-[320px] max-w-[calc(100vw-2rem)] flex-col">
      <AnimatePresence>
        {visible && (
          <motion.div
            initial={{ opacity: 0, y: 20, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 20, scale: 0.98 }}
            transition={{ type: 'spring', stiffness: 400, damping: 32 }}
            className={cn(
              'pointer-events-auto overflow-hidden rounded-xl border border-[var(--border)]',
              'bg-[var(--surface-raised)]/95 shadow-2xl backdrop-blur-md',
            )}
          >
            <div className="flex items-center gap-2.5 px-3.5 py-3">
              <Sparkles size={15} className="shrink-0 text-[var(--accent)]" />
              <div className="min-w-0 flex-1">
                <p className="text-[12px] font-semibold text-[var(--text)]">Marketplace Updates</p>
                <p className="text-[11px] text-[var(--text-muted)]">{summary}</p>
              </div>
              <button
                type="button"
                onClick={() => setDismissed(true)}
                className="shrink-0 text-[var(--text-muted)] transition-colors hover:text-[var(--text)]"
                aria-label="Dismiss"
              >
                <X size={14} />
              </button>
            </div>

            <div className="max-h-[220px] space-y-1.5 overflow-y-auto border-t border-[var(--border)] px-3.5 py-2.5">
              {artifacts.map((a) => {
                const meta = TYPE_META[a.type];
                const Icon = meta.icon;
                return (
                  <div key={`${a.type}:${a.name}`} className="flex items-center gap-2 text-[11px]">
                    <span className="flex h-4 w-4 shrink-0 items-center justify-center text-[var(--text-muted)]">
                      <Icon size={12} />
                    </span>
                    <span className="truncate text-[var(--text)]">{a.name}</span>
                    <span className="shrink-0 text-[9px] font-semibold uppercase tracking-[0.08em] text-[var(--text-muted)]">
                      {meta.label}
                    </span>
                    {a.changeType === 'updated' && (
                      <span className="shrink-0 rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.06em] text-amber-500">
                        Updated
                      </span>
                    )}
                  </div>
                );
              })}
            </div>

            <div className="border-t border-[var(--border)] p-2.5">
              <button
                type="button"
                onClick={() => {
                  setDismissed(true);
                  openSettings('marketplace');
                }}
                className="flex w-full items-center justify-center gap-1.5 rounded-lg bg-[var(--accent)] px-3 py-1.5 text-[11px] font-medium text-[var(--bg)] transition-opacity hover:opacity-90"
              >
                View in Marketplace
                <ArrowRight size={12} />
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
