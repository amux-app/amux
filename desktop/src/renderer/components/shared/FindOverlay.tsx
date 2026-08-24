import { CaseSensitive, ChevronDown, ChevronUp, Search, X } from 'lucide-react';
import { useEffect, useRef, type KeyboardEvent } from 'react';
import { cn } from '../../lib/cn';

interface FindOverlayProps {
  query: string;
  onQueryChange: (q: string) => void;
  matchCount: number;
  matchIndex: number; // 1-based; 0 when no matches or no query
  onNext: () => void;
  onPrev: () => void;
  onClose: () => void;
  caseSensitive: boolean;
  onToggleCase: () => void;
  /** Optional placeholder for the input. */
  placeholder?: string;
  /** Optional positioning class override (defaults to absolute top-right). */
  className?: string;
}

/**
 * Browser-style find bar. Floats top-right of the parent (parent must be
 * `position: relative`). Auto-focuses input on mount.
 *
 * Owns Enter / Shift+Enter / Esc INSIDE its input. Parent owns:
 *   - visibility (mount/unmount this component)
 *   - query state
 *   - actually performing the search
 *   - opening on Cmd+F (this component does not listen for Cmd+F itself)
 */
export function FindOverlay({
  query,
  onQueryChange,
  matchCount,
  matchIndex,
  onNext,
  onPrev,
  onClose,
  caseSensitive,
  onToggleCase,
  placeholder = 'Find',
  className,
}: FindOverlayProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    // Focus immediately AND on the next frame. Some surfaces (e.g. xterm)
    // refocus their own hidden inputs during the same tick the overlay
    // mounts — focusing again on the next frame wins that race.
    inputRef.current?.focus();
    inputRef.current?.select();
    const raf = requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
    return () => cancelAnimationFrame(raf);
  }, []);

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (e.shiftKey) onPrev();
      else onNext();
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      onNext();
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      onPrev();
    }
  };

  const counterText =
    !query ? '' : matchCount === 0 ? 'No results' : `${matchIndex}/${matchCount}`;

  return (
    <div
      role="search"
      aria-label="Find"
      onMouseDown={(e) => e.stopPropagation()}
      className={cn(
        'absolute top-2 right-2 z-30 flex items-center gap-1 rounded-md border border-[var(--border)] bg-[var(--surface-raised)] px-1.5 py-1 shadow-lg',
        'min-w-[260px]',
        className,
      )}
    >
      <Search size={12} className="shrink-0 text-[var(--text-muted)]" />
      <input
        ref={inputRef}
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        className="flex-1 min-w-0 bg-transparent text-[11px] text-[var(--text)] outline-none placeholder:text-[var(--text-muted)]"
      />
      {counterText && (
        <span
          className="shrink-0 text-[9px] text-[var(--text-muted)]"
          style={{ fontVariantNumeric: 'tabular-nums' }}
        >
          {counterText}
        </span>
      )}
      <button
        type="button"
        title={caseSensitive ? 'Case sensitive (on)' : 'Case sensitive (off)'}
        aria-pressed={caseSensitive}
        onClick={onToggleCase}
        className={cn(
          'shrink-0 rounded p-0.5 transition-colors',
          caseSensitive
            ? 'bg-[var(--accent)]/20 text-[var(--accent)]'
            : 'text-[var(--text-muted)] hover:text-[var(--text)]',
        )}
      >
        <CaseSensitive size={12} />
      </button>
      <div className="h-3 w-px shrink-0 bg-[var(--border)]" />
      <button
        type="button"
        title="Previous match (Shift+Enter)"
        onClick={onPrev}
        disabled={matchCount === 0}
        className="shrink-0 rounded p-0.5 text-[var(--text-muted)] transition-colors hover:text-[var(--text)] disabled:opacity-40 disabled:hover:text-[var(--text-muted)]"
      >
        <ChevronUp size={12} />
      </button>
      <button
        type="button"
        title="Next match (Enter)"
        onClick={onNext}
        disabled={matchCount === 0}
        className="shrink-0 rounded p-0.5 text-[var(--text-muted)] transition-colors hover:text-[var(--text)] disabled:opacity-40 disabled:hover:text-[var(--text-muted)]"
      >
        <ChevronDown size={12} />
      </button>
      <button
        type="button"
        title="Close (Esc)"
        onClick={onClose}
        className="shrink-0 rounded p-0.5 text-[var(--text-muted)] transition-colors hover:text-[var(--text)]"
      >
        <X size={12} />
      </button>
    </div>
  );
}
