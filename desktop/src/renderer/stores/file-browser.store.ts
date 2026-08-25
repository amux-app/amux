import { create } from 'zustand';
import {
  dropCachedSubtree,
  fileKey,
  folderColorKey,
  remapExpandedDirs,
  remapFolderColors,
  remapViewingFile,
  treeKey,
  type ActiveFileMove,
  type FileMoveRemap,
} from './file-browser-remap';
import type {
  FileEntry,
  FileEol,
  FileMutationConflictType,
  FileReadResponse,
} from '../../shared/ipc-types';
import { listFiles, readFileContent } from '../api/file.api';
import { rendererLog } from '../lib/rendererLog';
import {
  getFileEditorCapabilityTier,
  type FileEditorCapabilityTier,
} from '../components/file-browser/fileEditorCapabilities';

type PendingFileSaveHandler = () => Promise<boolean>;

interface ViewingFile {
  rootPath: string;
  relativePath: string;
  content: string;
  contentVersion?: string;
  eol?: FileEol;
  hasBom?: boolean;
  readOnlyReason?: 'truncated' | 'mixed-eol';
  sizeBytes?: number;
  unsupportedReason?: 'binary' | 'invalid-utf8';
  loading: boolean;
  conflictDetected?: boolean;
  conflictType?: FileMutationConflictType;
  capabilityTier?: FileEditorCapabilityTier;
  error?: string;
  highlightQuery?: string;
  scrollToLine?: number;
}

interface FileTreeCreating {
  dir: string;
  rootPath: string;
  type: 'file' | 'folder';
}

export interface FileClipboard {
  mode: 'copy' | 'cut';
  rootPath: string;
  paths: string[];
}

interface OpenFileExtras {
  highlightQuery?: string;
  scrollToLine?: number;
}

interface FileContentMetadata {
  contentVersion?: string;
  eol?: FileEol;
  hasBom?: boolean;
  readOnlyReason?: 'truncated' | 'mixed-eol';
  sizeBytes?: number;
}

interface FileBrowserState {
  /**
   * The window in which the filesystem is actually being mutated, published immediately before the
   * IPC call so the editor can tell our own source `unlink` from a real on-disk deletion. It is not
   * the concurrency guard — that is a ref in `useFileTreeMutations`, claimed earlier, because a slow
   * or refused editor flush must not widen this window.
   */
  activeMove: ActiveFileMove | null;
  clipboard: FileClipboard | null;
  /** Carries its own root so switching panes mid-create cannot render the input in another worktree. */
  creating: FileTreeCreating | null;
  draftResetKey: number;
  expandedDirs: Record<string, Set<string>>;
  findInFileRequestKey: number;
  folderColors: Record<string, string>;
  isOpen: boolean;
  pendingFileSaveHandler: PendingFileSaveHandler | null;
  trees: Record<string, FileEntry[]>;
  viewerCrowded: boolean;
  viewingFile: ViewingFile | null;
}

interface FileBrowserActions {
  clearClipboard: () => void;
  collapseAll: (rootPath: string) => void;
  clearFolderColor: (rootPath: string, relativePath: string) => void;
  clearTree: (rootPath: string) => void;
  close: () => Promise<void>;
  closeFile: (options?: { flushPendingSave?: boolean }) => Promise<boolean>;
  flushPendingFileSave: () => Promise<boolean>;
  loadDir: (rootPath: string, dirPath: string) => Promise<void>;
  open: () => void;
  openFile: (rootPath: string, relativePath: string, scrollToLine?: number, highlightQuery?: string) => Promise<void>;
  openFileAtLine: (rootPath: string, relativePath: string, lineNumber: number, query: string) => Promise<void>;
  refresh: (rootPath: string) => Promise<void>;
  reloadOpenFile: () => Promise<void>;
  remapAfterMove: (rootPath: string, moves: readonly FileMoveRemap[]) => void;
  requestFindInFile: () => void;
  setActiveMove: (activeMove: ActiveFileMove | null) => void;
  setClipboard: (clipboard: FileClipboard) => void;
  setCreating: (creating: FileTreeCreating | null) => void;
  setFileConflict: (
    rootPath: string,
    relativePath: string,
    conflictDetected: boolean,
    conflictType?: FileMutationConflictType,
  ) => void;
  setFileContent: (
    content: string,
    rootPath: string,
    relativePath: string,
    metadata?: FileContentMetadata,
  ) => void;
  setFolderColor: (rootPath: string, relativePath: string, color: string) => void;
  setPendingFileSaveHandler: (handler: PendingFileSaveHandler | null) => void;
  setViewerCrowded: (crowded: boolean) => void;
  toggle: () => void;
  toggleDir: (rootPath: string, dirPath: string) => void;
}

export { fileKey, folderColorKey, isPathInActiveMove } from './file-browser-remap';
export type { ActiveFileMove, FileMoveRemap } from './file-browser-remap';

const FILE_BROWSER_LOG_SCOPE = 'file-browser:store';
const FOLDER_COLORS_KEY = 'muxbase-folder-colors';
const PENDING_FILE_SAVE_TIMEOUT_MS = 5_000;

const latestOpenFileExtras = new Map<string, OpenFileExtras>();
const pendingFileReads = new Map<string, Promise<void>>();
const pendingLoads = new Map<string, Promise<void>>();
const queuedLoads = new Set<string>();

let openFileRequestId = 0;

function loadFolderColors(): Record<string, string> {
  const raw = localStorage.getItem(FOLDER_COLORS_KEY);
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function saveFolderColors(colors: Record<string, string>): void {
  localStorage.setItem(FOLDER_COLORS_KEY, JSON.stringify(colors));
}

function invalidateOpenFileRead(viewingFile: ViewingFile): OpenFileExtras {
  openFileRequestId += 1;
  const key = fileKey(viewingFile.rootPath, viewingFile.relativePath);
  pendingFileReads.delete(key);
  latestOpenFileExtras.delete(key);
  return {
    highlightQuery: viewingFile.highlightQuery,
    scrollToLine: viewingFile.scrollToLine,
  };
}

function isViewingFile(viewingFile: ViewingFile | null, rootPath: string, relativePath: string): viewingFile is ViewingFile {
  return viewingFile?.rootPath === rootPath && viewingFile.relativePath === relativePath;
}

export function readResponseState(response: FileReadResponse): Pick<
  ViewingFile,
  | 'content'
  | 'capabilityTier'
  | 'contentVersion'
  | 'eol'
  | 'error'
  | 'hasBom'
  | 'readOnlyReason'
  | 'sizeBytes'
  | 'unsupportedReason'
> {
  switch (response.kind) {
    case 'editable-text':
      return {
        capabilityTier: getFileEditorCapabilityTier(
          response.content,
          new TextEncoder().encode(response.content).byteLength + (response.hasBom ? 3 : 0),
        ),
        content: response.content,
        contentVersion: response.contentVersion,
        eol: response.eol,
        hasBom: response.hasBom,
      };
    case 'readonly-text':
      return {
        content: response.content,
        hasBom: response.hasBom,
        readOnlyReason: response.reason,
        sizeBytes: response.sizeBytes,
      };
    case 'unsupported':
      return {
        content: '',
        sizeBytes: response.sizeBytes,
        unsupportedReason: response.reason,
      };
    case 'error':
      return { content: '', error: response.message };
  }
}

function withPendingFileSaveTimeout(save: Promise<boolean>): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<boolean>((resolveTimeout) => {
    timer = setTimeout(() => {
      rendererLog.warn(FILE_BROWSER_LOG_SCOPE, 'Pending file save timed out', {
        timeoutMs: PENDING_FILE_SAVE_TIMEOUT_MS,
      });
      resolveTimeout(false);
    }, PENDING_FILE_SAVE_TIMEOUT_MS);
  });

  return Promise.race([save, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

export const useFileBrowserStore = create<FileBrowserState & FileBrowserActions>((set, get) => {
  const readFileIntoViewer = async (
    rootPath: string,
    relativePath: string,
    scrollToLine?: number,
    highlightQuery?: string,
  ): Promise<void> => {
    const key = fileKey(rootPath, relativePath);
    const extras = { highlightQuery, scrollToLine };
    latestOpenFileExtras.set(key, extras);

    const pendingRead = pendingFileReads.get(key);
    if (pendingRead) {
      set((state) => {
        if (!isViewingFile(state.viewingFile, rootPath, relativePath)) {
          return state;
        }
        return { viewingFile: { ...state.viewingFile, ...extras } };
      });
      await pendingRead;
      return;
    }

    const requestId = ++openFileRequestId;
    set({
      viewerCrowded: false,
      viewingFile: { content: '', loading: true, relativePath, rootPath, ...extras },
    });

    const readPromise = (async () => {
      try {
        const response = await readFileContent({ relativePath, rootPath });
        if (requestId !== openFileRequestId) return;
        if (response.kind === 'error') {
          rendererLog.warn(FILE_BROWSER_LOG_SCOPE, 'File read returned an error', {
            error: response.message,
            relativePath,
            rootPath,
          });
        }
        set((state) => ({
          draftResetKey: state.draftResetKey + 1,
          viewingFile: {
            ...readResponseState(response),
            loading: false,
            relativePath,
            rootPath,
            ...latestOpenFileExtras.get(key),
          },
        }));
      } catch (error) {
        if (requestId !== openFileRequestId) return;
        rendererLog.warn(FILE_BROWSER_LOG_SCOPE, 'File read failed', { error, relativePath, rootPath });
        set((state) => ({
          draftResetKey: state.draftResetKey + 1,
          viewingFile: {
            content: '',
            error: 'Failed to read file',
            loading: false,
            relativePath,
            rootPath,
            ...latestOpenFileExtras.get(key),
          },
        }));
      }
    })();

    pendingFileReads.set(key, readPromise);
    try {
      await readPromise;
    } finally {
      if (pendingFileReads.get(key) === readPromise) {
        pendingFileReads.delete(key);
      }
      latestOpenFileExtras.delete(key);
    }
  };

  return {
  activeMove: null,
  clipboard: null,
  creating: null,
  draftResetKey: 0,
  expandedDirs: {},
  findInFileRequestKey: 0,
  folderColors: loadFolderColors(),
  isOpen: false,
  pendingFileSaveHandler: null,
  trees: {},
  viewerCrowded: false,
  viewingFile: null,

  toggle: () => set((s) => ({ isOpen: !s.isOpen, viewerCrowded: s.isOpen ? false : s.viewerCrowded })),
  open: () => set({ isOpen: true }),
  close: async () => {
    set({ isOpen: false, viewerCrowded: false });
  },

  loadDir: async (rootPath, dirPath) => {
    const key = treeKey(rootPath, dirPath);
    const runLoad = async () => {
      try {
        const response = await listFiles({ dirPath, rootPath });
        if (response.error) {
          rendererLog.warn(FILE_BROWSER_LOG_SCOPE, 'Directory load returned an error', {
            dirPath,
            error: response.error,
            rootPath,
          });
        }
        set((s) => ({
          trees: { ...s.trees, [key]: response.entries },
        }));
      } catch (error) {
        rendererLog.warn(FILE_BROWSER_LOG_SCOPE, 'Directory load failed', { dirPath, error, rootPath });
        set((s) => ({
          trees: { ...s.trees, [key]: [] },
        }));
      }
    };

    const existing = pendingLoads.get(key);
    if (existing) {
      queuedLoads.add(key);
      await existing;
      if (!queuedLoads.delete(key)) {
        return;
      }
    }

    let shouldLoad = true;
    while (shouldLoad) {
      const load = runLoad();
      pendingLoads.set(key, load);
      await load;
      if (pendingLoads.get(key) === load) {
        pendingLoads.delete(key);
      }
      shouldLoad = queuedLoads.delete(key);
    }
  },

  toggleDir: (rootPath, dirPath) => {
    const state = get();
    const expanded = state.expandedDirs[rootPath] ?? new Set<string>();
    const next = new Set(expanded);

    if (next.has(dirPath)) {
      next.delete(dirPath);
    } else {
      next.add(dirPath);
      const key = treeKey(rootPath, dirPath);
      if (!state.trees[key]) {
        void state.loadDir(rootPath, dirPath);
      }
    }

    set((s) => ({
      expandedDirs: { ...s.expandedDirs, [rootPath]: next },
    }));
  },

  refresh: async (rootPath) => {
    const expanded = get().expandedDirs[rootPath] ?? new Set<string>();
    const dirs = ['', ...expanded];
    await Promise.all(dirs.map((dir) => get().loadDir(rootPath, dir)));
  },

  clearTree: (rootPath) =>
    set((s) => {
      const trees = { ...s.trees };
      const expandedDirs = { ...s.expandedDirs };
      for (const key of Object.keys(trees)) {
        if (key === rootPath || key.startsWith(`${rootPath}::`)) {
          delete trees[key];
        }
      }
      delete expandedDirs[rootPath];
      return { expandedDirs, trees };
    }),

  openFile: async (rootPath, relativePath, scrollToLine?, highlightQuery?) => {
    const canContinue = await get().flushPendingFileSave();
    if (!canContinue) {
      return;
    }
    await readFileIntoViewer(rootPath, relativePath, scrollToLine, highlightQuery);
  },

  openFileAtLine: async (rootPath, relativePath, lineNumber, query) => {
    const existing = get().viewingFile;
    if (existing && existing.rootPath === rootPath && existing.relativePath === relativePath && !existing.loading && existing.content) {
      set({ viewingFile: { ...existing, highlightQuery: query, scrollToLine: lineNumber } });
      return;
    }
    return get().openFile(rootPath, relativePath, lineNumber, query);
  },

  reloadOpenFile: async () => {
    const current = get().viewingFile;
    if (!current || current.loading) {
      return;
    }

    try {
      const response = await readFileContent({ relativePath: current.relativePath, rootPath: current.rootPath });
      if (response.kind === 'error') {
        rendererLog.warn(FILE_BROWSER_LOG_SCOPE, 'Open file reload returned an error', {
          error: response.message,
          relativePath: current.relativePath,
          rootPath: current.rootPath,
        });
        return;
      }
      set((s) => {
        if (!isViewingFile(s.viewingFile, current.rootPath, current.relativePath)) {
          return s;
        }
        return {
          draftResetKey: s.draftResetKey + 1,
          viewingFile: {
            ...s.viewingFile,
            conflictDetected: false,
            conflictType: undefined,
            ...readResponseState(response),
            loading: false,
          },
        };
      });
    } catch (error) {
      rendererLog.warn(FILE_BROWSER_LOG_SCOPE, 'Open file reload failed', {
        error,
        relativePath: current.relativePath,
        rootPath: current.rootPath,
      });
      set((s) => {
        if (!isViewingFile(s.viewingFile, current.rootPath, current.relativePath)) {
          return s;
        }
        return { viewingFile: { ...s.viewingFile, error: 'Failed to reload file' } };
      });
    }
  },

  setFileContent: (content, rootPath, relativePath, metadata) =>
    set((s) => {
      if (!isViewingFile(s.viewingFile, rootPath, relativePath)) {
        return s;
      }

      return {
        viewingFile: {
          ...s.viewingFile,
          conflictDetected: false,
          conflictType: undefined,
          content,
          contentVersion: metadata?.contentVersion ?? s.viewingFile.contentVersion,
          eol: metadata?.eol ?? s.viewingFile.eol,
          error: undefined,
          hasBom: metadata?.hasBom ?? s.viewingFile.hasBom,
          readOnlyReason: metadata?.readOnlyReason,
          sizeBytes: metadata?.sizeBytes,
          unsupportedReason: undefined,
        },
      };
    }),

  setFileConflict: (rootPath, relativePath, conflictDetected, conflictType) =>
    set((s) => {
      if (!isViewingFile(s.viewingFile, rootPath, relativePath)) {
        return s;
      }

      return {
        viewingFile: {
          ...s.viewingFile,
          conflictDetected,
          conflictType: conflictDetected ? conflictType ?? s.viewingFile.conflictType : undefined,
        },
      };
    }),

  setViewerCrowded: (viewerCrowded) => set({ viewerCrowded }),

  setPendingFileSaveHandler: (pendingFileSaveHandler) => set({ pendingFileSaveHandler }),

  flushPendingFileSave: async () => {
    const handler = get().pendingFileSaveHandler;
    return handler ? withPendingFileSaveTimeout(handler()) : true;
  },

  closeFile: async (options) => {
    if (options?.flushPendingSave !== false) {
      const canClose = await get().flushPendingFileSave();
      if (!canClose) {
        return false;
      }
    }

    set({ pendingFileSaveHandler: null, viewerCrowded: false, viewingFile: null });
    return true;
  },

  requestFindInFile: () => {
    if (!get().viewingFile) {
      return;
    }
    set((s) => ({ findInFileRequestKey: s.findInFileRequestKey + 1 }));
  },

  setFolderColor: (rootPath, relativePath, color) => {
    const folderColors = { ...get().folderColors, [folderColorKey(rootPath, relativePath)]: color };
    set({ folderColors });
    saveFolderColors(folderColors);
  },

  clearFolderColor: (rootPath, relativePath) => {
    const key = folderColorKey(rootPath, relativePath);
    if (!(key in get().folderColors)) return;
    const folderColors = { ...get().folderColors };
    delete folderColors[key];
    set({ folderColors });
    saveFolderColors(folderColors);
  },

  setClipboard: (clipboard) => set({ clipboard }),
  clearClipboard: () => set({ clipboard: null }),

  setCreating: (creating) => set({ creating }),

  collapseAll: (rootPath) =>
    set((s) => ({ expandedDirs: { ...s.expandedDirs, [rootPath]: new Set<string>() } })),

  setActiveMove: (activeMove) => set({ activeMove }),

  remapAfterMove: (rootPath, moves) => {
    const state = get();
    const trees = { ...state.trees };
    const expanded = new Set(state.expandedDirs[rootPath] ?? []);
    let folderColors = state.folderColors;
    let viewingFile = state.viewingFile;

    for (const move of moves) {
      dropCachedSubtree(trees, rootPath, move.from);
      remapExpandedDirs(expanded, move);
      folderColors = remapFolderColors(folderColors, rootPath, move);
      viewingFile = remapViewingFile(viewingFile, rootPath, move);
    }

    const viewedFileWasRemapped = viewingFile !== state.viewingFile;
    const remappedExtras = viewedFileWasRemapped && state.viewingFile
      ? invalidateOpenFileRead(state.viewingFile)
      : null;

    set({
      expandedDirs: { ...state.expandedDirs, [rootPath]: expanded },
      folderColors,
      trees,
      viewingFile,
    });

    if (folderColors !== state.folderColors) {
      saveFolderColors(folderColors);
    }

    if (viewedFileWasRemapped && viewingFile && remappedExtras) {
      // The move orchestration already flushed the source before filesystem mutation. Reloading
      // the published destination must bypass the normal pre-open flush or a stale editor handler
      // could recreate the source path after the move completed.
      void readFileIntoViewer(
        viewingFile.rootPath,
        viewingFile.relativePath,
        remappedExtras.scrollToLine,
        remappedExtras.highlightQuery,
      ).catch((error: unknown) => {
        rendererLog.warn(FILE_BROWSER_LOG_SCOPE, 'Remapped file reload failed', {
          error,
          relativePath: viewingFile.relativePath,
          rootPath: viewingFile.rootPath,
        });
        set((current) => {
          if (!isViewingFile(current.viewingFile, viewingFile.rootPath, viewingFile.relativePath)) {
            return current;
          }
          return { viewingFile: { ...current.viewingFile, error: 'Failed to read file', loading: false } };
        });
      });
    }
  },
  };
});
