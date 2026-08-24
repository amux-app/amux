import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import * as workspaceApi from '../../api/workspace.api';
import { cn } from '../../lib/cn';
import { useProjectStore, useWorkspacePickerStore } from '../../stores';
import { selectFilteredProjects } from '../../stores/workspace-picker.store';

interface ProjectPickerProps {
  value: string | undefined;
  onChange: (root: string | undefined) => void;
  className?: string;
}

const FolderIcon = () => (
  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
    <path d="M2 4.5V12.5C2 13.05 2.45 13.5 3 13.5H13C13.55 13.5 14 13.05 14 12.5V6.5C14 5.95 13.55 5.5 13 5.5H8L6.5 3.5H3C2.45 3.5 2 3.95 2 4.5Z" />
  </svg>
);

export function ProjectPicker({ value, onChange, className }: ProjectPickerProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [menuPos, setMenuPos] = useState<{ top: number; left: number; width: number } | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const sessionProjectRoot = useProjectStore((s) => s.sessionProjectRoot);
  const loadProjects = useWorkspacePickerStore((s) => s.load);
  const activeProjects = useWorkspacePickerStore((s) => s.activeProjects);
  const historyEntries = useWorkspacePickerStore((s) => s.historyEntries);
  const search = useWorkspacePickerStore((s) => s.search);
  const projects = useMemo(
    () => selectFilteredProjects({ activeProjects, historyEntries, search }),
    [activeProjects, historyEntries, search],
  );

  useEffect(() => {
    loadProjects();
  }, [loadProjects]);

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
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [isOpen]);

  const handleBrowse = useCallback(async () => {
    setIsOpen(false);
    const result = await workspaceApi.openFolderDialog();
    if (!result.canceled && result.path) {
      onChange(result.path);
      loadProjects();
    }
  }, [onChange, loadProjects]);

  const selectedProject = value ? projects.find((p) => p.root === value) : undefined;
  const displayName = selectedProject
    ? selectedProject.name
    : value
      ? value.split('/').pop() ?? value
      : sessionProjectRoot
        ? 'Current workspace'
        : 'Choose workspace';

  return (
    <div ref={containerRef} className={cn('relative', className)}>
      <div className="flex items-stretch gap-1.5">
        <button
          type="button"
          onClick={() => setIsOpen(!isOpen)}
          aria-label={displayName}
          className={cn(
            'flex-1 min-w-0 flex items-center gap-2.5 px-3 py-2 rounded-lg border text-left transition-colors',
            'bg-[var(--bg)] border-[var(--border)] hover:border-[var(--text-muted)]',
            isOpen && 'border-[var(--accent)]',
          )}
        >
          <span className="text-[var(--text-muted)] shrink-0">
            <FolderIcon />
          </span>
          <span className="flex-1 min-w-0 flex items-baseline gap-1.5">
            <span className="shrink-0 text-xs text-[var(--text)]">{displayName}</span>
            {(value || sessionProjectRoot) && (
              <span className="text-[9px] text-[var(--text-muted)] truncate font-mono opacity-60">
                {value ?? sessionProjectRoot}
              </span>
            )}
          </span>
          <svg
            width="10"
            height="10"
            viewBox="0 0 10 10"
            fill="none"
            className={cn('shrink-0 text-[var(--text-muted)] transition-transform duration-150', isOpen && 'rotate-180')}
          >
            <path d="M2.5 3.75L5 6.25L7.5 3.75" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        <button
          type="button"
          onClick={handleBrowse}
          aria-label="Browse folder"
          title="Browse folder"
          className="shrink-0 flex items-center justify-center w-8 rounded-lg border border-[var(--border)] bg-[var(--bg)] text-[var(--text-muted)] hover:border-[var(--text-muted)] hover:text-[var(--text-secondary)] transition-colors"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
            <path d="M2 4.5V12.5C2 13.05 2.45 13.5 3 13.5H13C13.55 13.5 14 13.05 14 12.5V6.5C14 5.95 13.55 5.5 13 5.5H8L6.5 3.5H3C2.45 3.5 2 3.95 2 4.5Z" />
            <path d="M8 8V12" />
            <path d="M6 10H10" />
          </svg>
        </button>
      </div>

      {isOpen && menuPos && createPortal(
        <div
          ref={menuRef}
          className="fixed z-[80] rounded-lg border border-[var(--border)] bg-[var(--surface-raised)] shadow-2xl overflow-hidden"
          style={{ top: menuPos.top, left: menuPos.left, width: menuPos.width, animation: 'project-picker-in 130ms ease forwards' }}
        >
          <style>{'@keyframes project-picker-in{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:translateY(0)}}'}</style>
          <div className="max-h-[240px] overflow-y-auto py-1">
            {sessionProjectRoot && (
              <button
                type="button"
                onClick={() => { onChange(undefined); setIsOpen(false); }}
                className={cn(
                  'w-full flex items-center gap-2.5 px-3 py-2 text-left text-xs transition-colors hover:bg-[var(--tool-item-hover-bg)]',
                  !value && 'text-[var(--accent)]',
                  value && 'text-[var(--text-secondary)]',
                )}
              >
                <span className="w-3 text-center text-[10px]">{!value ? '●' : ''}</span>
                <span>Current workspace</span>
              </button>
            )}

            {projects.map((p) => (
              <button
                key={p.root}
                type="button"
                onClick={() => { onChange(p.root); setIsOpen(false); }}
                className={cn(
                  'w-full flex items-center gap-2.5 px-3 py-2 text-left transition-colors hover:bg-[var(--tool-item-hover-bg)]',
                  value === p.root && 'text-[var(--accent)]',
                  value !== p.root && 'text-[var(--text-secondary)]',
                )}
              >
                <span className="w-3 text-center text-[10px]">{value === p.root ? '●' : ''}</span>
                <div className="flex-1 min-w-0">
                  <span className="text-xs font-medium block truncate">{p.name}</span>
                  <span className="text-[9px] text-[var(--text-muted)] block truncate font-mono">{p.root}</span>
                </div>
                {p.isActive && (
                  <span className="shrink-0 h-1.5 w-1.5 rounded-full bg-[var(--success)]" />
                )}
              </button>
            ))}
          </div>

          <div className="border-t border-[var(--border)]">
            <button
              type="button"
              onClick={handleBrowse}
              className="w-full flex items-center gap-2.5 px-3 py-2.5 text-left text-xs text-[var(--text-secondary)] hover:bg-[var(--tool-item-hover-bg)] transition-colors"
            >
              <span className="w-3 text-center text-[var(--text-muted)]">
                <FolderIcon />
              </span>
              <span>Browse folder...</span>
            </button>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
