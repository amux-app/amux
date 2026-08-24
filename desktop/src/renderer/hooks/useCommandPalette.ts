import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AgentSessionSearchResult, ProjectFileSearchResult, ProjectTextSearchResult } from '../../shared/ipc-types';
import type { PaneActivity } from '../../shared/pane-activity';
import { searchSessions } from '../api/agent-session.api';
import { searchProjectFiles, searchProjectText } from '../api/system.api';
import { getCommandPaletteSearchScope } from '../lib/commandPaletteSearchScope';
import { getEffectivePaneStatus } from '../lib/pane-attention';
import { rendererLog } from '../lib/rendererLog';
import { useCommandPaletteStore, usePaneActivityStore, usePaneStore, useProjectStore, useUiStore, useWorkspacePickerStore, useWorkspaceTabsStore } from '../stores';
import { useWorktreeOverviewStore } from '../stores/worktree-overview.store';
import { usePaneActions } from './usePaneActions';
import { useThemePreference } from './useThemePreference';

export interface Command {
  id: string;
  label: string;
  shortcut?: string;
  section: string;
  action: () => void;
}

export interface SearchResult extends AgentSessionSearchResult {
  id: string;
}

export interface PaneResult {
  id: string;
  slug: string;
  agent?: string;
  status?: string;
}

const EMPTY_PANE_ACTIVITY: Record<string, PaneActivity> = {};

export function useCommandPalette() {
  const search = useCommandPaletteStore((s) => s.search);
  const close = useCommandPaletteStore((s) => s.close);
  const isOpen = useCommandPaletteStore((s) => s.isOpen);
  const activeTab = useCommandPaletteStore((s) => s.activeTab);
  const panes = usePaneStore((s) => s.panes);
  const paneActivityById = usePaneActivityStore((s) => (isOpen ? s.activityByPaneId : EMPTY_PANE_ACTIVITY));
  const selectedPaneId = usePaneStore((s) => s.selectedPaneId);
  const selectPane = usePaneStore((s) => s.selectPane);
  const setCreating = usePaneStore((s) => s.setCreating);
  const setThemePreference = useThemePreference();
  const theme = useUiStore((s) => s.theme);
  const setActiveView = useUiStore((s) => s.setActiveView);
  const focusPane = useUiStore((s) => s.focusPane);
  const viewMode = useUiStore((s) => s.viewMode);
  const focusPaneId = useUiStore((s) => s.focusPaneId);
  const openWorkspacePicker = useWorkspacePickerStore((s) => s.open);
  const openWorktreeOverview = useWorktreeOverviewStore((s) => s.open);
  const openFileTab = useWorkspaceTabsStore((s) => s.openFile);
  const openFileTabAtLine = useWorkspaceTabsStore((s) => s.openFileAtLine);
  const projectRoot = useProjectStore((s) => s.sessionProjectRoot);
  const { jumpToPane, mergePane, closePane, duplicatePane, createPane } = usePaneActions();

  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [fileResults, setFileResults] = useState<ProjectFileSearchResult[]>([]);
  const [textResults, setTextResults] = useState<ProjectTextSearchResult[]>([]);
  const [filesSearching, setFilesSearching] = useState(false);
  const [searching, setSearching] = useState(false);
  const [textSearching, setTextSearching] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const fileDebounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const fileRequestIdRef = useRef(0);
  const messageRequestIdRef = useRef(0);
  const textDebounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const textRequestIdRef = useRef(0);

  const searchScope = useMemo(
    () => getCommandPaletteSearchScope(panes, selectedPaneId, projectRoot),
    [panes, projectRoot, selectedPaneId],
  );
  const searchScopeRoot = searchScope?.rootPath ?? '';

  const shouldSearchMessages = (activeTab === 'messages' || activeTab === 'all') && search.length >= 2;
  const shouldSearchFiles = (activeTab === 'files' || activeTab === 'all') && search.length >= 2;
  const shouldSearchText = (activeTab === 'text' || activeTab === 'all') && search.length >= 2;

  useEffect(() => {
    const requestId = ++messageRequestIdRef.current;
    if (!isOpen) {
      setSearchResults([]);
      setSearching(false);
      return;
    }
    if (!shouldSearchMessages) {
      setSearchResults([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      try {
        const results = await searchSessions(search);
        if (requestId !== messageRequestIdRef.current) return;
        setSearchResults(results.map((r, i) => ({ ...r, id: `search-${r.paneId}-${r.messageId}-${i}` })));
      } catch (error) {
        if (requestId !== messageRequestIdRef.current) return;
        rendererLog.warn('command-palette:messages', 'Search failed', { error, query: search });
        setSearchResults([]);
      }
      if (requestId === messageRequestIdRef.current) {
        setSearching(false);
      }
    }, 200);
    return () => clearTimeout(debounceRef.current);
  }, [isOpen, shouldSearchMessages, search]);

  useEffect(() => {
    const requestId = ++fileRequestIdRef.current;
    if (!isOpen || !shouldSearchFiles || !searchScopeRoot) {
      setFileResults([]);
      setFilesSearching(false);
      return;
    }
    setFilesSearching(true);
    clearTimeout(fileDebounceRef.current);
    fileDebounceRef.current = setTimeout(async () => {
      try {
        const results = await searchProjectFiles(search, searchScopeRoot);
        if (requestId !== fileRequestIdRef.current) return;
        setFileResults(results);
      } catch (error) {
        if (requestId !== fileRequestIdRef.current) return;
        rendererLog.warn('command-palette:files', 'Search failed', { error, query: search, rootPath: searchScopeRoot });
        setFileResults([]);
      }
      if (requestId === fileRequestIdRef.current) {
        setFilesSearching(false);
      }
    }, 150);
    return () => clearTimeout(fileDebounceRef.current);
  }, [isOpen, search, searchScopeRoot, shouldSearchFiles]);

  useEffect(() => {
    const requestId = ++textRequestIdRef.current;
    if (!isOpen || !shouldSearchText || !searchScopeRoot) {
      setTextResults([]);
      setTextSearching(false);
      return;
    }
    setTextSearching(true);
    clearTimeout(textDebounceRef.current);
    textDebounceRef.current = setTimeout(async () => {
      try {
        const results = await searchProjectText(search, searchScopeRoot);
        if (requestId !== textRequestIdRef.current) return;
        setTextResults(results);
      } catch (error) {
        if (requestId !== textRequestIdRef.current) return;
        rendererLog.warn('command-palette:text', 'Search failed', { error, query: search, rootPath: searchScopeRoot });
        setTextResults([]);
      }
      if (requestId === textRequestIdRef.current) {
        setTextSearching(false);
      }
    }, 250);
    return () => clearTimeout(textDebounceRef.current);
  }, [isOpen, search, searchScopeRoot, shouldSearchText]);

  const navigateToResult = useCallback(
    (result: SearchResult) => {
      close();
      selectPane(result.paneId);
      focusPane(result.paneId, result.messageId);
    },
    [close, selectPane, focusPane],
  );

  const navigateToPane = useCallback(
    (paneId: string) => {
      close();
      selectPane(paneId);
      const pane = panes.find((p) => p.id === paneId);
      if (pane?.paneId) jumpToPane(pane.paneId);
    },
    [close, selectPane, panes, jumpToPane],
  );

  const resolveAndFocusScopePane = useCallback(
    (rootPath: string) => {
      if (!searchScope || !rootPath) return null;
      const targetPane = panes.find((p) => p.id === searchScope.scopeId);
      if (!targetPane) return null;
      close();
      selectPane(targetPane.id);
      if (viewMode !== 'focus' || focusPaneId !== targetPane.id) {
        focusPane(targetPane.id);
      }
      return targetPane;
    },
    [close, focusPane, focusPaneId, panes, searchScope, selectPane, viewMode],
  );

  const navigateToFile = useCallback(
    (rootPath: string, filePath: string) => {
      const targetPane = resolveAndFocusScopePane(rootPath);
      if (!targetPane) return;
      void openFileTab(targetPane.id, rootPath, filePath);
    },
    [openFileTab, resolveAndFocusScopePane],
  );

  const navigateToTextResult = useCallback(
    (rootPath: string, filePath: string, lineNumber: number, query: string) => {
      const targetPane = resolveAndFocusScopePane(rootPath);
      if (!targetPane) return;
      void openFileTabAtLine(targetPane.id, rootPath, filePath, lineNumber, query);
    },
    [openFileTabAtLine, resolveAndFocusScopePane],
  );

  const commands = useMemo<Command[]>(() => {
    const cmds: Command[] = [
      {
        id: 'new-pane',
        label: 'New Pane',
        shortcut: '⌘N',
        section: 'Actions',
        action: () => { close(); setCreating(true); },
      },
      {
        id: 'new-terminal',
        label: 'New Terminal Pane',
        shortcut: '⌘T',
        section: 'Actions',
        action: () => { close(); createPane({ prompt: '', type: 'shell' }); },
      },
      {
        id: 'merge-selected',
        label: 'Merge Selected Pane',
        shortcut: '⌘M',
        section: 'Actions',
        action: () => {
          close();
          if (selectedPaneId) mergePane(selectedPaneId);
        },
      },
      {
        id: 'close-selected',
        label: 'Close Selected Pane',
        shortcut: '⌘W',
        section: 'Actions',
        action: () => {
          close();
          if (selectedPaneId) closePane(selectedPaneId);
        },
      },
      {
        id: 'duplicate-pane',
        label: 'Duplicate Selected Pane',
        shortcut: '⌘D',
        section: 'Actions',
        action: () => {
          close();
          if (selectedPaneId) duplicatePane(selectedPaneId);
        },
      },
      {
        id: 'settings',
        label: 'Open Settings',
        shortcut: '⌘,',
        section: 'Navigation',
        action: () => { close(); setActiveView('settings'); },
      },
      {
        id: 'toggle-theme',
        label: `Switch to ${theme === 'dark' ? 'Light' : 'Dark'} Theme`,
        section: 'Preferences',
        action: () => { close(); setThemePreference(theme === 'dark' ? 'light' : 'dark'); },
      },
      {
        id: 'dashboard',
        label: 'Go to Dashboard',
        section: 'Navigation',
        action: () => { close(); setActiveView('dashboard'); },
      },
      {
        id: 'switch-workspace',
        label: 'Switch Workspace',
        shortcut: '⌘O',
        section: 'Navigation',
        action: () => { close(); openWorkspacePicker(); },
      },
      {
        id: 'worktree-overview',
        label: 'Worktree Overview',
        shortcut: 'W',
        section: 'Navigation',
        action: () => { close(); openWorktreeOverview(); },
      },
    ];

    return cmds;
  }, [selectedPaneId, theme, close, setCreating, setThemePreference, setActiveView, mergePane, closePane, duplicatePane, createPane, openWorkspacePicker, openWorktreeOverview]);

  const filteredCommands = useMemo(() => {
    if (!search) return commands;
    const lower = search.toLowerCase();
    return commands.filter(
      (c) => c.label.toLowerCase().includes(lower) || c.section.toLowerCase().includes(lower),
    );
  }, [commands, search]);

  const filteredPanes = useMemo<PaneResult[]>(() => {
    if (activeTab === 'files' || activeTab === 'messages' || activeTab === 'commands') return [];
    const lower = search.toLowerCase();
    return panes
      .filter((p) => !search || p.slug.toLowerCase().includes(lower) || p.id.toLowerCase().includes(lower) || (p.agent ?? '').toLowerCase().includes(lower))
      .map((p) => {
        const status = getEffectivePaneStatus(p, undefined, paneActivityById[p.id]);
        return { id: p.id, slug: p.slug, agent: p.agent, status };
      });
  }, [panes, paneActivityById, search, activeTab]);

  const executeCommand = useCallback(
    (id: string) => {
      const cmd = commands.find((c) => c.id === id);
      cmd?.action();
    },
    [commands],
  );

  return {
    commands: filteredCommands,
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
  };
}
