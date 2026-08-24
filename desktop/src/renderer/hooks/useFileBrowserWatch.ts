import { useEffect, useMemo, useRef } from 'react';
import { setFileWatchRoot } from '../api/file.api';
import { rendererLog } from '../lib/rendererLog';
import { useFileBrowserStore, usePaneStore } from '../stores';

const WATCH_ROOT_APPLY_DELAY_MS = 100;
const WATCH_LOG_SCOPE = 'file-browser:watch';

function applyWatchRoot(rootPath: string | undefined, dirPaths?: string[]): void {
  void setFileWatchRoot({ dirPaths, rootPath }).catch((error) => {
    rendererLog.warn(WATCH_LOG_SCOPE, 'Failed to update file watch root', { error, rootPath });
  });
}

function parentDir(filePath: string): string {
  const lastSlash = filePath.lastIndexOf('/');
  return lastSlash > 0 ? filePath.slice(0, lastSlash) : '';
}

export function useFileBrowserWatch(): void {
  const selectedPane = usePaneStore((state) =>
    state.panes.find((pane) => pane.id === state.selectedPaneId) ?? state.panes[0],
  );
  const selectedRootPath = selectedPane?.worktreePath ?? selectedPane?.projectRoot;
  const isBrowserOpen = useFileBrowserStore((state) => state.isOpen);
  const viewingFile = useFileBrowserStore((state) => state.viewingFile);
  const rootPath = viewingFile?.rootPath ?? (isBrowserOpen ? selectedRootPath : undefined);
  const expandedDirs = useFileBrowserStore((state) => (
    rootPath ? state.expandedDirs[rootPath] : undefined
  ));
  const watchActiveRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dirPaths = useMemo(() => {
    if (!rootPath) {
      return undefined;
    }

    const paths = new Set<string>(['']);
    for (const dirPath of expandedDirs ?? []) {
      paths.add(dirPath);
    }
    if (viewingFile?.rootPath === rootPath) {
      const openFileParent = parentDir(viewingFile.relativePath);
      if (openFileParent) paths.add(openFileParent);
    }
    return [...paths].sort();
  }, [expandedDirs, rootPath, viewingFile?.relativePath, viewingFile?.rootPath]);

  useEffect(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
    }
    if (!rootPath && !watchActiveRef.current) return;
    timerRef.current = setTimeout(() => {
      applyWatchRoot(rootPath, dirPaths);
      watchActiveRef.current = rootPath !== undefined;
      timerRef.current = null;
    }, WATCH_ROOT_APPLY_DELAY_MS);

    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [dirPaths, rootPath]);

  useEffect(() => {
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      if (watchActiveRef.current) applyWatchRoot(undefined);
      watchActiveRef.current = false;
    };
  }, []);
}
