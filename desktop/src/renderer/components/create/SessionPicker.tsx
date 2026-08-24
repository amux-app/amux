import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, History } from 'lucide-react';
import type { PastSession } from '../../../shared/ipc-types';
import { cn } from '../../lib/cn';
import { formatSessionDate } from '../../lib/formatters';

interface SessionPickerProps {
  sessions: PastSession[];
  value: string | undefined;
  onChange: (sessionId: string | undefined) => void;
  loading: boolean;
  totalCount: number;
  onShowAll: () => void;
}

export function SessionPicker({ sessions, value, onChange, loading, totalCount, onShowAll }: SessionPickerProps) {
  const labelId = useId();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [menuPos, setMenuPos] = useState<{ top: number; left: number; width: number } | null>(null);

  const closeAndRestoreFocus = useCallback(() => {
    setIsOpen(false);
    buttonRef.current?.focus();
  }, []);

  useLayoutEffect(() => {
    if (!isOpen) { setMenuPos(null); return; }
    const reposition = () => {
      const rect = containerRef.current?.getBoundingClientRect();
      if (rect) setMenuPos({ top: rect.bottom + 4, left: rect.left, width: rect.width });
    };
    reposition();
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
    return () => {
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition, true);
    };
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const onMouseDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!containerRef.current?.contains(t) && !menuRef.current?.contains(t)) setIsOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); closeAndRestoreFocus(); }
    };
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [isOpen, closeAndRestoreFocus]);

  const handleSelect = useCallback((id: string | undefined) => {
    onChange(id);
    closeAndRestoreFocus();
  }, [onChange, closeAndRestoreFocus]);

  const selected = sessions.find((s) => s.id === value);
  const disabled = loading && sessions.length === 0;
  const remainingCount = totalCount - sessions.length;

  return (
    <div className="flex flex-col gap-1.5">
      <span id={labelId} className="text-[10px] font-medium uppercase tracking-wider text-[var(--text-secondary)]">
        Session
      </span>
      <div ref={containerRef} className="relative">
        <button
          ref={buttonRef}
          type="button"
          onClick={() => setIsOpen((p) => !p)}
          disabled={disabled}
          aria-haspopup="listbox"
          aria-expanded={isOpen}
          aria-labelledby={labelId}
          className={cn(
            'w-full flex items-center gap-2.5 px-3 py-2 rounded-lg border text-left transition-colors',
            'bg-[var(--bg)] border-[var(--border)] hover:border-[var(--text-muted)]',
            isOpen && 'border-[var(--accent)]',
            disabled && 'opacity-50 cursor-not-allowed hover:border-[var(--border)]',
          )}
        >
          <History size={12} className="shrink-0 text-[var(--text-muted)]" />
          <span className="flex-1 min-w-0 truncate text-xs text-[var(--text-muted)]">
            {loading && sessions.length === 0
              ? 'Loading…'
              : selected
                ? selected.title
                : 'New conversation'}
          </span>
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none"
            className={cn('shrink-0 text-[var(--text-muted)] transition-transform duration-150', isOpen && 'rotate-180')}>
            <path d="M2.5 3.75L5 6.25L7.5 3.75" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>

        {isOpen && menuPos && createPortal(
          <div
            ref={menuRef}
            role="listbox"
            aria-labelledby={labelId}
            className="fixed z-[80] rounded-lg border border-[var(--border)] bg-[var(--surface-raised)] shadow-2xl overflow-hidden"
            style={{ top: menuPos.top, left: menuPos.left, width: menuPos.width, animation: 'dropdown-in 130ms ease forwards' }}
          >
            <div className="max-h-[260px] overflow-y-auto py-1">
              <button
                type="button"
                role="option"
                aria-selected={!value}
                onClick={() => handleSelect(undefined)}
                className={cn(
                  'w-full flex items-center gap-2.5 px-3 py-2 text-left text-xs transition-colors hover:bg-[var(--tool-item-hover-bg)]',
                  !value ? 'text-[var(--accent)]' : 'text-[var(--text-secondary)]',
                )}
              >
                <span className="w-3 text-center text-[10px]">{!value ? '●' : ''}</span>
                <span className="truncate">New conversation</span>
              </button>

              {sessions.map((session) => (
                <button
                  key={session.id}
                  type="button"
                  role="option"
                  aria-selected={value === session.id}
                  onClick={() => handleSelect(session.id)}
                  className={cn(
                    'w-full flex items-center gap-2.5 px-3 py-2 text-left transition-colors hover:bg-[var(--tool-item-hover-bg)]',
                    value === session.id ? 'text-[var(--accent)]' : 'text-[var(--text-secondary)]',
                  )}
                >
                  <span className="w-3 text-center text-[10px] shrink-0">{value === session.id ? '●' : ''}</span>
                  <span className="flex-1 min-w-0 flex flex-col gap-0.5">
                    <span className="truncate text-xs">{session.title}</span>
                    <span className="text-[10px] text-[var(--text-muted)] opacity-60">
                      {formatSessionDate(session.updatedAt)}
                    </span>
                  </span>
                </button>
              ))}

              {remainingCount > 0 && !loading && (
                <button
                  type="button"
                  onClick={onShowAll}
                  className="w-full flex items-center justify-center gap-1.5 mt-1 px-3 py-2 border-t border-[var(--border)] text-[11px] font-medium text-[var(--text-muted)] hover:text-[var(--text-secondary)] hover:bg-[var(--tool-item-hover-bg)] transition-colors"
                >
                  <ChevronDown size={11} />
                  <span>Show {remainingCount} more</span>
                </button>
              )}

              {!loading && sessions.length === 0 && (
                <p className="px-4 py-3 text-xs text-[var(--text-muted)] opacity-60">No past sessions found</p>
              )}
            </div>
          </div>,
          document.body,
        )}
      </div>
    </div>
  );
}
