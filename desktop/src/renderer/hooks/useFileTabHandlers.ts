import { useCallback } from 'react';
import { type FileTab, useWorkspaceTabsStore } from '../stores';

const noScope = (): Promise<boolean> => Promise.resolve(false);

export function useFileTabHandlers(tabScopeId?: string) {
  const closeActiveTab = useWorkspaceTabsStore((state) => state.closeActiveTab);
  const closeAllTabs = useWorkspaceTabsStore((state) => state.closeAllTabs);
  const closeOtherTabs = useWorkspaceTabsStore((state) => state.closeOtherTabs);
  const closeTab = useWorkspaceTabsStore((state) => state.closeTab);
  const closeTabsToRight = useWorkspaceTabsStore((state) => state.closeTabsToRight);
  const setActiveTab = useWorkspaceTabsStore((state) => state.setActiveTab);

  const setActiveFileTab = useCallback((tabId: string | null): Promise<boolean> => (
    tabScopeId ? setActiveTab(tabScopeId, tabId) : noScope()
  ), [setActiveTab, tabScopeId]);

  const handleFileTabClick = useCallback((tab: FileTab): Promise<boolean> => (
    setActiveFileTab(tab.id)
  ), [setActiveFileTab]);

  const handleFileTabClose = useCallback((tab: FileTab): Promise<boolean> => (
    tabScopeId ? closeTab(tabScopeId, tab.id) : noScope()
  ), [closeTab, tabScopeId]);

  const handleFileTabCloseAll = useCallback((): Promise<boolean> => (
    tabScopeId ? closeAllTabs(tabScopeId) : noScope()
  ), [closeAllTabs, tabScopeId]);

  const handleFileTabCloseOthers = useCallback((tab: FileTab): Promise<boolean> => (
    tabScopeId ? closeOtherTabs(tabScopeId, tab.id) : noScope()
  ), [closeOtherTabs, tabScopeId]);

  const handleFileTabCloseToRight = useCallback((tab: FileTab): Promise<boolean> => (
    tabScopeId ? closeTabsToRight(tabScopeId, tab.id) : noScope()
  ), [closeTabsToRight, tabScopeId]);

  const closeActiveFileTab = useCallback((): Promise<boolean> => (
    tabScopeId ? closeActiveTab(tabScopeId) : noScope()
  ), [closeActiveTab, tabScopeId]);

  return {
    closeActiveFileTab,
    handleFileTabClick,
    handleFileTabClose,
    handleFileTabCloseAll,
    handleFileTabCloseOthers,
    handleFileTabCloseToRight,
    setActiveFileTab,
  };
}
