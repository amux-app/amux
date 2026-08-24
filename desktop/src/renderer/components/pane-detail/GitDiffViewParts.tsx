import {
  AlertTriangle,
  ArrowUpToLine,
  Binary,
  ChevronDown,
  ChevronRight,
  Columns2,
  ExternalLink,
  FileEdit,
  FileText,
  FileWarning,
  GitCommit,
  GitCompare,
  Rows3,
  Search,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { GitChangedFileStatus, GitDiffFileEntry, GitDiffMode } from '../../../shared/ipc-types';
import { cn } from '../../lib/cn';
import { HEADER_ICON_BUTTON_CLASS } from '../../lib/constants';
import { HoverTooltip } from '../shared/HoverTooltip';
import { Spinner } from '../shared/Spinner';

const BINARY_LABEL = 'Binary file';
const FIRST_CHANGE_LABEL = 'Jump to first change';
const FULL_FILE_LABEL = 'Full file context loaded';
const LOADING_FULL_FILE_LABEL = 'Loading full file context';
const OPEN_FILE_LABEL = 'Open file in editor';
const PREVIEW_OMITTED_LABEL = 'Preview omitted — file too large';

const STATUS_PILL_CLASS = cn(HEADER_ICON_BUTTON_CLASS, 'border');
const WARNING_PILL_TONE = 'border-[var(--warning)]/20 text-[var(--warning)] bg-[var(--warning)]/10';

export const ICON_BUTTON_CLASS = cn(
  HEADER_ICON_BUTTON_CLASS,
  'text-[var(--text-muted)] hover:text-[var(--text)] hover:bg-[var(--surface-raised)]',
);

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  icon: LucideIcon;
  tooltip: string;
}

export const DIFF_MODE_OPTIONS: SegmentedOption<GitDiffMode>[] = [
  { value: 'working', label: 'Working', icon: FileEdit, tooltip: 'Working tree changes' },
  { value: 'branch', label: 'Branch', icon: GitCompare, tooltip: 'Diff vs. base branch' },
  { value: 'commit', label: 'Last Commit', icon: GitCommit, tooltip: 'Last commit' },
];

export const VIEW_MODE_OPTIONS: SegmentedOption<'split' | 'unified'>[] = [
  { value: 'split', label: 'Split', icon: Columns2, tooltip: 'Split view' },
  { value: 'unified', label: 'Unified', icon: Rows3, tooltip: 'Unified view' },
];

export function ToolbarDivider() {
  return <span aria-hidden="true" className="h-4 w-px shrink-0 bg-[var(--border)]" />;
}

export function SegmentedControl<T extends string>({ options, value, onChange }: {
  options: SegmentedOption<T>[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex items-center gap-1">
      {options.map((opt) => (
        <HoverTooltip key={opt.value} label={opt.tooltip}>
          <button
            aria-label={opt.label}
            aria-pressed={value === opt.value}
            onClick={() => onChange(opt.value)}
            type="button"
            className={cn(
              HEADER_ICON_BUTTON_CLASS,
              value === opt.value
                ? 'text-[var(--text)] bg-[var(--surface-raised)]'
                : 'text-[var(--text-muted)] hover:text-[var(--text)] hover:bg-[var(--surface-raised)]',
            )}
          >
            <opt.icon size={12} />
          </button>
        </HoverTooltip>
      ))}
    </div>
  );
}

export function RepoBadge({
  icon: Icon,
  label,
  value,
  tone = 'neutral',
}: {
  icon: LucideIcon;
  label: string;
  value: string;
  tone?: 'neutral' | 'success' | 'error';
}) {
  const toneClass =
    tone === 'success'
      ? 'text-[color-mix(in_srgb,var(--success)_45%,white)]'
      : tone === 'error'
        ? 'text-[color-mix(in_srgb,var(--error)_45%,white)]'
        : 'text-[var(--text-secondary)]';
  return (
    <HoverTooltip label={label}>
      <span aria-label={`${label}: ${value}`} className={cn('inline-flex items-center gap-1 min-w-0', toneClass)}>
        <Icon size={12} className="shrink-0" />
        <span className="text-[10px] font-semibold max-w-[240px] truncate">{value}</span>
      </span>
    </HoverTooltip>
  );
}

function StatusPill({ children, label, toneClass }: {
  children: ReactNode;
  label: string;
  toneClass: string;
}) {
  return (
    <HoverTooltip label={label}>
      <span aria-label={label} role="img" className={cn(STATUS_PILL_CLASS, toneClass)}>
        {children}
      </span>
    </HoverTooltip>
  );
}

interface FileHeaderStatusProps {
  readonly children?: ReactNode;
  readonly fullContextFallbackReason: string | null;
  readonly hasFullFileContext: boolean;
  readonly hasPatch: boolean;
  readonly isBinary: boolean;
  readonly isFullPatchLoading: boolean;
  readonly onOpenFile: () => void;
  readonly onScrollToFirstChange: () => void;
  readonly tooLarge: boolean;
}

export function FileHeaderStatus({
  children,
  fullContextFallbackReason,
  hasFullFileContext,
  hasPatch,
  isBinary,
  isFullPatchLoading,
  onOpenFile,
  onScrollToFirstChange,
  tooLarge,
}: FileHeaderStatusProps) {
  return (
    <>
      {isBinary && (
        <StatusPill label={BINARY_LABEL} toneClass="border-[var(--border)] text-[var(--text-secondary)] bg-[var(--surface-raised)]">
          <Binary size={12} />
        </StatusPill>
      )}
      {tooLarge && (
        <StatusPill label={PREVIEW_OMITTED_LABEL} toneClass={WARNING_PILL_TONE}>
          <FileWarning size={12} />
        </StatusPill>
      )}
      <div className="flex items-center gap-1 ml-auto shrink-0">
        {isFullPatchLoading && (
          <StatusPill label={LOADING_FULL_FILE_LABEL} toneClass="border-[var(--border)] text-[var(--text-muted)] bg-[var(--surface)]">
            <Spinner size="sm" className="h-3 w-3" />
          </StatusPill>
        )}
        {hasFullFileContext && (
          <StatusPill label={FULL_FILE_LABEL} toneClass="border-[var(--accent)]/20 text-[var(--accent)] bg-[var(--accent)]/10">
            <FileText size={12} />
          </StatusPill>
        )}
        {fullContextFallbackReason && (
          <StatusPill label={fullContextFallbackReason} toneClass={WARNING_PILL_TONE}>
            <AlertTriangle size={12} />
          </StatusPill>
        )}
        {hasPatch && (
          <HoverTooltip label={FIRST_CHANGE_LABEL}>
            <button
              aria-label={FIRST_CHANGE_LABEL}
              type="button"
              onClick={onScrollToFirstChange}
              className={ICON_BUTTON_CLASS}
            >
              <ArrowUpToLine size={12} />
            </button>
          </HoverTooltip>
        )}
        <HoverTooltip label={OPEN_FILE_LABEL}>
          <button
            aria-label={OPEN_FILE_LABEL}
            type="button"
            onClick={onOpenFile}
            className={ICON_BUTTON_CLASS}
          >
            <ExternalLink size={12} />
          </button>
        </HoverTooltip>
        {children}
      </div>
    </>
  );
}

export function FileListSearch({ files, selectedPath, onSelect, diffMode }: {
  files: GitDiffFileEntry[];
  selectedPath?: string;
  onSelect: (path: string) => void;
  diffMode: GitDiffMode;
}) {
  const [filter, setFilter] = useState('');
  const [stagedCollapsed, setStagedCollapsed] = useState(false);
  const [unstagedCollapsed, setUnstagedCollapsed] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const filtered = useMemo(() => {
    if (!filter) return files;
    const lower = filter.toLowerCase();
    return files.filter((f) => f.path.toLowerCase().includes(lower));
  }, [files, filter]);

  const { staged, unstaged } = useMemo(() => {
    const stagedFiles: GitDiffFileEntry[] = [];
    const unstagedFiles: GitDiffFileEntry[] = [];
    for (const file of filtered) {
      if (file.staged) stagedFiles.push(file);
      if (file.unstaged) unstagedFiles.push(file);
      // Files that are neither staged nor unstaged (shouldn't happen in working
      // mode) fall into the unstaged bucket so they're not lost from the list.
      if (!file.staged && !file.unstaged) unstagedFiles.push(file);
    }
    return { staged: stagedFiles, unstaged: unstagedFiles };
  }, [filtered]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 'f') {
        e.preventDefault();
        inputRef.current?.focus();
      }
    };
    globalThis.addEventListener('keydown', handler);
    return () => globalThis.removeEventListener('keydown', handler);
  }, []);

  const showSections = diffMode === 'working';

  return (
    <>
      <div className="shrink-0 px-2 py-1.5 border-b border-[var(--border)]">
        <div className="flex items-center gap-1.5 rounded-md bg-[var(--bg)] border border-[var(--border)] px-2 py-1">
          <Search size={12} className="shrink-0 text-[var(--text-muted)]" />
          <input
            ref={inputRef}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter files..."
            className="flex-1 bg-transparent text-[11px] text-[var(--text)] outline-none placeholder:text-[var(--text-muted)]"
          />
          {filter && (
            <span className="text-[9px] text-[var(--text-muted)]" style={{ fontVariantNumeric: 'tabular-nums' }}>
              {filtered.length}/{files.length}
            </span>
          )}
        </div>
      </div>
      <div className="flex-1 overflow-y-auto">
        {showSections ? (
          <div className="py-0.5">
            <FileSection
              label="Staged Changes"
              files={staged}
              collapsed={stagedCollapsed}
              onToggle={() => setStagedCollapsed((v) => !v)}
              selectedPath={selectedPath}
              onSelect={onSelect}
              tone="success"
            />
            <FileSection
              label="Changes"
              files={unstaged}
              collapsed={unstagedCollapsed}
              onToggle={() => setUnstagedCollapsed((v) => !v)}
              selectedPath={selectedPath}
              onSelect={onSelect}
              tone="warning"
            />
            {filter && filtered.length === 0 && (
              <div className="px-3 py-6 text-center text-[11px] text-[var(--text-muted)]">No files match &quot;{filter}&quot;</div>
            )}
          </div>
        ) : (
          <div className="py-0.5">
            {filtered.map((file) => (
              <FileRow
                key={file.path}
                file={file}
                selected={selectedPath === file.path}
                onSelect={onSelect}
              />
            ))}
            {filter && filtered.length === 0 && (
              <div className="px-3 py-6 text-center text-[11px] text-[var(--text-muted)]">No files match &quot;{filter}&quot;</div>
            )}
          </div>
        )}
      </div>
    </>
  );
}

interface FileSectionProps {
  readonly label: string;
  readonly files: GitDiffFileEntry[];
  readonly collapsed: boolean;
  readonly onToggle: () => void;
  readonly selectedPath?: string;
  readonly onSelect: (path: string) => void;
  readonly tone: 'success' | 'warning';
}

function FileSection({ label, files, collapsed, onToggle, selectedPath, onSelect, tone }: FileSectionProps) {
  if (files.length === 0) return null;
  const toneClass = tone === 'success' ? 'text-[var(--success)]' : 'text-[var(--warning)]';
  const Chevron = collapsed ? ChevronRight : ChevronDown;
  return (
    <div className="border-b border-[var(--border)]/40 last:border-b-0">
      <button
        type="button"
        onClick={onToggle}
        className="w-full flex items-center gap-1 px-2 py-1 text-left hover:bg-[var(--surface-raised)]/50 transition-colors sticky top-0 z-10 bg-[var(--surface)]/95 backdrop-blur"
      >
        <Chevron size={12} className="shrink-0 text-[var(--text-muted)]" />
        <span className="text-[10px] uppercase tracking-wider font-semibold text-[var(--text-secondary)]">{label}</span>
        <span
          className={cn('ml-auto text-[9px] font-semibold px-1.5 py-0.5 rounded-full bg-[var(--surface-raised)] border border-[var(--border)]', toneClass)}
          style={{ fontVariantNumeric: 'tabular-nums' }}
        >
          {files.length}
        </span>
      </button>
      {!collapsed && (
        <div>
          {files.map((file) => (
            <FileRow
              key={`${label}:${file.path}`}
              file={file}
              selected={selectedPath === file.path}
              onSelect={onSelect}
            />
          ))}
        </div>
      )}
    </div>
  );
}

interface FileRowProps {
  readonly file: GitDiffFileEntry;
  readonly selected: boolean;
  readonly onSelect: (path: string) => void;
}

function FileRow({ file, selected, onSelect }: FileRowProps) {
  return (
    <button
      onClick={() => onSelect(file.path)}
      className={cn(
        'w-full text-left px-3 py-2 hover:bg-[var(--surface-raised)] transition-colors border-b border-[var(--border)]/30',
        selected && 'bg-[var(--accent)]/10',
      )}
      title={file.path}
    >
      <div className="flex items-center gap-2 min-w-0">
        <StatusGlyph status={file.status} />
        <span className="text-[11px] font-medium text-[var(--text)] truncate">{file.path.split('/').pop()}</span>
        {file.path.includes('/') && (
          <span className="text-[9px] text-[var(--text-muted)] truncate flex-1 text-right">{file.path.slice(0, file.path.lastIndexOf('/'))}</span>
        )}
      </div>
      <div className="mt-0.5 ml-5 flex items-center gap-1.5 text-[9px]">
        <span className="ml-auto shrink-0 text-[var(--success)]" style={{ fontVariantNumeric: 'tabular-nums' }}>+{file.additions}</span>
        <span className="shrink-0 text-[var(--error)]" style={{ fontVariantNumeric: 'tabular-nums' }}>-{file.deletions}</span>
      </div>
    </button>
  );
}

export function StatusGlyph({ status }: { status: GitChangedFileStatus }) {
  const styles: Record<GitChangedFileStatus, { label: string; cls: string }> = {
    modified: { label: 'M', cls: 'text-[var(--accent)] bg-[var(--accent)]/10 border-[var(--accent)]/20' },
    added: { label: 'A', cls: 'text-[var(--success)] bg-[var(--success)]/10 border-[var(--success)]/20' },
    deleted: { label: 'D', cls: 'text-[var(--error)] bg-[var(--error)]/10 border-[var(--error)]/20' },
    renamed: { label: 'R', cls: 'text-[var(--warning)] bg-[var(--warning)]/10 border-[var(--warning)]/20' },
    copied: { label: 'C', cls: 'text-[var(--warning)] bg-[var(--warning)]/10 border-[var(--warning)]/20' },
    typechange: { label: 'T', cls: 'text-[var(--text-secondary)] bg-[var(--surface-raised)] border-[var(--border)]' },
    untracked: { label: 'U', cls: 'text-[var(--warning)] bg-[var(--warning)]/10 border-[var(--warning)]/20' },
    conflict: { label: '!', cls: 'text-[var(--error)] bg-[var(--error)]/10 border-[var(--error)]/20' },
    unknown: { label: '•', cls: 'text-[var(--text-secondary)] bg-[var(--surface-raised)] border-[var(--border)]' },
  };
  const style = styles[status] ?? styles.unknown;
  return (
    <span className={cn('inline-flex items-center justify-center w-4 h-4 rounded border text-[9px] font-bold shrink-0', style.cls)}>
      {style.label}
    </span>
  );
}

export function safeRelative(root: string, target: string): string {
  try {
    const rel = target.startsWith(root) ? target.slice(root.length).replace(/^[/\\]/, '') : target;
    return rel || '.';
  } catch {
    return target;
  }
}
