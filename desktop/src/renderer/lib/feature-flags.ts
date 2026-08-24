import type { ElectronSettings } from '../../shared/ipc-types';
import type { ViewMode } from '../stores/ui.store';
import { SHORTCUT_GROUPS, type ShortcutGroup } from './constants';

const BOARD_SHORTCUT_KEYS = '⌘ B';

export function isKanbanBoardEnabled(settings: ElectronSettings | null | undefined): boolean {
  return settings?.enableKanbanBoard === true;
}

export function isPaneSummaryEnabled(settings: ElectronSettings | null | undefined): boolean {
  return settings?.enablePaneSummary === true;
}

export function isConversationTopicsEnabled(settings: ElectronSettings | null | undefined): boolean {
  return settings?.enableConversationTopics === true;
}

export function isReviewAgentEnabled(settings: ElectronSettings | null | undefined): boolean {
  return settings?.enableReviewAgent === true;
}

export function getDashboardViewMode(
  viewMode: ViewMode,
  settings: ElectronSettings | null | undefined,
): ViewMode {
  if (viewMode === 'kanban' && !isKanbanBoardEnabled(settings)) {
    return 'fleet';
  }
  if (viewMode === 'summary' && !isPaneSummaryEnabled(settings)) {
    return 'fleet';
  }

  return viewMode;
}

export function getShortcutGroups(settings: ElectronSettings | null | undefined): ShortcutGroup[] {
  const kanbanBoardEnabled = isKanbanBoardEnabled(settings);

  return SHORTCUT_GROUPS
    .map((group) => ({
      ...group,
      shortcuts: group.shortcuts.filter((shortcut) => (
        kanbanBoardEnabled || shortcut.keys !== BOARD_SHORTCUT_KEYS
      )),
    }))
    .filter((group) => group.shortcuts.length > 0);
}
