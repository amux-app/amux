import { useCallback, useEffect } from 'react';
import { IPC_EVENT } from '../shared/ipc-channels';
import type { AppFileFlushRequest } from '../shared/ipc-types';
import * as appApi from './api/app.api';
import * as paneApi from './api/pane.api';
import { AppBootOverlay } from './components/app-boot/AppBootOverlay';
import { CommandPalette } from './components/command-palette/CommandPalette';
import { CreatePaneDialog } from './components/create/CreatePaneDialog';
import { DecomposeSideSheet } from './components/decompose/DecomposeSideSheet';
import { AppShell } from './components/layout/AppShell';
import { MarketplaceUpdatesPopup } from './components/marketplace/MarketplaceUpdatesPopup';
import { AppUpdateBootstrap } from './components/layout/AppUpdateBootstrap';
import { UpdateLocationNotice } from './components/layout/UpdateLocationNotice';
import { ToastContainer } from './components/shared/ToastContainer';
import { WorkspacePicker } from './components/workspace-picker/WorkspacePicker';
import { useIpcListener } from './hooks/useIpcListener';
import { useAppBootState } from './hooks/useAppBootState';
import { useConversationTopicsSync } from './hooks/useConversationTopicsSync';
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts';
import { useTheme } from './hooks/useTheme';
import {
  BOOT_SIDEBAR_COLLAPSED,
  BOOT_SIDEBAR_ORGANIZE,
  BOOT_SIDEBAR_SORT,
  BOOT_SIDEBAR_WIDTH,
  BOOT_THEME,
} from './lib/boot-settings';
import {
  sanitizeAgentSessionRemovedEvent,
  sanitizeAgentSessionUpdatedEvent,
  sanitizePaneActivityChangedEvent,
  sanitizePaneActivitySnapshot,
  sanitizePaneList,
  sanitizePaneTopicsUpdatedEvent,
  sanitizeProgressEvent,
  sanitizeToastEvent,
  warnDroppedItems,
  warnInvalidPayload,
} from './lib/runtimeValidation';
import {
  useAgentSessionStore,
  useElectronSettingsStore,
  useFileBrowserStore,
  useKanbanStore,
  useNotificationStore,
  usePaneStore,
  usePaneActivityStore,
  usePaneSummaryStore,
  useProjectStore,
  useTopicsStore,
  useUiStore,
  useWorkspacePickerStore,
} from './stores';

export default function App() {
  const bootState = useAppBootState();
  const bootReady = bootState.phase === 'ready';
  const isE2E = (() => {
    try {
      return new URLSearchParams(window.location.search).get('e2e') === '1';
    } catch {
      return false;
    }
  })();

  const { setTheme } = useTheme();
  useKeyboardShortcuts(bootReady);
  useConversationTopicsSync(bootReady);

  const compactMode = useElectronSettingsStore((s) => s.settings?.compactMode ?? false);
  useEffect(() => {
    document.documentElement.dataset.compact = String(compactMode);
  }, [compactMode]);

  const setPanes = usePaneStore((s) => s.setPanes);
  const acceptPaneActivityChangedEvent = usePaneActivityStore((s) => s.acceptChangedEvent);
  const replacePaneActivitySnapshot = usePaneActivityStore((s) => s.replaceSnapshot);
  const addToast = useNotificationStore((s) => s.addToast);
  const loadProjects = useProjectStore((s) => s.loadProjects);
  const loadSessionInfo = useProjectStore((s) => s.loadSessionInfo);
  const setProgressAction = useUiStore((s) => s.setProgressAction);
  const setSidebarCollapsed = useUiStore((s) => s.setSidebarCollapsed);
  const setSidebarOrganize = useUiStore((s) => s.setSidebarOrganize);
  const setSidebarSort = useUiStore((s) => s.setSidebarSort);
  const setSidebarWidth = useUiStore((s) => s.setSidebarWidth);
  const setWindowFullScreen = useUiStore((s) => s.setWindowFullScreen);
  const loadElectronSettings = useElectronSettingsStore((s) => s.load);
  const updateAgentSession = useAgentSessionStore((s) => s.updateSession);
  const removeAgentSession = useAgentSessionStore((s) => s.removeSession);
  const openWorkspacePicker = useWorkspacePickerStore((s) => s.open);
  const refreshKanban = useKanbanStore((s) => s.refresh);
  const upsertTopics = useTopicsStore((s) => s.upsert);
  const removeTopics = useTopicsStore((s) => s.remove);

  useEffect(() => {
    if (!bootReady) return;
    let cancelled = false;

    void (async () => {
      try {
        const panes = await paneApi.listPanes();
        if (cancelled) return;
        setPanes(panes);

        await Promise.all([loadProjects(), loadSessionInfo()]);
        if (cancelled || isE2E) return;

        const projects = useProjectStore.getState().projects;
        const singleProjectWithActivePanes = projects.length === 1 && panes.length > 0;
        if (!singleProjectWithActivePanes) {
          openWorkspacePicker();
        }
      } catch {
        if (!cancelled && !isE2E) {
          openWorkspacePicker();
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [bootReady, isE2E, setPanes, loadProjects, loadSessionInfo, openWorkspacePicker]);

  useEffect(() => {
    void loadElectronSettings().then(() => {
      const persisted = useElectronSettingsStore.getState().settings;
      if (!persisted) return;
      const current = useUiStore.getState();
      if (current.theme === BOOT_THEME) setTheme(persisted.theme);
      if (current.sidebarCollapsed === BOOT_SIDEBAR_COLLAPSED) setSidebarCollapsed(persisted.sidebarCollapsed);
      if (current.sidebarOrganize === BOOT_SIDEBAR_ORGANIZE) setSidebarOrganize(persisted.sidebarOrganize);
      if (current.sidebarSort === BOOT_SIDEBAR_SORT) setSidebarSort(persisted.sidebarSort);
      if (current.sidebarWidth === BOOT_SIDEBAR_WIDTH) setSidebarWidth(persisted.sidebarWidth);
    });
  }, [loadElectronSettings, setSidebarCollapsed, setSidebarOrganize, setSidebarSort, setSidebarWidth, setTheme]);

  const handlePaneListChanged = useCallback(
    (panes: unknown) => {
      if (!bootReady) return;
      const newPanes = sanitizePaneList(panes);
      if (!newPanes) {
        warnInvalidPayload('pane-list-changed', panes);
        return;
      }
      if (Array.isArray(panes) && newPanes.length !== panes.length) {
        warnDroppedItems('pane-list-changed', panes.length, newPanes.length);
      }
      const newPaneIds = new Set(newPanes.map((p) => p.id));
      const sessions = useAgentSessionStore.getState().sessions;
      for (const paneId of Object.keys(sessions)) {
        if (!newPaneIds.has(paneId)) {
          removeAgentSession(paneId);
        }
      }
      const topics = useTopicsStore.getState().topicsByPane;
      for (const paneId of Object.keys(topics)) {
        if (!newPaneIds.has(paneId)) removeTopics(paneId);
      }
      setPanes(newPanes);
    },
    [bootReady, setPanes, removeAgentSession, removeTopics],
  );

  const syncPaneActivity = useCallback(async () => {
    try {
      const payload = await paneApi.getPaneActivitySnapshot();
      const snapshot = sanitizePaneActivitySnapshot(payload);
      if (!snapshot) {
        warnInvalidPayload('pane-activity-snapshot', payload);
        return;
      }
      replacePaneActivitySnapshot(snapshot);
    } catch {
      // The next push event or boot retry reconciles transient main-process startup.
    }
  }, [replacePaneActivitySnapshot]);

  const handlePaneActivityChanged = useCallback((event: unknown) => {
    const changed = sanitizePaneActivityChangedEvent(event);
    if (!changed) {
      warnInvalidPayload('pane-activity-changed', event);
      return;
    }
    if (acceptPaneActivityChangedEvent(changed) === 'epoch-mismatch') void syncPaneActivity();
  }, [acceptPaneActivityChangedEvent, syncPaneActivity]);

  const handleToast = useCallback(
    (event: unknown) => {
      const e = sanitizeToastEvent(event);
      if (!e) {
        warnInvalidPayload('toast', event);
        return;
      }
      addToast(e.message, e.severity);
    },
    [addToast],
  );

  const handleProgress = useCallback(
    (event: unknown) => {
      const e = sanitizeProgressEvent(event);
      if (!e) {
        warnInvalidPayload('progress', event);
        return;
      }
      setProgressAction(e.active ? e.action : null);
    },
    [setProgressAction],
  );

  const handleAgentSessionUpdated = useCallback(
    (event: unknown) => {
      if (!bootReady) return;
      const e = sanitizeAgentSessionUpdatedEvent(event);
      if (!e) {
        warnInvalidPayload('agent-session-updated', event);
        return;
      }
      const accepted = updateAgentSession(e.paneId, e.session);
      if (!accepted) return;
    },
    [bootReady, updateAgentSession],
  );

  const handleAgentSessionRemoved = useCallback(
    (event: unknown) => {
      if (!bootReady) return;
      const e = sanitizeAgentSessionRemovedEvent(event);
      if (!e) {
        warnInvalidPayload('agent-session-removed', event);
        return;
      }
      removeAgentSession(e.paneId);
    },
    [bootReady, removeAgentSession],
  );

  const handleKanbanChanged = useCallback(() => {
    if (!bootReady) return;
    const project = useProjectStore.getState().activeProject;
    if (project?.root) {
      refreshKanban(project.root);
    }
  }, [bootReady, refreshKanban]);

  const handleTopicsUpdated = useCallback((event: unknown) => {
    if (!bootReady) return;
    const e = sanitizePaneTopicsUpdatedEvent(event);
    if (!e) {
      warnInvalidPayload('topics-updated', event);
      return;
    }
    upsertTopics(e.topics);
  }, [bootReady, upsertTopics]);

  const handleTopicsRemoved = useCallback((event: unknown) => {
    if (!bootReady) return;
    const e = sanitizeAgentSessionRemovedEvent(event);
    if (!e) {
      warnInvalidPayload('topics-removed', event);
      return;
    }
    removeTopics(e.paneId);
  }, [bootReady, removeTopics]);

  const handlePaneSummaryUpdated = useCallback((event: unknown) => {
    if (!bootReady) return;
    const payload = event as { summary?: import('../shared/pane-summary-types').PaneSummary } | undefined;
    if (!payload?.summary || typeof payload.summary.paneId !== 'string') {
      warnInvalidPayload('pane-summary-updated', event);
      return;
    }
    usePaneSummaryStore.getState().applyUpdate(payload.summary);
  }, [bootReady]);

  const handlePaneSummaryRemoved = useCallback((event: unknown) => {
    if (!bootReady) return;
    const payload = event as { paneId?: string } | undefined;
    if (!payload?.paneId || typeof payload.paneId !== 'string') {
      warnInvalidPayload('pane-summary-removed', event);
      return;
    }
    usePaneSummaryStore.getState().applyRemove(payload.paneId);
  }, [bootReady]);

  const handleWindowFullScreenChanged = useCallback((event: unknown) => {
    if (typeof event !== 'boolean') {
      warnInvalidPayload('window-full-screen-changed', event);
      return;
    }
    setWindowFullScreen(event);
  }, [setWindowFullScreen]);

  const handleFileFlushRequested = useCallback((event: unknown) => {
    const request = event as Partial<AppFileFlushRequest> | null;
    if (!request || typeof request.requestId !== 'string') {
      warnInvalidPayload('app-file-flush-requested', event);
      return;
    }

    const requestId = request.requestId;
    void (async () => {
      let success = false;
      try {
        success = await useFileBrowserStore.getState().flushPendingFileSave();
      } catch {
        success = false;
      }
      try {
        await appApi.reportFileFlushResult({ requestId, success });
      } catch {
        // The main-process timeout keeps the app open if the acknowledgement fails.
      }
    })();
  }, []);

  useIpcListener(IPC_EVENT.APP_FILE_FLUSH_REQUESTED, handleFileFlushRequested);
  useIpcListener(IPC_EVENT.PANE_LIST_CHANGED, handlePaneListChanged);
  useIpcListener(IPC_EVENT.PANE_ACTIVITY_CHANGED, handlePaneActivityChanged);
  useIpcListener(IPC_EVENT.TOAST, handleToast);
  useIpcListener(IPC_EVENT.PROGRESS, handleProgress);
  useIpcListener(IPC_EVENT.AGENT_SESSION_UPDATED, handleAgentSessionUpdated);
  useIpcListener(IPC_EVENT.AGENT_SESSION_REMOVED, handleAgentSessionRemoved);
  useIpcListener(IPC_EVENT.KANBAN_CHANGED, handleKanbanChanged);
  useIpcListener(IPC_EVENT.TOPICS_UPDATED, handleTopicsUpdated);
  useIpcListener(IPC_EVENT.TOPICS_REMOVED, handleTopicsRemoved);
  useIpcListener(IPC_EVENT.PANE_SUMMARY_UPDATED, handlePaneSummaryUpdated);
  useIpcListener(IPC_EVENT.PANE_SUMMARY_REMOVED, handlePaneSummaryRemoved);
  useIpcListener(IPC_EVENT.WINDOW_FULL_SCREEN_CHANGED, handleWindowFullScreenChanged);

  // Register the push listener above before asking for the snapshot. Events
  // received in this gap are buffered by the store and replayed by revision.
  useEffect(() => {
    if (bootReady) void syncPaneActivity();
  }, [bootReady, syncPaneActivity]);

  return (
    <>
      <AppUpdateBootstrap />
      {!bootReady ? (
        <AppBootOverlay state={bootState} />
      ) : (
        <>
          <AppShell />
          <UpdateLocationNotice />
          <CreatePaneDialog />
          <CommandPalette />
          <WorkspacePicker />
          <DecomposeSideSheet />
          <ToastContainer />
          <MarketplaceUpdatesPopup />
        </>
      )}
    </>
  );
}
