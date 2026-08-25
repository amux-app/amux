export {
  useFirstPaneId,
  usePaneById,
  usePaneKeyboardSnapshot,
  usePaneStats,
  usePaneStore,
  useSelectedPane,
} from './pane.store';
export type { LaunchMode, PendingPane } from './pane.store';
export { selectPaneActivity, usePaneActivityStore } from './pane-activity.store';
export { useProjectStore } from './project.store';
export { useSettingsStore } from './settings.store';
export { useUiStore } from './ui.store';
export type { Theme,      } from './ui.store';
export { useHiddenPanesStore } from './hidden-panes.store';
export { useTerminalStore } from './terminal.store';
export { useNotificationStore } from './notification.store';
export type { Toast } from './notification.store';
export { useCommandPaletteStore } from './command-palette.store';
export { useElectronSettingsStore } from './electron-settings.store';
export { useAgentSessionStore } from './agent-session.store';
export { useTopicsStore } from './topics.store';
export { useUpdateStore } from './update.store';
export { useWorkspacePickerStore } from './workspace-picker.store';
export type { MergedProject } from './workspace-picker.store';
export { useKanbanStore } from './kanban.store';
export { useDecomposeStore } from './decompose.store';
export { useFileBrowserStore } from './file-browser.store';
export { useMarketplaceStore } from './marketplace.store';
export { usePaneSummaryStore } from './pane-summary.store';
export {
  useWorkspaceTabsStore,
  useFileTabsForScope,
  useActiveFileTabId,
} from './workspace-tabs.store';
export type { FileTab } from './workspace-tabs.store';

import { useUiStore as _uiStore } from './ui.store';
import { usePaneStore as _paneStore } from './pane.store';
import { usePaneActivityStore as _paneActivityStore } from './pane-activity.store';
import { useAgentSessionStore as _agentSessionStore } from './agent-session.store';
import { useConflictResolutionStore as _conflictResolutionStore } from './conflict-resolution.store';
import { useTerminalStore as _terminalStore } from './terminal.store';
import { useUpdateStore as _updateStore } from './update.store';
const rendererEnv = (import.meta as unknown as { env?: { DEV?: boolean } }).env;
const e2eFlag = typeof window !== 'undefined' && (window as unknown as Record<string, unknown>).__MUXBASE_E2E === true;
if (typeof window !== 'undefined' && (rendererEnv?.DEV || e2eFlag)) {
  (window as unknown as Record<string, unknown>).__muxbaseStores = {
    ui: _uiStore,
    pane: _paneStore,
    paneActivity: _paneActivityStore,
    agentSession: _agentSessionStore,
    conflictResolution: _conflictResolutionStore,
    terminal: _terminalStore,
    update: _updateStore,
  };
}
