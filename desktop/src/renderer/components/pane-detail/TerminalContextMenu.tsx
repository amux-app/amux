import { useEffect, useRef, useLayoutEffect, useState } from 'react';

export interface ContextMenuPosition {
  x: number;
  y: number;
  hasSelection: boolean;
}

interface TerminalContextMenuProps {
  position: ContextMenuPosition;
  onCopy: () => void;
  onPaste: () => void;
  onSelectAll: () => void;
  onClose: () => void;
}

export function TerminalContextMenu({ position, onCopy, onPaste, onSelectAll, onClose }: TerminalContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [clampedPos, setClampedPos] = useState({ x: position.x, y: position.y });

  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const x = Math.min(position.x, window.innerWidth - rect.width - 4);
    const y = Math.min(position.y, window.innerHeight - rect.height - 4);
    setClampedPos({ x: Math.max(0, x), y: Math.max(0, y) });
  }, [position.x, position.y]);

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) onClose();
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleKey);
    };
  }, [onClose]);

  const items = [
    ...(position.hasSelection ? [{ label: 'Copy', shortcut: '\u2318C', action: onCopy }] : []),
    { label: 'Paste', shortcut: '\u2318V', action: onPaste },
    { label: 'Select All', shortcut: '\u2318A', action: onSelectAll },
  ];

  return (
    <div
      ref={menuRef}
      className="fixed z-50 min-w-[140px] rounded-lg border border-[var(--border)] bg-[var(--surface-raised)] py-1 shadow-xl"
      style={{ left: clampedPos.x, top: clampedPos.y }}
    >
      {items.map((item) => (
        <button
          key={item.label}
          onClick={(e) => { e.stopPropagation(); item.action(); onClose(); }}
          className="flex w-full items-center justify-between px-3 py-1.5 text-xs text-[var(--text-secondary)] hover:bg-[var(--surface)] hover:text-[var(--text)] transition-colors"
        >
          <span>{item.label}</span>
          <span className="ml-4 text-[10px] text-[var(--text-muted)]">{item.shortcut}</span>
        </button>
      ))}
    </div>
  );
}
