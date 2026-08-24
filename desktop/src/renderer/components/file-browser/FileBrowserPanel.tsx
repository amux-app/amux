import { ChevronsDownUp, FilePlus, FolderPlus, FolderTree, RefreshCw, X } from 'lucide-react';
import { useCallback, useEffect, useRef } from 'react';
import { IPC_EVENT } from '../../../shared/ipc-channels';
import type { FileChangedEvent } from '../../../shared/ipc-types';
import { useIpcListener } from '../../hooks/useIpcListener';
import { rendererLog } from '../../lib/rendererLog';
import { useFileBrowserStore, usePaneStore, useWorkspaceTabsStore } from '../../stores';
import { FILE_BROWSER_PANEL_CLASS } from './fileBrowserLayout';
import { LazyFileTree } from './LazyFileTree';

const FILE_BROWSER_PANEL_LOG_SCOPE = 'file-browser:panel';
const PANEL_ACTION_CLASS =
  'shrink-0 rounded p-0.5 text-(--text-muted) transition-colors hover:text-(--text) disabled:pointer-events-none disabled:opacity-30';

export function FileBrowserPanel() {
  const selectedPane = usePaneStore((s) =>
    s.panes.find((p) => p.id === s.selectedPaneId) ?? s.panes[0],
  );
  const rootPath = selectedPane?.worktreePath ?? selectedPane?.projectRoot;
  const tabScopeId = selectedPane?.id;
  const label = selectedPane?.slug ?? selectedPane?.id ?? 'No pane';
  const close = useFileBrowserStore((s) => s.close);
  const isOpen = useFileBrowserStore((s) => s.isOpen);
  const refresh = useFileBrowserStore((s) => s.refresh);
  const collapseAll = useFileBrowserStore((s) => s.collapseAll);
  const setCreating = useFileBrowserStore((s) => s.setCreating);
  const openFileTab = useWorkspaceTabsStore((s) => s.openFile);

  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    rendererLog.info(FILE_BROWSER_PANEL_LOG_SCOPE, 'Mounted', {
      isOpen,
      label,
      rootPath: rootPath ?? null,
      tabScopeId: tabScopeId ?? null,
    });

    return () => {
      rendererLog.info(FILE_BROWSER_PANEL_LOG_SCOPE, 'Unmounted', {
        label,
        rootPath: rootPath ?? null,
        tabScopeId: tabScopeId ?? null,
      });
    };
  }, [isOpen, label, rootPath, tabScopeId]);

  useEffect(() => {
    if (rootPath) {
      rendererLog.info(FILE_BROWSER_PANEL_LOG_SCOPE, 'Refresh requested for root', { rootPath });
      refresh(rootPath);
    }
  }, [rootPath, refresh]);

  useEffect(() => {
    return () => {
      if (refreshTimerRef.current) {
        clearTimeout(refreshTimerRef.current);
      }
    };
  }, []);

  const handleFileChanged = useCallback((event: unknown) => {
    if (!rootPath || !isOpen || !isFileChangedEvent(event) || event.rootPath !== rootPath) {
      return;
    }

    if (refreshTimerRef.current) {
      clearTimeout(refreshTimerRef.current);
    }

    refreshTimerRef.current = setTimeout(() => {
      void refresh(rootPath);
      refreshTimerRef.current = null;
    }, 100);
  }, [isOpen, refresh, rootPath]);

  useIpcListener(IPC_EVENT.FILE_CHANGED, handleFileChanged);

  const handleFileClick = useCallback((relativePath: string) => {
    if (rootPath && tabScopeId) void openFileTab(tabScopeId, rootPath, relativePath);
  }, [openFileTab, rootPath, tabScopeId]);

  return (
    <div data-testid="file-browser-panel" className={FILE_BROWSER_PANEL_CLASS}>
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-(--border) px-3">
        <FolderTree size={14} className="shrink-0 text-(--text-muted)" />
        <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-(--text)">
          {label}
        </span>
        <button
          disabled={!rootPath}
          onClick={() => setCreating({ dir: '', rootPath: rootPath!, type: 'file' })}
          className={PANEL_ACTION_CLASS}
          title="New File"
        >
          <FilePlus size={12} />
        </button>
        <button
          disabled={!rootPath}
          onClick={() => setCreating({ dir: '', rootPath: rootPath!, type: 'folder' })}
          className={PANEL_ACTION_CLASS}
          title="New Folder"
        >
          <FolderPlus size={12} />
        </button>
        <button
          disabled={!rootPath}
          onClick={() => collapseAll(rootPath!)}
          className={PANEL_ACTION_CLASS}
          title="Collapse All"
        >
          <ChevronsDownUp size={12} />
        </button>
        <button
          disabled={!rootPath}
          onClick={() => refresh(rootPath!)}
          className={PANEL_ACTION_CLASS}
          title="Refresh"
        >
          <RefreshCw size={12} />
        </button>
        <button
          onClick={() => { void close(); }}
          className="shrink-0 rounded p-0.5 text-(--text-muted) transition-colors hover:text-(--error)"
          title="Close file browser"
        >
          <X size={12} />
        </button>
      </div>

      <div className="flex-1 min-h-0">
        {!rootPath ? (
          <div className="flex h-full items-center justify-center text-[11px] text-(--text-muted)">
            Select a pane to browse files
          </div>
        ) : (
          <LazyFileTree rootPath={rootPath} onFileClick={handleFileClick} />
        )}
      </div>
    </div>
  );
}

function isFileChangedEvent(value: unknown): value is FileChangedEvent {
  return typeof value === 'object'
    && value !== null
    && 'changeType' in value
    && 'relativePath' in value
    && 'rootPath' in value
    && typeof value.changeType === 'string'
    && typeof value.relativePath === 'string'
    && typeof value.rootPath === 'string';
}
