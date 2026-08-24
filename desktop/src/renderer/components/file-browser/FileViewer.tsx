import { AlertTriangle, Braces, Copy, Eye, FileCode2, Pencil, RotateCcw, WrapText, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { IPC_EVENT } from '../../../shared/ipc-channels';
import type {
  FileChangedEvent,
  FileMutationConflictType,
  FileReadResponse,
  FileWriteResponse,
} from '../../../shared/ipc-types';
import { cancelFormatFileContent, formatFileContent, readFileContent } from '../../api/file.api';
import { clipboardWrite } from '../../api/system.api';
import { useIpcListener } from '../../hooks/useIpcListener';
import { cn } from '../../lib/cn';
import { rendererLog } from '../../lib/rendererLog';
import { useNotificationStore } from '../../stores';
import {
  fileKey,
  isPathInActiveMove,
  readResponseState,
  useFileBrowserStore,
} from '../../stores/file-browser.store';
import { ProseMarkdown } from '../shared/ProseMarkdown';
import { CodeMirrorEditor, type LanguageIntelligenceStatus } from './CodeMirrorEditor';
import type { EditorSession } from './EditorSession';
import { isBinaryFile, isMarkdownFile } from './fileEditorSupport';
import {
  FILE_BROWSER_CROWDED_VIEWER_CLASS,
  FILE_VIEWER_PANEL_CLASS,
} from './fileBrowserLayout';

type ViewMode = 'code' | 'display';
type TextReadResponse = Extract<FileReadResponse, { kind: 'editable-text' | 'readonly-text' }>;
type DiskReconciliationOutcome = 'adopted' | 'base' | 'conflict' | 'missing' | 'saved' | 'stale';

const FILE_DELETION_GRACE_MS = 300;
const FILE_VIEWER_LOG_SCOPE = 'file-viewer';
const FILE_CONFLICT_TOAST = 'File was modified on disk. Reload from disk to discard local edits.';
const FILE_DELETED_TOAST = 'File was deleted on disk. Local edits are preserved.';

interface FileViewerProps {
  onClose?: () => void;
}

function getDefaultMode(fileName: string): ViewMode {
  return isMarkdownFile(fileName) ? 'display' : 'code';
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

function isTextReadResponse(response: FileReadResponse): response is TextReadResponse {
  return response.kind === 'editable-text' || response.kind === 'readonly-text';
}

export function FileViewer({ onClose }: FileViewerProps = {}) {
  const viewingFile = useFileBrowserStore((state) => state.viewingFile);
  const viewerCrowded = useFileBrowserStore((state) => state.viewerCrowded);
  const closeFile = useFileBrowserStore((state) => state.closeFile);
  const editorGeneration = useFileBrowserStore((state) => state.draftResetKey);
  const openSearchPanelRequestKey = useFileBrowserStore((state) => state.findInFileRequestKey);
  const reloadOpenFile = useFileBrowserStore((state) => state.reloadOpenFile);
  const setFileConflict = useFileBrowserStore((state) => state.setFileConflict);
  const setFileContent = useFileBrowserStore((state) => state.setFileContent);
  const setPendingFileSaveHandler = useFileBrowserStore((state) => state.setPendingFileSaveHandler);
  const addToast = useNotificationStore((state) => state.addToast);
  const fileName = viewingFile?.relativePath.split('/').pop() ?? '';
  const [wordWrap, setWordWrap] = useState(false);
  const [mode, setMode] = useState<ViewMode>(() => getDefaultMode(fileName));
  const [formatting, setFormatting] = useState(false);
  const [languageIntelligence, setLanguageIntelligence] = useState<{
    detail?: string;
    status: LanguageIntelligenceStatus;
  }>({ status: 'idle' });
  const editorSessionRef = useRef<EditorSession | null>(null);
  const fileChangeQueueRef = useRef<Promise<void>>(Promise.resolve());
  const formatRequestRef = useRef<string | null>(null);
  const pendingDeletionRef = useRef<{
    fileKey: string;
    timer: ReturnType<typeof setTimeout>;
  } | null>(null);

  const binary = isBinaryFile(fileName) || viewingFile?.unsupportedReason === 'binary';
  const unsupported = viewingFile?.unsupportedReason !== undefined;
  const readOnly = viewingFile?.readOnlyReason !== undefined
    || viewingFile?.capabilityTier === 'read-only'
    || unsupported;
  const conflictDetected = viewingFile?.conflictDetected ?? false;
  const viewingFileKey = viewingFile
    ? fileKey(viewingFile.rootPath, viewingFile.relativePath)
    : '';

  useEffect(() => {
    setMode(getDefaultMode(fileName));
    setLanguageIntelligence({ status: 'idle' });
  }, [fileName, viewingFileKey]);

  useEffect(() => {
    if (openSearchPanelRequestKey > 0) setMode('code');
  }, [openSearchPanelRequestKey]);

  const reportConflict = useCallback((
    rootPath: string,
    relativePath: string,
    conflictType: FileMutationConflictType = 'modified',
    message = conflictType === 'deleted' ? FILE_DELETED_TOAST : FILE_CONFLICT_TOAST,
  ) => {
    const currentFile = useFileBrowserStore.getState().viewingFile;
    if (
      !currentFile
      || currentFile.rootPath !== rootPath
      || currentFile.relativePath !== relativePath
    ) return;

    editorSessionRef.current?.markConflicted();
    const shouldNotify = !currentFile.conflictDetected || currentFile.conflictType !== conflictType;
    setFileConflict(rootPath, relativePath, true, conflictType);
    if (shouldNotify) addToast(message, 'error');
  }, [addToast, setFileConflict]);

  const replaceFromDisk = useCallback((response: FileReadResponse): void => {
    useFileBrowserStore.setState((state) => {
      const current = state.viewingFile;
      if (!current) return state;
      const base = {
        conflictDetected: false,
        conflictType: undefined,
        loading: false,
        relativePath: current.relativePath,
        rootPath: current.rootPath,
      };
      switch (response.kind) {
        case 'editable-text':
          return {
            draftResetKey: state.draftResetKey + 1,
            viewingFile: {
              ...base,
              ...readResponseState(response),
            },
          };
        case 'readonly-text':
          return {
            draftResetKey: state.draftResetKey + 1,
            viewingFile: {
              ...base,
              ...readResponseState(response),
            },
          };
        case 'unsupported':
          return {
            draftResetKey: state.draftResetKey + 1,
            viewingFile: {
              ...base,
              ...readResponseState(response),
            },
          };
        case 'error':
          return state;
      }
    });
  }, []);

  const reconcileDiskFile = useCallback((
    rootPath: string,
    relativePath: string,
    diskFile: FileReadResponse,
  ): DiskReconciliationOutcome => {
    if (diskFile.kind === 'error') return 'missing';
    const state = useFileBrowserStore.getState();
    const currentFile = state.viewingFile;
    if (!currentFile || currentFile.rootPath !== rootPath || currentFile.relativePath !== relativePath) {
      return 'stale';
    }

    const session = editorSessionRef.current;
    if (!isTextReadResponse(diskFile)) {
      if (session?.isDirty) {
        reportConflict(rootPath, relativePath, 'modified');
        return 'conflict';
      }
      replaceFromDisk(diskFile);
      return 'adopted';
    }

    const rawVersionChanged = diskFile.kind === 'editable-text'
      && currentFile.contentVersion !== undefined
      && diskFile.contentVersion !== currentFile.contentVersion;
    if (diskFile.content === currentFile.content && !rawVersionChanged) return 'base';
    if (diskFile.content === currentFile.content && diskFile.kind === 'editable-text') {
      if (session?.isDirty) {
        reportConflict(rootPath, relativePath, 'modified');
        return 'conflict';
      }
      // The normalized text is unchanged, so the raw hash difference is a
      // BOM/EOL change. Remount to give the immutable session exact metadata.
      replaceFromDisk(diskFile);
      return 'adopted';
    }

    const localContent = session?.isDirty ? session.snapshot() : currentFile.content;
    if (diskFile.content === localContent && diskFile.kind === 'editable-text') {
      if (
        session
        && (diskFile.eol !== session.eol || diskFile.hasBom !== session.hasBom)
      ) {
        reportConflict(rootPath, relativePath, 'modified');
        return 'conflict';
      }
      session?.adoptPersistedContentVersion(diskFile.contentVersion);
      setFileContent(localContent, rootPath, relativePath, {
        contentVersion: diskFile.contentVersion,
        eol: diskFile.eol,
        hasBom: diskFile.hasBom,
      });
      return 'saved';
    }
    if (session?.isDirty) {
      reportConflict(rootPath, relativePath, 'modified');
      return 'conflict';
    }

    replaceFromDisk(diskFile);
    return 'adopted';
  }, [replaceFromDisk, reportConflict, setFileContent]);

  const flushPendingSave = useCallback((): Promise<boolean> => {
    return editorSessionRef.current?.flush() ?? Promise.resolve(true);
  }, []);

  useEffect(() => {
    setPendingFileSaveHandler(flushPendingSave);
    return () => setPendingFileSaveHandler(null);
  }, [flushPendingSave, setPendingFileSaveHandler]);

  const waitForPendingSaves = useCallback(async (): Promise<void> => {
    await editorSessionRef.current?.waitForPendingSaves();
  }, []);

  const reconcileFileChange = useCallback(async (
    event: FileChangedEvent,
    reportMissing: boolean,
  ): Promise<void> => {
    await waitForPendingSaves();
    let diskFile: FileReadResponse;
    try {
      diskFile = await readFileContent({
        relativePath: event.relativePath,
        rootPath: event.rootPath,
      });
    } catch (error) {
      rendererLog.warn(FILE_VIEWER_LOG_SCOPE, 'Failed to reconcile changed file', {
        error,
        relativePath: event.relativePath,
        rootPath: event.rootPath,
      });
      return;
    }

    if (diskFile.kind === 'error') {
      rendererLog.warn(FILE_VIEWER_LOG_SCOPE, 'Changed file read returned an error', {
        error: diskFile.message,
        relativePath: event.relativePath,
        rootPath: event.rootPath,
      });
      if (reportMissing && diskFile.code === 'NOT_FOUND') {
        reportConflict(event.rootPath, event.relativePath, 'deleted');
      }
      return;
    }
    reconcileDiskFile(event.rootPath, event.relativePath, diskFile);
  }, [reconcileDiskFile, reportConflict, waitForPendingSaves]);

  const cancelPendingDeletion = useCallback((key?: string) => {
    const pendingDeletion = pendingDeletionRef.current;
    if (!pendingDeletion || (key && pendingDeletion.fileKey !== key)) return;
    clearTimeout(pendingDeletion.timer);
    pendingDeletionRef.current = null;
  }, []);

  useEffect(() => () => cancelPendingDeletion(), [cancelPendingDeletion, viewingFileKey]);

  useEffect(() => () => {
    if (formatRequestRef.current) void cancelFormatFileContent(formatRequestRef.current);
  }, [viewingFileKey]);

  const handleFileChanged = useCallback((event: unknown) => {
    if (!isFileChangedEvent(event)) return;
    const currentFile = useFileBrowserStore.getState().viewingFile;
    if (!currentFile || currentFile.rootPath !== event.rootPath || currentFile.relativePath !== event.relativePath) {
      return;
    }

    const currentKey = fileKey(currentFile.rootPath, currentFile.relativePath);

    if (event.changeType === 'unlink') {
      // A move deletes the source path on purpose; the remap follows, so this is not a disk deletion.
      // Containment matters: a moved folder takes the open file inside it with it.
      const { activeMove } = useFileBrowserStore.getState();
      if (isPathInActiveMove(activeMove, currentFile.rootPath, currentFile.relativePath)) return;
      cancelPendingDeletion();
      const timer = setTimeout(() => {
        if (pendingDeletionRef.current?.timer === timer) pendingDeletionRef.current = null;
        const reconcile = () => reconcileFileChange(event, true);
        fileChangeQueueRef.current = fileChangeQueueRef.current.then(reconcile, reconcile);
      }, FILE_DELETION_GRACE_MS);
      pendingDeletionRef.current = { fileKey: currentKey, timer };
      return;
    }
    if (event.changeType !== 'add' && event.changeType !== 'change') return;
    cancelPendingDeletion(currentKey);
    const reconcile = () => reconcileFileChange(event, false);
    fileChangeQueueRef.current = fileChangeQueueRef.current.then(reconcile, reconcile);
  }, [cancelPendingDeletion, reconcileFileChange]);

  useIpcListener(IPC_EVENT.FILE_CHANGED, handleFileChanged);

  if (!viewingFile) return null;
  const activeFile = viewingFile;

  function handleCopy(): void {
    clipboardWrite(editorSessionRef.current?.snapshot() ?? viewingFile?.content ?? '');
  }

  function handleClose(): void {
    if (onClose) onClose();
    else void closeFile();
  }

  function handleReload(): void {
    void reloadOpenFile();
  }

  function handleRestoreDeletedFile(): void {
    void editorSessionRef.current?.flush({ expectedMissing: true });
  }

  function handleModeChange(nextMode: ViewMode): void {
    if (mode === 'code' && nextMode === 'display') {
      void flushPendingSave().then((saved) => {
        if (saved) setMode(nextMode);
      });
      return;
    }
    setMode(nextMode);
  }

  function handleSaveConflict(response: Extract<FileWriteResponse, { success: false }>): void {
    reportConflict(
      activeFile.rootPath,
      activeFile.relativePath,
      response.conflictType ?? 'modified',
    );
  }

  function handleSaveError(): void {
    addToast('Failed to save file', 'error');
  }

  function handleFormatDocument(): void {
    const session = editorSessionRef.current;
    if (!session || session.isDisposed || readOnly || conflictDetected || formatting) return;
    const documentVersion = session.documentVersion;
    const requestId = globalThis.crypto.randomUUID();
    formatRequestRef.current = requestId;
    setFormatting(true);
    void formatFileContent({
      content: session.snapshot(),
      documentVersion,
      editorSessionId: session.editorSessionId,
      eol: session.eol,
      fileKey: session.fileKey,
      relativePath: activeFile.relativePath,
      requestId,
      rootPath: activeFile.rootPath,
    }).then((response) => {
      if (
        editorSessionRef.current !== session
        || session.isDisposed
        || session.documentVersion !== documentVersion
      ) return;
      if (!response.success) {
        if (response.code !== 'SUPERSEDED') addToast(response.error, 'error');
        return;
      }
      if (response.status === 'ignored') {
        addToast('File is ignored by Prettier', 'info');
      } else if (response.status === 'unchanged') {
        addToast('Document is already formatted', 'info');
      } else {
        session.applyChanges(response.changes);
      }
    }).catch((error: unknown) => {
      rendererLog.warn(FILE_VIEWER_LOG_SCOPE, 'Format document failed', { error });
      addToast('Failed to format document', 'error');
    }).finally(() => {
      if (formatRequestRef.current === requestId) formatRequestRef.current = null;
      if (editorSessionRef.current === session) setFormatting(false);
    });
  }

  function handleSaved(
    content: string,
    response: Extract<FileWriteResponse, { success: true }>,
  ): void {
    setFileContent(content, activeFile.rootPath, activeFile.relativePath, {
      contentVersion: response.contentVersion,
      eol: activeFile.eol,
      hasBom: activeFile.hasBom,
    });
  }

  return (
    <div
      data-testid="file-viewer"
      className={cn(FILE_VIEWER_PANEL_CLASS, viewerCrowded && FILE_BROWSER_CROWDED_VIEWER_CLASS)}
    >
      <FileViewerHeader
        binary={binary}
        conflictDetected={conflictDetected}
        conflictType={viewingFile.conflictType}
        fileName={fileName}
        isMd={isMarkdownFile(fileName)}
        mode={mode}
        formatting={formatting}
        formatDisabled={readOnly}
        languageIntelligence={languageIntelligence}
        readOnlyReason={viewingFile.readOnlyReason}
        relativePath={viewingFile.relativePath}
        wordWrap={wordWrap}
        onClose={handleClose}
        onCopy={handleCopy}
        onModeChange={handleModeChange}
        onFormatDocument={handleFormatDocument}
        onReload={handleReload}
        onRestoreDeletedFile={handleRestoreDeletedFile}
        onToggleWrap={() => setWordWrap((value) => !value)}
      />

      <div className="flex-1 overflow-hidden">
        {viewingFile.loading ? (
          <div className="flex h-full items-center justify-center text-[12px] text-(--text-muted)">
            Loading...
          </div>
        ) : viewingFile.error ? (
          <div className="flex h-full items-center justify-center text-[12px] text-(--error)">
            {viewingFile.error}
          </div>
        ) : unsupported ? (
          <div className="flex h-full items-center justify-center text-[12px] text-(--text-muted)">
            {binary ? 'Binary file — preview not available' : 'Invalid UTF-8 — preview not available'}
          </div>
        ) : mode === 'display' ? (
          <div className="h-full overflow-auto p-4">
            <ProseMarkdown
              content={viewingFile.content}
              relativePath={viewingFile.relativePath}
              rootPath={viewingFile.rootPath}
              variant="document"
            />
          </div>
        ) : (
          <CodeMirrorEditor
            key={`${viewingFileKey}:${editorGeneration}`}
            content={viewingFile.content}
            contentVersion={viewingFile.contentVersion}
            eol={viewingFile.eol}
            enableCompletion={viewingFile.capabilityTier !== 'reduced'}
            enableLint={viewingFile.capabilityTier !== 'reduced'}
            fileKey={viewingFileKey}
            fileName={fileName}
            hasBom={viewingFile.hasBom}
            highlightQuery={viewingFile.highlightQuery}
            openSearchPanelRequestKey={openSearchPanelRequestKey}
            readOnly={readOnly || conflictDetected}
            relativePath={viewingFile.relativePath}
            rootPath={viewingFile.rootPath}
            scrollToLine={viewingFile.scrollToLine}
            wordWrap={wordWrap}
            onConflict={handleSaveConflict}
            onError={handleSaveError}
            onFormatDocument={handleFormatDocument}
            onLanguageIntelligenceStatus={(status, detail) => setLanguageIntelligence({ detail, status })}
            onSaved={handleSaved}
            onSessionReady={(session) => {
              editorSessionRef.current = session;
            }}
          />
        )}
      </div>
    </div>
  );
}

interface FileViewerHeaderProps {
  binary: boolean;
  conflictDetected: boolean;
  conflictType?: FileMutationConflictType;
  fileName: string;
  isMd: boolean;
  mode: ViewMode;
  formatting: boolean;
  formatDisabled: boolean;
  languageIntelligence: { detail?: string; status: LanguageIntelligenceStatus };
  readOnlyReason?: 'truncated' | 'mixed-eol';
  relativePath: string;
  wordWrap: boolean;
  onClose: () => void;
  onCopy: () => void;
  onFormatDocument: () => void;
  onModeChange: (mode: ViewMode) => void;
  onReload: () => void;
  onRestoreDeletedFile: () => void;
  onToggleWrap: () => void;
}

function FileViewerHeader({
  binary,
  conflictDetected,
  conflictType,
  fileName,
  isMd,
  mode,
  formatting,
  formatDisabled,
  languageIntelligence,
  onClose,
  onCopy,
  onFormatDocument,
  onModeChange,
  onReload,
  onRestoreDeletedFile,
  onToggleWrap,
  readOnlyReason,
  relativePath,
  wordWrap,
}: FileViewerHeaderProps) {
  return (
    <div className="flex h-9 shrink-0 items-center gap-2 border-b border-(--border) px-3">
      <FileCode2 size={14} className="shrink-0 text-(--text-muted)" />
      <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-(--text)" title={relativePath}>
        {fileName}
      </span>

      {readOnlyReason && (
        <span className="flex shrink-0 items-center gap-1 text-[10px] text-(--warning)">
          <AlertTriangle size={10} />
          {readOnlyReason === 'truncated' ? 'Truncated preview' : 'Mixed line endings'}
        </span>
      )}

      {conflictDetected && (
        <>
          <span className="flex shrink-0 items-center gap-1 text-[10px] text-(--error)">
            <AlertTriangle size={10} />
            {conflictType === 'deleted' ? 'File deleted' : 'File changed'}
          </span>
          {conflictType === 'deleted' ? (
            <button
              aria-label="Recreate file from local edits"
              className="flex shrink-0 items-center gap-1 rounded px-1 py-0.5 text-[10px] text-(--error) transition-colors hover:bg-(--surface-raised)"
              onClick={onRestoreDeletedFile}
              title="Recreate file from local edits"
            >
              <RotateCcw size={10} />
              Recreate
            </button>
          ) : (
            <button
              aria-label="Discard local edits and reload from disk"
              className="flex shrink-0 items-center gap-1 rounded px-1 py-0.5 text-[10px] text-(--error) transition-colors hover:bg-(--surface-raised)"
              onClick={onReload}
              title="Discard local edits and reload from disk"
            >
              <RotateCcw size={10} />
              Reload
            </button>
          )}
        </>
      )}

      {languageIntelligence.status !== 'idle' && (
        <span
          className="shrink-0 text-[10px] text-(--text-muted)"
          role="status"
          title={languageIntelligence.detail}
        >
          {languageIntelligence.status === 'starting'
            ? 'TS: starting…'
            : languageIntelligence.status === 'ready'
              ? 'TS: ready'
              : 'TS: syntax only'}
        </span>
      )}

      {!binary && isMd && <MdPreviewToggle mode={mode} onModeChange={onModeChange} />}

      <button
        aria-label="Format document"
        className="shrink-0 rounded p-0.5 text-(--text-muted) transition-colors hover:text-(--text) disabled:opacity-50"
        disabled={binary || conflictDetected || formatDisabled || formatting || readOnlyReason !== undefined}
        onClick={onFormatDocument}
        title="Format document (Shift+Alt+F)"
      >
        <Braces size={12} />
      </button>

      <button
        aria-label="Copy file content"
        onClick={onCopy}
        className="shrink-0 rounded p-0.5 text-(--text-muted) transition-colors hover:text-(--text)"
        title="Copy file content"
      >
        <Copy size={12} />
      </button>
      <button
        aria-label="Toggle word wrap"
        onClick={onToggleWrap}
        className={cn(
          'shrink-0 rounded p-0.5 transition-colors',
          wordWrap ? 'text-(--accent)' : 'text-(--text-muted) hover:text-(--text)',
        )}
        title="Toggle word wrap"
      >
        <WrapText size={12} />
      </button>
      <button
        aria-label="Close file viewer"
        onClick={onClose}
        className="shrink-0 rounded p-0.5 text-(--text-muted) transition-colors hover:text-(--error)"
        title="Close file viewer"
      >
        <X size={12} />
      </button>
    </div>
  );
}

function MdPreviewToggle({
  mode,
  onModeChange,
}: { mode: ViewMode; onModeChange: (mode: ViewMode) => void }) {
  const label = mode === 'display' ? 'Edit markdown' : 'Preview markdown';
  return (
    <button
      aria-label={label}
      onClick={() => onModeChange(mode === 'display' ? 'code' : 'display')}
      className={cn(
        'shrink-0 rounded p-0.5 transition-colors',
        mode === 'display'
          ? 'text-(--accent)'
          : 'text-(--text-muted) hover:text-(--text)',
      )}
      title={label}
    >
      {mode === 'display' ? <Pencil size={12} /> : <Eye size={12} />}
    </button>
  );
}
