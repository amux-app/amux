import { ChevronDown, Plus, RefreshCw, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '../../lib/cn';
import type { MarketplaceSource } from 'muxbase/core';
import { Spinner } from '../shared/Spinner';

export interface KnownSource {
  label: string;
  url: string;
  description: string;
  tag?: string;
}

interface AddSourceDropdownProps {
  knownSources: KnownSource[];
  addedUrls: Set<string>;
  addingUrl: string | null;
  onAdd: (url: string) => void;
}

function AddSourceDropdown({ knownSources, addedUrls, addingUrl, onAdd }: AddSourceDropdownProps) {
  const [open, setOpen] = useState(false);
  const [customUrl, setCustomUrl] = useState('');
  const [showCustomInput, setShowCustomInput] = useState(false);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ top: 0, left: 0, width: 0 });
  const inputRef = useRef<HTMLInputElement>(null);

  const suggested = knownSources.filter((s) => !addedUrls.has(s.url));

  useEffect(() => {
    if (!open) { setShowCustomInput(false); setCustomUrl(''); return; }
    const el = anchorRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({ top: r.bottom + 6, left: r.left, width: Math.max(r.width, 320) });
  }, [open]);

  useEffect(() => {
    if (showCustomInput) inputRef.current?.focus();
  }, [showCustomInput]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    const onClick = (e: MouseEvent) => {
      if (anchorRef.current?.contains(e.target as Node)) return;
      if (dropdownRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onClick);
    return () => { document.removeEventListener('keydown', onKey); document.removeEventListener('mousedown', onClick); };
  }, [open]);

  const handleAdd = (url: string) => {
    if (!url.trim() || addingUrl) return;
    onAdd(url.trim());
    setOpen(false);
  };

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 px-2.5 py-1 text-[11px] font-medium rounded-lg bg-[var(--accent)] text-[var(--bg)] hover:opacity-90 transition-opacity"
      >
        <Plus size={12} />
        Add source
        <ChevronDown size={11} className={cn('transition-transform', open && 'rotate-180')} />
      </button>

      {open && createPortal(
        <div
          ref={dropdownRef}
          className="fixed z-[200] bg-[var(--surface-raised)] border border-[var(--border)] rounded-xl shadow-2xl overflow-hidden"
          style={{ top: pos.top, left: pos.left, width: pos.width }}
        >
          {suggested.length > 0 && (
            <div className="p-1">
              {suggested.map((s) => (
                <button
                  key={s.url}
                  type="button"
                  disabled={addingUrl === s.url}
                  onClick={() => handleAdd(s.url)}
                  className="w-full flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-[var(--surface)] transition-colors text-left disabled:opacity-50"
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="text-[12px] font-medium text-[var(--text)]">{s.label}</span>
                      {s.tag && (
                        <span className="text-[9px] font-semibold uppercase tracking-wide text-[var(--text-muted)] bg-[var(--surface)] border border-[var(--border)] px-1.5 py-px rounded-full">
                          {s.tag}
                        </span>
                      )}
                    </div>
                    <div className="text-[10px] text-[var(--text-muted)] truncate mt-0.5">{s.description}</div>
                  </div>
                  {addingUrl === s.url ? <Spinner /> : <Plus size={12} className="text-[var(--accent)] shrink-0" />}
                </button>
              ))}
            </div>
          )}

          {suggested.length > 0 && <div className="h-px bg-[var(--border)] mx-3" />}

          <div className="p-2">
            {showCustomInput ? (
              <div className="flex gap-1.5">
                <input
                  ref={inputRef}
                  type="text"
                  value={customUrl}
                  onChange={(e) => setCustomUrl(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleAdd(customUrl);
                    if (e.key === 'Escape') setShowCustomInput(false);
                  }}
                  placeholder="https://github.com/org/repo"
                  className="flex-1 px-2.5 py-1.5 text-[11px] bg-[var(--surface)] border border-[var(--border)] rounded-lg text-[var(--text)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-[var(--accent)] transition-colors"
                />
                <button
                  type="button"
                  onClick={() => handleAdd(customUrl)}
                  disabled={!!addingUrl || !customUrl.trim()}
                  className="px-2.5 py-1.5 text-[11px] font-medium rounded-lg bg-[var(--accent)] text-[var(--bg)] hover:opacity-90 disabled:opacity-40 transition-opacity shrink-0"
                >
                  {addingUrl === customUrl.trim() ? <Spinner /> : 'Add'}
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setShowCustomInput(true)}
                className="w-full flex items-center gap-2 px-3 py-2 rounded-lg hover:bg-[var(--surface)] transition-colors text-[var(--text-muted)] hover:text-[var(--text)]"
              >
                <Plus size={12} />
                <span className="text-[11px]">Custom URL…</span>
              </button>
            )}
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}

interface SourcesRowProps {
  sources: MarketplaceSource[];
  knownSources: KnownSource[];
  updatingSource: string | null;
  addingUrl: string | null;
  addedUrls: Set<string>;
  selectedSources: Set<string>;
  onAdd: (url: string) => void;
  onUpdate: (url: string) => void;
  onRemove: (url: string) => void;
  onToggle: (url: string) => void;
}

export function SourcesRow({
  sources, knownSources, updatingSource, addingUrl, addedUrls, selectedSources, onAdd, onUpdate, onRemove, onToggle,
}: SourcesRowProps) {
  return (
    <div className="flex items-start gap-2 flex-wrap">
      {sources.map((source) => {
        const active = selectedSources.has(source.url);
        return (
          <div
            key={source.url}
            className={cn(
              'group flex items-center gap-1.5 pl-2.5 pr-1.5 py-1 rounded-full border text-[11px] transition-colors',
              active
                ? 'border-[var(--accent)] bg-[var(--accent)]/10 text-[var(--accent)]'
                : 'border-[var(--border)] bg-[var(--surface)] text-[var(--text-secondary)]',
            )}
          >
            <button
              type="button"
              onClick={() => onToggle(source.url)}
              className="font-medium leading-none"
            >
              {source.name}
            </button>
            {source.headSha && (
              <span className={cn('font-mono text-[10px]', active ? 'text-[var(--accent)]/70' : 'text-[var(--text-muted)]')}>
                {source.headSha.slice(0, 7)}
              </span>
            )}
            <button
              type="button"
              onClick={() => onUpdate(source.url)}
              disabled={updatingSource === source.url}
              className={cn(
                'p-0.5 rounded-full transition-colors disabled:opacity-40',
                active ? 'text-[var(--accent)]/70 hover:text-[var(--accent)]' : 'text-[var(--text-muted)] hover:text-[var(--accent)]',
              )}
              title="Sync"
            >
              <RefreshCw size={10} className={updatingSource === source.url ? 'animate-spin' : ''} />
            </button>
            <button
              type="button"
              onClick={() => onRemove(source.url)}
              className={cn(
                'p-0.5 rounded-full transition-colors',
                active ? 'text-[var(--accent)]/70 hover:text-[var(--error)]' : 'text-[var(--text-muted)] hover:text-[var(--error)]',
              )}
              title="Remove"
            >
              <X size={10} />
            </button>
          </div>
        );
      })}
      <AddSourceDropdown knownSources={knownSources} addedUrls={addedUrls} addingUrl={addingUrl} onAdd={onAdd} />
    </div>
  );
}
