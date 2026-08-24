import { type ReactNode, useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '../../lib/cn';
import type { AgentOption } from '../../lib/agent-models';

interface AgentOptionDropdownProps {
  label: string;
  icon?: ReactNode;
  options: AgentOption[];
  value: string | undefined;
  onChange: (value: string | undefined) => void;
  placeholder?: string;
  /**
   * When provided, the closed-trigger and the "Default" menu row show
   * `Default · <hint>` so users can see what runs if they don't override.
   */
  placeholderHint?: string;
  disabled?: boolean;
}

interface MenuPosition {
  top: number;
  left: number;
  width: number;
}

const MENU_KEYFRAMES = '@keyframes agent-option-dropdown-in{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:translateY(0)}}';

export function AgentOptionDropdown({
  label,
  icon,
  options,
  value,
  onChange,
  placeholder,
  placeholderHint,
  disabled,
}: AgentOptionDropdownProps) {
  const labelId = useId();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [menuPos, setMenuPos] = useState<MenuPosition | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const closeAndRestoreFocus = useCallback(() => {
    setIsOpen(false);
    buttonRef.current?.focus();
  }, []);

  useLayoutEffect(() => {
    if (!isOpen) {
      setMenuPos(null);
      return;
    }
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
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      if (!containerRef.current?.contains(target) && !menuRef.current?.contains(target)) {
        setIsOpen(false);
      }
    };
    const keyHandler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeAndRestoreFocus();
      }
    };
    document.addEventListener('mousedown', handler);
    document.addEventListener('keydown', keyHandler);
    return () => {
      document.removeEventListener('mousedown', handler);
      document.removeEventListener('keydown', keyHandler);
    };
  }, [isOpen, closeAndRestoreFocus]);

  const handleToggle = useCallback(() => {
    if (disabled) return;
    setIsOpen((prev) => !prev);
  }, [disabled]);

  const handleSelect = useCallback((next: string | undefined) => {
    onChange(next);
    closeAndRestoreFocus();
  }, [onChange, closeAndRestoreFocus]);

  const selectedLabel = options.find((opt) => opt.value === value)?.label;
  const placeholderLabel = placeholder ?? 'Default';

  return (
    <>
      <style>{MENU_KEYFRAMES}</style>
      <div ref={containerRef} className="relative">
        <button
          ref={buttonRef}
          type="button"
          onClick={handleToggle}
          disabled={disabled}
          aria-haspopup="listbox"
          aria-expanded={isOpen}
          aria-label={label}
          className={cn(
            // Tile aesthetic — matches WorktreeTile / AutoModeTile.
            'group relative flex min-h-[58px] w-full items-center gap-2.5 rounded-xl px-3 py-2.5 text-left transition-all duration-150',
            'border border-[var(--divider)] bg-[color-mix(in_srgb,var(--text)_3%,transparent)]',
            !disabled && 'cursor-pointer hover:border-[var(--divider-strong)] hover:bg-[var(--tool-item-hover-bg)]',
            isOpen && 'border-[color-mix(in_srgb,var(--accent)_35%,transparent)] bg-[color-mix(in_srgb,var(--accent)_8%,transparent)]',
            disabled && 'opacity-55 cursor-not-allowed',
            'focus:outline-none focus-visible:border-[color-mix(in_srgb,var(--accent)_35%,transparent)] focus-visible:bg-[color-mix(in_srgb,var(--accent)_8%,transparent)]',
          )}
        >
          {icon && (
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] border border-[var(--divider)] bg-[color-mix(in_srgb,var(--text)_4%,transparent)] text-[var(--text-secondary)]">
              {icon}
            </div>
          )}
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <span id={labelId} className="text-[10px] font-medium uppercase tracking-wider text-[var(--text-secondary)] leading-none">
              {label}
            </span>
            {selectedLabel ? (
              // leading-[1.3] gives descenders (g/p/y/j in "High", "Opus") room
              // — leading-none clips the bottom of those letters in some fonts.
              <span className="block truncate text-[11px] font-semibold leading-[1.3] text-[var(--text)]">
                {selectedLabel}
              </span>
            ) : (
              <span className="flex min-w-0 items-baseline gap-1.5 text-[11px] font-semibold leading-[1.3]">
                <span className="shrink-0 text-[var(--text-secondary)]">{placeholderLabel}</span>
                {placeholderHint && (
                  <>
                    <span className="text-[color-mix(in_srgb,var(--text-muted)_70%,transparent)] opacity-70 shrink-0">·</span>
                    <span className="truncate text-[var(--text-muted)] opacity-90 font-medium">
                      {placeholderHint}
                    </span>
                  </>
                )}
              </span>
            )}
          </div>
          <svg
            width="14"
            height="14"
            viewBox="0 0 10 10"
            fill="none"
            className={cn(
              'shrink-0 text-[var(--text-muted)] transition-transform duration-150',
              !disabled && 'group-hover:text-[var(--text-secondary)]',
              isOpen && 'rotate-180 text-[var(--text-secondary)]',
            )}
          >
            <path d="M2.5 3.75L5 6.25L7.5 3.75" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>

        {isOpen && menuPos && createPortal(
          <div
            ref={menuRef}
            role="listbox"
            aria-labelledby={labelId}
            className="fixed z-[80] overflow-hidden rounded-lg border border-[var(--divider-strong)] shadow-2xl"
            style={{
              top: menuPos.top,
              left: menuPos.left,
              width: menuPos.width,
              background: 'linear-gradient(168deg, color-mix(in srgb, var(--surface-raised) 96%, transparent) 0%, color-mix(in srgb, var(--surface) 98%, transparent) 100%)',
              backdropFilter: 'blur(24px) saturate(150%)',
              WebkitBackdropFilter: 'blur(24px) saturate(150%)',
              animation: 'agent-option-dropdown-in 130ms ease forwards',
            }}
          >
            <div className="max-h-[260px] overflow-y-auto py-1">
              <button
                type="button"
                onClick={() => handleSelect(undefined)}
                className={cn(
                  'w-full flex items-center gap-2 px-2.5 py-1.5 text-left text-[11px] transition-colors',
                  'hover:bg-[var(--tool-item-hover-bg)]',
                  value === undefined
                    ? 'text-[var(--text)] font-semibold'
                    : 'text-[var(--text-secondary)] font-medium',
                )}
              >
                <span className="w-2.5 text-center text-[9px] text-[var(--accent)]">
                  {value === undefined ? '●' : ''}
                </span>
                <span className="flex min-w-0 items-baseline gap-1.5">
                  <span className="shrink-0">{placeholderLabel}</span>
                  {placeholderHint && (
                    <>
                      <span className="opacity-50 shrink-0">·</span>
                      <span className="truncate opacity-70 font-medium">{placeholderHint}</span>
                    </>
                  )}
                </span>
              </button>

              {options.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  role="option"
                  aria-selected={value === opt.value}
                  onClick={() => handleSelect(opt.value)}
                  className={cn(
                    'w-full flex items-center gap-2 px-2.5 py-1.5 text-left text-[11px] transition-colors',
                    'hover:bg-[var(--tool-item-hover-bg)]',
                    value === opt.value
                      ? 'text-[var(--text)] font-semibold'
                      : 'text-[var(--text-secondary)] font-medium',
                  )}
                >
                  <span className="w-2.5 text-center text-[9px] text-[var(--accent)]">
                    {value === opt.value ? '●' : ''}
                  </span>
                  <span className="truncate">{opt.label}</span>
                </button>
              ))}
            </div>
          </div>,
          document.body,
        )}
      </div>
    </>
  );
}
