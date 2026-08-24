import { ChevronDown, type LucideIcon, Plus, Swords, TerminalSquare } from 'lucide-react';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { usePaneActions } from '../../hooks/usePaneActions';
import { MIN_TARGET_BUTTON_CLASS } from '../../lib/constants';
import { usePaneStore } from '../../stores';

const MENU_ITEM_SELECTOR = '[role="menuitem"]';
const SEGMENT_CLASS = `flex items-center justify-center text-[var(--accent)] transition-colors hover:bg-[var(--accent)]/12 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--accent)]/55 ${MIN_TARGET_BUTTON_CLASS}`;
// Inset hairline instead of a full-height border: the two segments stay one
// compact chip visually while each keeps its own 24x24 pointer target.
const CARET_DIVIDER_CLASS = 'relative before:absolute before:inset-y-1 before:left-0 before:w-px before:bg-[var(--accent)]/25';

interface QuickCreateItem {
  Icon: LucideIcon;
  label: string;
  onSelect: () => void;
  shortcut?: string;
  testId: string;
}

function nextMenuIndex(current: number, delta: number, count: number): number {
  if (current === -1) return delta > 0 ? 0 : count - 1;
  return (current + delta + count) % count;
}

function moveMenuFocus(menu: HTMLDivElement | null, delta: number): void {
  const items = Array.from(menu?.querySelectorAll<HTMLButtonElement>(MENU_ITEM_SELECTOR) ?? []);
  if (items.length === 0) return;
  const current = items.indexOf(document.activeElement as HTMLButtonElement);
  items[nextMenuIndex(current, delta, items.length)].focus();
}

export function NewPaneSplitButton() {
  const { createPane } = usePaneActions();
  const setCreating = usePaneStore((s) => s.setCreating);
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const caretRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    moveMenuFocus(menuRef.current, 1);
    const handleMouseDown = (e: MouseEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handleMouseDown);
    return () => document.removeEventListener('mousedown', handleMouseDown);
  }, [open]);

  const close = () => {
    setOpen(false);
    caretRef.current?.focus();
  };

  const items: QuickCreateItem[] = [
    {
      Icon: Plus,
      label: 'Agent pane',
      onSelect: () => setCreating(true),
      shortcut: '⌘N',
      testId: 'resource-new-agent-pane',
    },
    {
      Icon: TerminalSquare,
      label: 'Shell',
      onSelect: () => { void createPane({ prompt: '', type: 'shell' }); },
      testId: 'resource-new-shell',
    },
    {
      Icon: Swords,
      label: 'Duel',
      onSelect: () => setCreating(true, 'duel'),
      testId: 'resource-new-duel',
    },
  ];

  const handleMenuKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      close();
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      moveMenuFocus(menuRef.current, 1);
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      moveMenuFocus(menuRef.current, -1);
    }
  };

  return (
    <div ref={containerRef} className="relative">
      <div className="flex items-center overflow-hidden rounded-md border border-[var(--accent)]/25 bg-transparent">
        <button
          type="button"
          onClick={() => setCreating(true)}
          data-testid="resource-new-pane"
          aria-label="New pane"
          title="New pane (⌘N)"
          className={SEGMENT_CLASS}
        >
          <Plus size={13} />
        </button>
        <button
          ref={caretRef}
          type="button"
          onClick={() => setOpen(!open)}
          data-testid="resource-new-menu"
          aria-label="More create options"
          aria-haspopup="menu"
          aria-expanded={open}
          className={`${SEGMENT_CLASS} ${CARET_DIVIDER_CLASS}`}
        >
          <ChevronDown size={12} />
        </button>
      </div>

      {open && (
        <div
          ref={menuRef}
          role="menu"
          aria-label="Create"
          onKeyDown={handleMenuKeyDown}
          className="absolute right-0 top-full z-40 mt-1.5 min-w-[190px] rounded-lg border border-[var(--border)] bg-[var(--surface-raised)] p-1 shadow-xl"
        >
          {items.map(({ Icon, label, onSelect, shortcut, testId }) => (
            <button
              key={testId}
              type="button"
              role="menuitem"
              data-testid={testId}
              onClick={() => { onSelect(); close(); }}
              className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-[var(--text-secondary)] transition-colors hover:bg-[var(--tool-item-hover-bg)] hover:text-[var(--text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--accent)]/50"
            >
              <Icon size={14} />
              {label}
              {shortcut && (
                <span className="ml-auto rounded border border-[var(--divider)] px-1.5 py-px font-mono text-[10px] leading-[14px] text-[var(--text-muted)]">
                  {shortcut}
                </span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
