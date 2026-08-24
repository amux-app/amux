import type { AgentStatus } from 'aumx/core';
import { Command } from 'cmdk';
import { Search, Terminal, MessageSquare, Zap, FileCode, Hash, User, Bot, FileText, FolderOpen, TextSearch } from 'lucide-react';
import { useRef, useMemo } from 'react';
import { useCommandPalette } from '../../hooks/useCommandPalette';
import { cn } from '../../lib/cn';
import { getFileExtColor } from '../../lib/constants';
import { formatRelativeTime } from '../../lib/formatters';
import { useCommandPaletteStore } from '../../stores';
import type { SearchTab } from '../../stores/command-palette.store';
import { Badge } from '../shared/Badge';
import { Kbd } from '../shared/Kbd';
import { ModalSurface } from '../shared/ModalSurface';
import { StatusDot } from '../shared/StatusDot';

const PANEL_CLASS = 'w-full max-w-[560px] rounded-xl border border-[var(--border)] bg-[var(--surface-raised)] shadow-2xl overflow-hidden flex flex-col';

const TABS: { id: SearchTab; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'files', label: 'Files' },
  { id: 'text', label: 'Text' },
  { id: 'panes', label: 'Panes' },
  { id: 'messages', label: 'Messages' },
  { id: 'commands', label: 'Commands' },
];

const MESSAGE_ROLE_META: Record<string, { Icon: typeof MessageSquare; color: string; label: string }> = {
  user:        { Icon: User, color: '#60a5fa', label: 'user' },
  assistant:   { Icon: Bot,  color: '#a78bfa', label: 'assistant' },
  tool_result: { Icon: Hash, color: '#fbbf24', label: 'tool' },
  system:      { Icon: Zap,  color: '#71717a', label: 'system' },
};

export function CommandPalette() {
  const isOpen = useCommandPaletteStore((s) => s.isOpen);
  const search = useCommandPaletteStore((s) => s.search);
  const setSearch = useCommandPaletteStore((s) => s.setSearch);
  const activeTab = useCommandPaletteStore((s) => s.activeTab);
  const setActiveTab = useCommandPaletteStore((s) => s.setActiveTab);
  const close = useCommandPaletteStore((s) => s.close);
  const inputRef = useRef<HTMLInputElement>(null);

  const {
    commands,
    filteredPanes,
    searchResults,
    fileResults,
    textResults,
    searching,
    filesSearching,
    textSearching,
    searchScope,
    executeCommand,
    navigateToResult,
    navigateToPane,
    navigateToFile,
    navigateToTextResult,
  } = useCommandPalette();

  const anySearching = searching || filesSearching || textSearching;
  const scopedTab = activeTab === 'files' || activeTab === 'text' || activeTab === 'all';

  const resultCount = getCountForTab(activeTab, commands.length, filteredPanes.length, searchResults.length, fileResults.length, textResults.length);

  return (
    <ModalSurface
      closeOnBackdropClick
      initialFocusRef={inputRef}
      label="Command palette"
      onClose={close}
      open={isOpen}
      panelClassName={PANEL_CLASS}
    >
      <Command shouldFilter={false} label="Command palette">
        {/* Search input row */}
        <div className="flex items-center gap-2 border-b border-[var(--border)] px-4 py-2.5">
          <Search size={15} className="shrink-0 text-[var(--text-secondary)]" />
          <Command.Input
            ref={inputRef}
            value={search}
            onValueChange={setSearch}
            placeholder={getPlaceholder(activeTab)}
            className="flex-1 bg-transparent text-sm text-[var(--text)] placeholder:text-[var(--text-secondary)] outline-none"
          />
        </div>

        {/* Tab bar */}
        <div className="flex items-center gap-0.5 border-b border-[var(--border)] px-3 py-1">
          {TABS.map((tab) => {
            const count = getCountForTab(tab.id, commands.length, filteredPanes.length, searchResults.length, fileResults.length, textResults.length);
            return (
              <button
                key={tab.id}
                onClick={(e) => { e.stopPropagation(); setActiveTab(tab.id); }}
                className={cn(
                  'flex items-center gap-1.5 px-2.5 py-1 text-[11px] font-medium rounded-md transition-all',
                  activeTab === tab.id
                    ? 'text-[var(--text)] bg-[var(--surface)] shadow-sm border border-[var(--border)]'
                    : 'text-[var(--text-secondary)] hover:text-[var(--text)] border border-transparent',
                )}
              >
                {tab.label}
                {search.length >= 2 && count > 0 && (
                  <span className={cn(
                    'text-[9px] font-mono min-w-[16px] text-center rounded-full px-1',
                    activeTab === tab.id
                      ? 'bg-[var(--accent)]/15 text-[var(--accent)]'
                      : 'bg-[var(--surface)] text-[var(--text-secondary)]',
                  )}>
                    {count}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {/* Results */}
        <Command.List className="max-h-[400px] min-h-[200px] overflow-y-auto p-1.5">
          <TabContent
            activeTab={activeTab}
            search={search}
            commands={commands}
            filteredPanes={filteredPanes}
            searchResults={searchResults}
            fileResults={fileResults}
            textResults={textResults}
            searching={searching}
            filesSearching={filesSearching}
            textSearching={textSearching}
            executeCommand={executeCommand}
            navigateToResult={navigateToResult}
            navigateToPane={navigateToPane}
            navigateToFile={navigateToFile}
            navigateToTextResult={navigateToTextResult}
          />
        </Command.List>

        {/* Footer */}
        <div className="flex items-center justify-between border-t border-[var(--border)] px-4 py-1.5">
          <span className="flex items-center gap-1.5 text-[10px] text-[var(--text-secondary)]">
            <span>{anySearching ? 'Searching...' : `${resultCount} result${resultCount !== 1 ? 's' : ''}`}</span>
            {scopedTab && searchScope && (
              <span className="truncate" title={searchScope.rootPath}>
                · in <span className="text-[var(--text-secondary)]">{searchScope.label}</span>
              </span>
            )}
          </span>
          <div className="flex items-center gap-4 text-[10px] text-[var(--text-secondary)]">
            <span className="flex items-center gap-1"><Kbd keys="↑↓" /> navigate</span>
            <span className="flex items-center gap-1"><Kbd keys="↵" /> open</span>
            <span className="flex items-center gap-1"><Kbd keys="esc" /> close</span>
          </div>
        </div>
      </Command>
    </ModalSurface>
  );
}

function TabContent({
  activeTab, search, commands, filteredPanes, searchResults, fileResults, textResults,
  searching, filesSearching, textSearching,
  executeCommand, navigateToResult, navigateToPane, navigateToFile, navigateToTextResult,
}: {
  activeTab: SearchTab;
  search: string;
  commands: ReturnType<typeof useCommandPalette>['commands'];
  filteredPanes: ReturnType<typeof useCommandPalette>['filteredPanes'];
  searchResults: ReturnType<typeof useCommandPalette>['searchResults'];
  fileResults: ReturnType<typeof useCommandPalette>['fileResults'];
  textResults: ReturnType<typeof useCommandPalette>['textResults'];
  searching: boolean;
  filesSearching: boolean;
  textSearching: boolean;
  executeCommand: (id: string) => void;
  navigateToResult: ReturnType<typeof useCommandPalette>['navigateToResult'];
  navigateToPane: (id: string) => void;
  navigateToFile: (rootPath: string, path: string) => void;
  navigateToTextResult: ReturnType<typeof useCommandPalette>['navigateToTextResult'];
}) {
  const hasQuery = search.length > 0;
  const hasAnyResults = commands.length > 0 || filteredPanes.length > 0 || searchResults.length > 0 || fileResults.length > 0 || textResults.length > 0;

  if (!hasQuery && activeTab === 'all') {
    return (
      <>
        {filteredPanes.length > 0 && (
          <SectionGroup heading="Recent Panes">
            {filteredPanes.slice(0, 5).map((p) => (
              <PaneItem key={p.id} pane={p} onSelect={() => navigateToPane(p.id)} />
            ))}
          </SectionGroup>
        )}
        {filteredPanes.length === 0 && (
          <EmptyHint text="Type to search across panes, messages, and commands" />
        )}
      </>
    );
  }

  if (activeTab === 'text') {
    if (search.length < 2) return <EmptyHint text="Type at least 2 characters to search in files" />;
    if (textSearching && textResults.length === 0) return <EmptyHint text="Searching file contents..." />;
    if (textResults.length === 0) return <EmptyHint text="No matches in file contents" />;
    return (
      <>
        {textResults.map((r, i) => (
          <TextResultItem key={`${r.rootPath}:${r.path}:${r.lineNumber}:${i}`} result={r} query={search} onSelect={() => navigateToTextResult(r.rootPath, r.path, r.lineNumber, search)} />
        ))}
      </>
    );
  }

  if (activeTab === 'files') {
    if (search.length < 2) return <EmptyHint text="Type at least 2 characters to search files" />;
    if (filesSearching && fileResults.length === 0) return <EmptyHint text="Searching files..." />;
    if (fileResults.length === 0) return <EmptyHint text="No matching files" />;
    return (
      <>
        {fileResults.map((f) => (
          <FileItem key={`${f.rootPath}:${f.path}`} file={f} query={search} onSelect={() => navigateToFile(f.rootPath, f.path)} />
        ))}
      </>
    );
  }

  if (activeTab === 'panes') {
    if (filteredPanes.length === 0) return <EmptyHint text="No matching panes" />;
    return (
      <>
        {filteredPanes.map((p) => (
          <PaneItem key={p.id} pane={p} onSelect={() => navigateToPane(p.id)} />
        ))}
      </>
    );
  }

  if (activeTab === 'messages') {
    if (search.length < 2) return <EmptyHint text="Type at least 2 characters to search messages" />;
    if (searching) return <EmptyHint text="Searching conversations..." />;
    if (searchResults.length === 0) return <EmptyHint text="No matching messages" />;
    return (
      <>
        {searchResults.map((r) => (
          <MessageItem key={r.id} result={r} query={search} onSelect={() => navigateToResult(r)} />
        ))}
      </>
    );
  }

  if (activeTab === 'commands') {
    if (commands.length === 0) return <EmptyHint text="No matching commands" />;
    const sections = commands.reduce<Record<string, typeof commands>>((acc, cmd) => {
      (acc[cmd.section] ??= []).push(cmd);
      return acc;
    }, {});
    return (
      <>
        {Object.entries(sections).map(([section, cmds]) => (
          <SectionGroup key={section} heading={section}>
            {cmds.map((cmd) => (
              <CommandItem key={cmd.id} command={cmd} onSelect={() => executeCommand(cmd.id)} />
            ))}
          </SectionGroup>
        ))}
      </>
    );
  }

  // "All" tab with query
  const anySearching = searching || filesSearching || textSearching;
  if (!hasAnyResults && !anySearching) return <EmptyHint text="No results found" />;
  if (!hasAnyResults) return <EmptyHint text="Searching..." />;
  return (
    <>
      {fileResults.length > 0 && (
        <SectionGroup heading={`Files (${fileResults.length})`}>
          {fileResults.slice(0, 5).map((f) => (
            <FileItem key={`${f.rootPath}:${f.path}`} file={f} query={search} onSelect={() => navigateToFile(f.rootPath, f.path)} />
          ))}
        </SectionGroup>
      )}
      {textResults.length > 0 && (
        <SectionGroup heading={`Text (${textResults.length})`}>
          {textResults.slice(0, 6).map((r, i) => (
            <TextResultItem key={`${r.rootPath}:${r.path}:${r.lineNumber}:${i}`} result={r} query={search} onSelect={() => navigateToTextResult(r.rootPath, r.path, r.lineNumber, search)} />
          ))}
        </SectionGroup>
      )}
      {filteredPanes.length > 0 && (
        <SectionGroup heading="Panes">
          {filteredPanes.slice(0, 5).map((p) => (
            <PaneItem key={p.id} pane={p} onSelect={() => navigateToPane(p.id)} />
          ))}
        </SectionGroup>
      )}
      {searchResults.length > 0 && (
        <SectionGroup heading={`Messages (${searchResults.length})`}>
          {searchResults.slice(0, 8).map((r) => (
            <MessageItem key={r.id} result={r} query={search} onSelect={() => navigateToResult(r)} />
          ))}
        </SectionGroup>
      )}
      {searching && searchResults.length === 0 && search.length >= 2 && (
        <div className="px-3 py-2 text-[11px] text-[var(--text-secondary)]">Searching messages...</div>
      )}
      {commands.length > 0 && (
        <SectionGroup heading="Commands">
          {commands.slice(0, 5).map((cmd) => (
            <CommandItem key={cmd.id} command={cmd} onSelect={() => executeCommand(cmd.id)} />
          ))}
        </SectionGroup>
      )}
    </>
  );
}

function SectionGroup({ heading, children }: { heading: string; children: React.ReactNode }) {
  return (
    <Command.Group
      heading={heading}
      className="[&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-[10px] [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:text-[var(--text-secondary)] [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider"
    >
      {children}
    </Command.Group>
  );
}

function PaneItem({ pane, onSelect }: { pane: { id: string; slug: string; agent?: string; status?: string }; onSelect: () => void }) {
  return (
    <Command.Item
      value={`pane-${pane.id}`}
      onSelect={onSelect}
      className="flex items-center gap-2.5 px-2.5 py-2 rounded-lg cursor-pointer data-[selected=true]:bg-[var(--surface)] transition-colors"
    >
      <Terminal size={14} className="shrink-0 text-[var(--text-secondary)]" />
      <span className="flex-1 text-xs font-medium text-[var(--text-secondary)] truncate">{pane.slug || pane.id}</span>
      {pane.agent && <Badge label={pane.agent} />}
      {pane.status && <StatusDot status={pane.status as AgentStatus} size="sm" />}
    </Command.Item>
  );
}

function FileItem({ file, query, onSelect }: {
  file: { path: string; filename: string };
  query: string;
  onSelect: () => void;
}) {
  const dirPath = file.path.slice(0, Math.max(0, file.path.length - file.filename.length - 1));
  const fileColor = getFileExtColor(file.filename);

  return (
    <Command.Item
      value={`file-${file.path}`}
      onSelect={onSelect}
      className="flex items-center gap-2.5 px-2.5 py-2 rounded-lg cursor-pointer data-[selected=true]:bg-[var(--surface)] transition-colors group"
    >
      <div className="shrink-0 w-5 h-5 rounded flex items-center justify-center" style={{ backgroundColor: `${fileColor}18` }}>
        <FileText size={12} style={{ color: fileColor }} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2">
          <span className="text-xs font-medium text-[var(--text)] truncate">
            <HighlightedText text={file.filename} query={query} />
          </span>
          {dirPath && (
            <span className="flex items-center gap-1 text-[10px] text-[var(--text-secondary)] truncate">
              <FolderOpen size={9} className="shrink-0" />
              <HighlightedText text={dirPath} query={query} />
            </span>
          )}
        </div>
      </div>
    </Command.Item>
  );
}

function TextResultItem({ result, query, onSelect }: {
  result: { path: string; filename: string; lineNumber: number; lineContent: string };
  query: string;
  onSelect: () => void;
}) {
  const fileColor = getFileExtColor(result.filename);
  const dirPath = result.path.slice(0, Math.max(0, result.path.length - result.filename.length - 1));

  return (
    <Command.Item
      value={`text-${result.path}:${result.lineNumber}`}
      onSelect={onSelect}
      className="flex items-start gap-2.5 px-2.5 py-2 rounded-lg cursor-pointer data-[selected=true]:bg-[var(--surface)] transition-colors"
    >
      <div className="shrink-0 w-5 h-5 mt-0.5 rounded flex items-center justify-center" style={{ backgroundColor: `${fileColor}15` }}>
        <TextSearch size={11} style={{ color: fileColor }} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="text-[11px] font-semibold text-[var(--text)]">{result.filename}</span>
          <span className="text-[9px] font-mono px-1 py-px rounded bg-[var(--surface)] text-[var(--accent)]">
            L{result.lineNumber}
          </span>
          {dirPath && (
            <span className="text-[9px] text-[var(--text-secondary)] truncate ml-auto">
              {dirPath}
            </span>
          )}
        </div>
        <div className="text-[10.5px] font-mono text-[var(--text-secondary)] truncate mt-1 leading-tight">
          <HighlightedText text={result.lineContent} query={query} />
        </div>
      </div>
    </Command.Item>
  );
}

function MessageItem({ result, query, onSelect }: {
  result: { id: string; paneSlug: string; messageType: string; snippet: string; filePath?: string; timestamp?: number };
  query: string;
  onSelect: () => void;
}) {
  const timeLabel = result.timestamp ? formatRelativeTime(result.timestamp) : undefined;
  const role = MESSAGE_ROLE_META[result.messageType] ?? MESSAGE_ROLE_META.assistant;

  return (
    <Command.Item
      value={result.id}
      onSelect={onSelect}
      className="flex flex-col gap-1 px-2.5 py-2 rounded-lg cursor-pointer data-[selected=true]:bg-[var(--surface)] transition-colors"
    >
      <div className="flex items-center gap-2">
        <role.Icon size={12} className="shrink-0" style={{ color: role.color }} />
        <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-[var(--surface)] text-[var(--text-secondary)]">
          {result.paneSlug}
        </span>
        <span
          className="text-[9px] font-medium px-1.5 py-0.5 rounded-full"
          style={{ backgroundColor: `${role.color}18`, color: role.color }}
        >
          {role.label}
        </span>
        {timeLabel && <span className="ml-auto text-[10px] text-[var(--text-secondary)]">{timeLabel}</span>}
      </div>
      {result.filePath && (
        <div className="flex items-center gap-1.5 ml-5">
          <FileCode size={10} className="shrink-0 text-[var(--accent)]" />
          <span className="text-[10px] font-mono text-[var(--accent)] truncate opacity-75">{result.filePath}</span>
        </div>
      )}
      <span className="text-xs text-[var(--text-secondary)] line-clamp-2 ml-5">
        <HighlightedText text={result.snippet} query={query} />
      </span>
    </Command.Item>
  );
}

function CommandItem({ command, onSelect }: { command: { id: string; label: string; shortcut?: string }; onSelect: () => void }) {
  return (
    <Command.Item
      value={command.id}
      onSelect={onSelect}
      className="flex items-center justify-between px-2.5 py-2 rounded-lg cursor-pointer data-[selected=true]:bg-[var(--surface)] transition-colors"
    >
      <div className="flex items-center gap-2.5">
        <Zap size={14} className="shrink-0 text-[var(--text-secondary)]" />
        <span className="text-xs text-[var(--text-secondary)]">{command.label}</span>
      </div>
      {command.shortcut && <Kbd keys={command.shortcut} />}
    </Command.Item>
  );
}

function EmptyHint({ text }: { text: string }) {
  return (
    <div className="flex items-center justify-center py-10 text-xs text-[var(--text-secondary)]">
      {text}
    </div>
  );
}

function HighlightedText({ text, query }: { text: string; query: string }) {
  const regex = useMemo(() => {
    if (!query || query.length < 2) return null;
    const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(${escaped})`, 'gi');
  }, [query]);

  if (!regex) return <>{text}</>;
  const parts = text.split(regex);
  return (
    <span>
      {parts.map((part, i) =>
        i % 2 === 1
          ? <mark key={i} className="bg-[var(--accent)]/25 text-[var(--text)] rounded-sm px-0.5 font-medium">{part}</mark>
          : <span key={i}>{part}</span>,
      )}
    </span>
  );
}

function getPlaceholder(tab: SearchTab): string {
  switch (tab) {
    case 'files': return 'Search files...';
    case 'text': return 'Search in file contents...';
    case 'panes': return 'Search panes...';
    case 'messages': return 'Search in conversations...';
    case 'commands': return 'Search commands...';
    default: return 'Search everywhere...';
  }
}

function getCountForTab(tab: SearchTab, cmdN: number, paneN: number, msgN: number, fileN: number, textN: number): number {
  switch (tab) {
    case 'files': return fileN;
    case 'text': return textN;
    case 'panes': return paneN;
    case 'messages': return msgN;
    case 'commands': return cmdN;
    default: return cmdN + paneN + msgN + fileN + textN;
  }
}
