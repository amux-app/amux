import { create } from 'zustand';
import { remapPath } from '../../shared/filePolicy';
import { useFileBrowserStore } from './file-browser.store';
import { useNotificationStore } from './notification.store';

export interface FileTab {
  id: string;
  rootPath: string;
  relativePath: string;
  fileName: string;
  openedAt: number;
}

interface WorkspaceTabsState {
  tabsByScope: Record<string, FileTab[]>;
  activeTabByScope: Record<string, string | null>;
}

interface WorkspaceTabsActions {
  openFile: (scopeId: string, rootPath: string, relativePath: string) => Promise<boolean>;
  openFileAtLine: (
    scopeId: string,
    rootPath: string,
    relativePath: string,
    lineNumber: number,
    query: string,
  ) => Promise<boolean>;
  closeTab: (scopeId: string, tabId: string) => Promise<boolean>;
  closeAllTabs: (scopeId: string) => Promise<boolean>;
  closeOtherTabs: (scopeId: string, tabId: string) => Promise<boolean>;
  closeTabsToRight: (scopeId: string, tabId: string) => Promise<boolean>;
  setActiveTab: (scopeId: string, tabId: string | null) => Promise<boolean>;
  closeActiveTab: (scopeId: string) => Promise<boolean>;
  remapFilePath: (rootPath: string, fromPath: string, toPath: string) => Promise<boolean>;
}

const EMPTY_TABS: readonly FileTab[] = Object.freeze([]);
const FLUSH_TIMEOUT_MS = 5_000;
const FLUSH_REFUSED_MESSAGE =
  'The open file could not be saved, so it stays open. Resolve the conflict in the editor (Reload) and try again.';
let workspaceTransitionQueue: Promise<void> = Promise.resolve();

function makeTabId(rootPath: string, relativePath: string): string {
  return `${rootPath}::${relativePath}`;
}

function activateScope(
  activeTabByScope: Record<string, string | null>,
  scopeId: string,
  tabId: string | null,
): Record<string, string | null> {
  if (tabId === null) {
    return { ...activeTabByScope, [scopeId]: null };
  }

  return Object.keys(activeTabByScope).reduce<Record<string, string | null>>((next, key) => {
    next[key] = key === scopeId ? tabId : null;
    return next;
  }, { [scopeId]: tabId });
}

function hasActiveTabInOtherScope(activeTabByScope: Record<string, string | null>, scopeId: string): boolean {
  return Object.entries(activeTabByScope).some(([key, tabId]) => key !== scopeId && tabId !== null);
}

function loadFileContent(tab: FileTab): void {
  void useFileBrowserStore.getState().openFile(tab.rootPath, tab.relativePath);
}

function loadFileContentAtLine(tab: FileTab, lineNumber: number, query: string): void {
  void useFileBrowserStore.getState().openFileAtLine(tab.rootPath, tab.relativePath, lineNumber, query);
}

function isViewerReadyForTab(tab: FileTab): boolean {
  const viewingFile = useFileBrowserStore.getState().viewingFile;
  return viewingFile?.rootPath === tab.rootPath
    && viewingFile.relativePath === tab.relativePath
    && !viewingFile.loading
    && !viewingFile.error;
}

function clearFileContent(): void {
  void useFileBrowserStore.getState().closeFile({ flushPendingSave: false });
}

function findTab(tabs: FileTab[], tabId: string): FileTab | undefined {
  return tabs.find((tab) => tab.id === tabId);
}

function containsTab(tabs: FileTab[], tabId: string | null | undefined): boolean {
  return tabId ? tabs.some((tab) => tab.id === tabId) : false;
}

function withFlushTimeout(flush: Promise<boolean>): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), FLUSH_TIMEOUT_MS);
  });
  return Promise.race([flush, expiry]).finally(() => clearTimeout(timer));
}

async function flushActiveFileDraft(): Promise<boolean> {
  const flushed = await withFlushTimeout(useFileBrowserStore.getState().flushPendingFileSave());
  if (!flushed) {
    useNotificationStore.getState().addToast(FLUSH_REFUSED_MESSAGE, 'error');
  }
  return flushed;
}

function queueWorkspaceTransition(operation: () => Promise<boolean>): Promise<boolean> {
  const queuedOperation = workspaceTransitionQueue.then(operation, operation);
  workspaceTransitionQueue = queuedOperation.then(
    () => undefined,
    () => undefined,
  );
  return queuedOperation;
}

export const useWorkspaceTabsStore = create<WorkspaceTabsState & WorkspaceTabsActions>((set, get) => ({
  tabsByScope: {},
  activeTabByScope: {},

  openFile: (scopeId, rootPath, relativePath) => queueWorkspaceTransition(async () => {
    const id = makeTabId(rootPath, relativePath);
    let state = get();
    let currentTabs = state.tabsByScope[scopeId] ?? [];
    let existing = currentTabs.find((tab) => tab.id === id);
    const alreadyActive = existing
      && state.activeTabByScope[scopeId] === id
      && !hasActiveTabInOtherScope(state.activeTabByScope, scopeId);

    if (existing && alreadyActive) {
      if (!isViewerReadyForTab(existing)) {
        loadFileContent(existing);
      }
      return true;
    }

    if (!await flushActiveFileDraft()) {
      return false;
    }

    state = get();
    currentTabs = state.tabsByScope[scopeId] ?? [];
    existing = currentTabs.find((tab) => tab.id === id);
    const tab: FileTab = existing ?? {
      id,
      rootPath,
      relativePath,
      fileName: relativePath.split('/').pop() ?? relativePath,
      openedAt: Date.now(),
    };

    set((s) => ({
      tabsByScope: existing
        ? s.tabsByScope
        : { ...s.tabsByScope, [scopeId]: [...currentTabs, tab] },
      activeTabByScope: activateScope(s.activeTabByScope, scopeId, id),
    }));

    loadFileContent(tab);
    return true;
  }),

  openFileAtLine: (scopeId, rootPath, relativePath, lineNumber, query) => queueWorkspaceTransition(async () => {
    const id = makeTabId(rootPath, relativePath);
    let state = get();
    let currentTabs = state.tabsByScope[scopeId] ?? [];
    let existing = currentTabs.find((tab) => tab.id === id);
    const alreadyActive = existing
      && state.activeTabByScope[scopeId] === id
      && !hasActiveTabInOtherScope(state.activeTabByScope, scopeId);

    if (existing && alreadyActive) {
      loadFileContentAtLine(existing, lineNumber, query);
      return true;
    }

    if (!await flushActiveFileDraft()) {
      return false;
    }

    state = get();
    currentTabs = state.tabsByScope[scopeId] ?? [];
    existing = currentTabs.find((tab) => tab.id === id);
    const tab: FileTab = existing ?? {
      id,
      rootPath,
      relativePath,
      fileName: relativePath.split('/').pop() ?? relativePath,
      openedAt: Date.now(),
    };

    set((s) => ({
      tabsByScope: existing
        ? s.tabsByScope
        : { ...s.tabsByScope, [scopeId]: [...currentTabs, tab] },
      activeTabByScope: activateScope(s.activeTabByScope, scopeId, id),
    }));

    loadFileContentAtLine(tab, lineNumber, query);
    return true;
  }),

  closeTab: (scopeId, tabId) => queueWorkspaceTransition(async () => {
    const state = get();
    const tabs = state.tabsByScope[scopeId] ?? [];
    const idx = tabs.findIndex((t) => t.id === tabId);
    if (idx < 0) return true;

    const nextTabs = tabs.filter((t) => t.id !== tabId);
    const wasActive = state.activeTabByScope[scopeId] === tabId;
    const nextActiveTab = wasActive ? (nextTabs[Math.min(idx, nextTabs.length - 1)] ?? null) : null;

    if (wasActive && !await flushActiveFileDraft()) {
      return false;
    }

    set((s) => {
      const patch: Partial<WorkspaceTabsState> = {
        tabsByScope: { ...s.tabsByScope, [scopeId]: nextTabs },
      };
      if (wasActive) {
        patch.activeTabByScope = { ...s.activeTabByScope, [scopeId]: nextActiveTab?.id ?? null };
      }
      return patch;
    });

    if (wasActive) {
      if (nextActiveTab) loadFileContent(nextActiveTab);
      else clearFileContent();
    }
    return true;
  }),

  closeTabsToRight: (scopeId, tabId) => queueWorkspaceTransition(async () => {
    const state = get();
    const tabs = state.tabsByScope[scopeId] ?? [];
    const idx = tabs.findIndex((tab) => tab.id === tabId);
    if (idx < 0 || idx === tabs.length - 1) return true;

    const nextTabs = tabs.slice(0, idx + 1);
    const activeTabId = state.activeTabByScope[scopeId];
    const nextActiveTab = activeTabId && !containsTab(nextTabs, activeTabId) ? tabs[idx] : undefined;

    if (nextActiveTab && !await flushActiveFileDraft()) {
      return false;
    }

    set((s) => ({
      tabsByScope: { ...s.tabsByScope, [scopeId]: nextTabs },
      activeTabByScope: nextActiveTab
        ? activateScope(s.activeTabByScope, scopeId, nextActiveTab.id)
        : s.activeTabByScope,
    }));

    if (nextActiveTab) loadFileContent(nextActiveTab);
    return true;
  }),

  closeOtherTabs: (scopeId, tabId) => queueWorkspaceTransition(async () => {
    const state = get();
    const tabs = state.tabsByScope[scopeId] ?? [];
    const tab = findTab(tabs, tabId);
    if (!tab) return true;

    const changesActiveFile = state.activeTabByScope[scopeId] !== tabId
      || hasActiveTabInOtherScope(state.activeTabByScope, scopeId);
    if (changesActiveFile && !await flushActiveFileDraft()) {
      return false;
    }

    set((s) => ({
      tabsByScope: { ...s.tabsByScope, [scopeId]: [tab] },
      activeTabByScope: activateScope(s.activeTabByScope, scopeId, tab.id),
    }));

    if (changesActiveFile) loadFileContent(tab);
    return true;
  }),

  closeAllTabs: (scopeId) => queueWorkspaceTransition(async () => {
    const state = get();
    const tabs = state.tabsByScope[scopeId] ?? [];
    if (tabs.length === 0) return true;

    const wasActive = state.activeTabByScope[scopeId] !== null && state.activeTabByScope[scopeId] !== undefined;
    if (wasActive && !await flushActiveFileDraft()) {
      return false;
    }

    set((s) => ({
      tabsByScope: { ...s.tabsByScope, [scopeId]: [] },
      activeTabByScope: { ...s.activeTabByScope, [scopeId]: null },
    }));

    if (wasActive) clearFileContent();
    return true;
  }),

  setActiveTab: (scopeId, tabId) => queueWorkspaceTransition(async () => {
    const state = get();
    const currentTabId = state.activeTabByScope[scopeId] ?? null;
    if (currentTabId === tabId && !hasActiveTabInOtherScope(state.activeTabByScope, scopeId)) {
      if (tabId) {
        const tab = (state.tabsByScope[scopeId] ?? []).find((t) => t.id === tabId);
        if (tab && !isViewerReadyForTab(tab)) loadFileContent(tab);
      }
      return true;
    }

    const tab = tabId ? findTab(state.tabsByScope[scopeId] ?? [], tabId) : undefined;
    if (tabId && !tab) {
      return false;
    }
    if (!await flushActiveFileDraft()) {
      return false;
    }

    set((s) => ({
      activeTabByScope: activateScope(s.activeTabByScope, scopeId, tabId),
    }));

    if (tab) {
      loadFileContent(tab);
    } else {
      clearFileContent();
    }
    return true;
  }),

  closeActiveTab: (scopeId) => {
    const active = get().activeTabByScope[scopeId];
    return active ? get().closeTab(scopeId, active) : Promise.resolve(true);
  },

  /**
   * Queued like every other tab mutation: the close and open actions capture their next tab array
   * before awaiting a draft flush, so an unqueued remap landing during that await would be silently
   * reverted, leaving a tab pointed at a path that no longer exists.
   */
  remapFilePath: (rootPath, fromPath, toPath) => queueWorkspaceTransition(async () => {
    set((s) => {
      const renamedIds = new Map<string, string>();
      const tabsByScope: Record<string, FileTab[]> = {};

      for (const [scopeId, tabs] of Object.entries(s.tabsByScope)) {
        tabsByScope[scopeId] = remapTabs(tabs, rootPath, fromPath, toPath, renamedIds);
      }
      if (renamedIds.size === 0) return s;

      return {
        activeTabByScope: Object.fromEntries(
          Object.entries(s.activeTabByScope)
            .map(([scopeId, tabId]) => [scopeId, tabId === null ? null : renamedIds.get(tabId) ?? tabId]),
        ),
        tabsByScope,
      };
    });
    return true;
  }),
}));

/**
 * Deduplicates by the final tab id while preferring the tab that was actually moved over a stale
 * tab already pointing at the destination. Replacing in place preserves the existing tab order.
 */
function remapTabs(
  tabs: FileTab[],
  rootPath: string,
  fromPath: string,
  toPath: string,
  renamedIds: Map<string, string>,
): FileTab[] {
  const nextTabs: FileTab[] = [];
  const indexById = new Map<string, number>();

  for (const tab of tabs) {
    const remapped = remapTab(tab, rootPath, fromPath, toPath, renamedIds);
    const existingIndex = indexById.get(remapped.id);
    if (existingIndex === undefined) {
      indexById.set(remapped.id, nextTabs.length);
      nextTabs.push(remapped);
    } else if (remapped !== tab) {
      nextTabs[existingIndex] = remapped;
    }
  }

  return nextTabs;
}

/** A tab id embeds its path, so a move invalidates the id, the path, and the displayed file name. */
function remapTab(
  tab: FileTab,
  rootPath: string,
  fromPath: string,
  toPath: string,
  renamedIds: Map<string, string>,
): FileTab {
  if (tab.rootPath !== rootPath) return tab;
  const relativePath = remapPath(fromPath, toPath, tab.relativePath);
  if (relativePath === null) return tab;

  const id = makeTabId(rootPath, relativePath);
  renamedIds.set(tab.id, id);
  return { ...tab, fileName: relativePath.split('/').pop() ?? relativePath, id, relativePath };
}

export function useFileTabsForScope(scopeId: string | undefined): readonly FileTab[] {
  return useWorkspaceTabsStore((s) => (scopeId ? s.tabsByScope[scopeId] ?? EMPTY_TABS : EMPTY_TABS));
}

export function useActiveFileTabId(scopeId: string | undefined): string | null {
  return useWorkspaceTabsStore((s) => (scopeId ? s.activeTabByScope[scopeId] ?? null : null));
}
