import { type KeyboardEvent as ReactKeyboardEvent, useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ProjectInfo } from '../../../shared/ipc-types';
import { cn } from '../../lib/cn';
import { truncatePath } from '../../lib/formatters';
import { nextRovingIndex } from '../../lib/roving-tabindex';

interface ProjectSwitcherProps {
  activeProject: ProjectInfo | null;
  onSelect: (projectRoot: string) => void;
  projects: ProjectInfo[];
}

interface MenuPosition {
  left: number;
  maxWidth: number;
  minWidth: number;
  top: number;
}

const ALWAYS_AVAILABLE = () => true;
const FALLBACK_NAME = 'MuxBase';
const MENU_GAP = 4;
const MENU_KEYFRAMES = '@keyframes project-switcher-in{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:translateY(0)}}';
// The trigger is a shrink-wrapped muted line, so the menu sizes to its own
// content between these bounds instead of inheriting the trigger's width.
const MENU_MAX_WIDTH = 380;
const MENU_MIN_WIDTH = 260;
const MENU_VIEWPORT_MARGIN = 8;
const NAME_CLASS = 'min-w-0 flex-1 truncate text-[12.5px] font-medium text-[var(--sidebar-text-muted)]';
const OPEN_KEYS = new Set(['ArrowDown', 'ArrowUp']);
const SHELL_CLASS = 'sidebar-focus flex h-[24px] w-full max-w-full min-w-0 items-center gap-[4px] rounded-[8px] px-[8px] text-left';
const triggerLabel = (name: string) => `Switch project, current: ${name}`;

const prefersReducedMotion = () =>
  typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// Widest the menu may grow, then the left edge is pinned so that growth can
// never cross the window edge.
function menuPositionFor(rect: DOMRect, viewportWidth: number): MenuPosition {
  const maxWidth = Math.min(MENU_MAX_WIDTH, viewportWidth - MENU_VIEWPORT_MARGIN * 2);
  const rightmostLeft = viewportWidth - MENU_VIEWPORT_MARGIN - maxWidth;
  return {
    left: Math.max(MENU_VIEWPORT_MARGIN, Math.min(rect.left, rightmostLeft)),
    maxWidth,
    minWidth: Math.min(Math.max(rect.width, MENU_MIN_WIDTH), maxWidth),
    top: rect.bottom + MENU_GAP,
  };
}

function samePosition(a: MenuPosition, b: MenuPosition): boolean {
  return a.left === b.left && a.top === b.top && a.minWidth === b.minWidth && a.maxWidth === b.maxWidth;
}

export function ProjectSwitcher({ activeProject, onSelect, projects }: Readonly<ProjectSwitcherProps>) {
  if (projects.length < 2) {
    const name = activeProject?.name ?? FALLBACK_NAME;
    return (
      <div
        className={cn(SHELL_CLASS, 'bg-transparent')}
        data-testid="sidebar-project-switcher"
        title={name}
      >
        <span className={NAME_CLASS}>{name}</span>
      </div>
    );
  }
  return <ProjectSwitcherMenu activeProject={activeProject} onSelect={onSelect} projects={projects} />;
}

function ProjectSwitcherMenu({ activeProject, onSelect, projects }: Readonly<ProjectSwitcherProps>) {
  const baseId = useId();
  const containerRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const pointerMovedRef = useRef(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [isOpen, setIsOpen] = useState(false);
  const [menuPos, setMenuPos] = useState<MenuPosition | null>(null);

  const activeName = activeProject?.name ?? FALLBACK_NAME;
  const listboxId = `${baseId}-listbox`;
  const optionId = (index: number) => `${baseId}-option-${index}`;
  const selectedIndex = projects.findIndex((project) => project.root === activeProject?.root);

  const closeAndRestoreFocus = useCallback(() => {
    setIsOpen(false);
    triggerRef.current?.focus();
  }, []);

  useLayoutEffect(() => {
    if (!isOpen) {
      setMenuPos(null);
      return;
    }
    const reposition = () => {
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const next = menuPositionFor(rect, window.innerWidth);
      setMenuPos((prev) => (prev && samePosition(prev, next) ? prev : next));
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
    const handleMouseDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (!containerRef.current?.contains(target) && !menuRef.current?.contains(target)) {
        setIsOpen(false);
      }
    };
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeAndRestoreFocus();
      }
    };
    document.addEventListener('mousedown', handleMouseDown);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('mousedown', handleMouseDown);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [isOpen, closeAndRestoreFocus]);

  const handleToggle = () => {
    pointerMovedRef.current = false;
    setActiveIndex(selectedIndex < 0 ? 0 : selectedIndex);
    setIsOpen((prev) => !prev);
  };

  const handleSelect = (index: number) => {
    const target = projects[index];
    if (target && target.root !== activeProject?.root) onSelect(target.root);
    closeAndRestoreFocus();
  };

  const handlePointerHighlight = (index: number) => {
    if (pointerMovedRef.current) setActiveIndex(index);
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (!isOpen) {
      if (OPEN_KEYS.has(event.key)) {
        event.preventDefault();
        handleToggle();
      }
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      handleSelect(activeIndex);
      return;
    }
    if (event.key === 'Tab') {
      setIsOpen(false);
      return;
    }
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') return;
    const next = nextRovingIndex(event.key, activeIndex, ALWAYS_AVAILABLE, projects.length);
    if (next === null) return;
    event.preventDefault();
    pointerMovedRef.current = false;
    setActiveIndex(next);
  };

  return (
    <>
      <style>{MENU_KEYFRAMES}</style>
      <div ref={containerRef} className="relative min-w-0">
        <button
          ref={triggerRef}
          type="button"
          role="combobox"
          data-testid="sidebar-project-switcher"
          title={activeName}
          onClick={handleToggle}
          onKeyDown={handleKeyDown}
          aria-activedescendant={isOpen ? optionId(activeIndex) : undefined}
          aria-controls={isOpen ? listboxId : undefined}
          aria-expanded={isOpen}
          aria-haspopup="listbox"
          aria-label={triggerLabel(activeName)}
          className={cn(
            SHELL_CLASS,
            'bg-transparent transition-[background-color,color] duration-150 hover:bg-[var(--sidebar-hover)]',
            isOpen && 'bg-[var(--sidebar-hover)]',
          )}
        >
          <span className={NAME_CLASS}>{activeName}</span>
          <ChevronGlyph open={isOpen} />
        </button>
      </div>

      {isOpen && menuPos && createPortal(
        <div
          ref={menuRef}
          id={listboxId}
          role="listbox"
          aria-label="Projects"
          onMouseMove={() => { pointerMovedRef.current = true; }}
          className="fixed z-[80] max-h-[320px] overflow-y-auto rounded-lg border border-[var(--divider-strong)] py-[6px] shadow-2xl"
          style={{
            top: menuPos.top,
            left: menuPos.left,
            maxWidth: menuPos.maxWidth,
            minWidth: menuPos.minWidth,
            background: 'linear-gradient(168deg, color-mix(in srgb, var(--surface-raised) 96%, transparent) 0%, color-mix(in srgb, var(--surface) 98%, transparent) 100%)',
            backdropFilter: 'blur(24px) saturate(150%)',
            WebkitBackdropFilter: 'blur(24px) saturate(150%)',
            animation: prefersReducedMotion() ? undefined : 'project-switcher-in 130ms ease forwards',
          }}
        >
          {projects.map((project, index) => (
            <ProjectOption
              key={project.root}
              highlighted={index === activeIndex}
              id={optionId(index)}
              onHighlight={() => handlePointerHighlight(index)}
              onSelect={() => handleSelect(index)}
              project={project}
              selected={index === selectedIndex}
            />
          ))}
        </div>,
        document.body,
      )}
    </>
  );
}

interface ProjectOptionProps {
  highlighted: boolean;
  id: string;
  onHighlight: () => void;
  onSelect: () => void;
  project: ProjectInfo;
  selected: boolean;
}

function ProjectOption({ highlighted, id, onHighlight, onSelect, project, selected }: Readonly<ProjectOptionProps>) {
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (highlighted) buttonRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [highlighted]);

  return (
    <button
      ref={buttonRef}
      id={id}
      type="button"
      role="option"
      tabIndex={-1}
      aria-selected={selected}
      onClick={onSelect}
      onMouseEnter={onHighlight}
      className={cn(
        'flex w-full flex-col items-start gap-[3px] px-3 py-[7px] text-left transition-colors hover:bg-[var(--tool-item-hover-bg)]',
        highlighted && 'bg-[var(--tool-item-hover-bg)]',
      )}
    >
      <span className="flex w-full min-w-0 items-center gap-1.5">
        <span
          className={cn('h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--accent)]', !selected && 'opacity-0')}
          aria-hidden="true"
        />
        <span
          className={cn(
            'min-w-0 flex-1 truncate text-[13px]',
            selected ? 'font-semibold text-[var(--text)]' : 'font-medium text-[var(--text-secondary)]',
          )}
        >
          {project.name}
        </span>
      </span>
      <span className="w-full truncate pl-3 font-mono text-[10px] leading-[1.4] text-[var(--text-secondary)]">
        {truncatePath(project.root)}
      </span>
    </button>
  );
}

function ChevronGlyph({ open }: Readonly<{ open: boolean }>) {
  return (
    <svg
      aria-hidden="true"
      className={cn(
        'shrink-0 text-[var(--sidebar-icon)] transition-transform duration-150',
        open && 'rotate-180 text-[var(--sidebar-text)]',
      )}
      fill="none"
      height="11"
      viewBox="0 0 10 10"
      width="11"
    >
      <path d="M2.5 3.75L5 6.25L7.5 3.75" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
