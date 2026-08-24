import { FolderPlus, FolderTree, type LucideIcon, MessagesSquare, PackageOpen, Settings, TerminalSquare } from 'lucide-react';
import type { ActiveView, SettingsCategory } from '../../stores/ui.store';

export const FILE_BROWSER_ACTION_ID = 'file-browser';
export const MARKETPLACE_ACTION_ID = 'marketplace';
export const OPEN_PROJECT_ACTION_ID = 'open-project';
export const SHELL_ACTION_ID = 'shell';
export const TOPICS_ACTION_ID = 'topics';
export const SETTINGS_ACTION_ID = 'settings';

type SidebarActionId =
  | typeof FILE_BROWSER_ACTION_ID
  | typeof MARKETPLACE_ACTION_ID
  | typeof OPEN_PROJECT_ACTION_ID
  | typeof SHELL_ACTION_ID
  | typeof TOPICS_ACTION_ID
  | typeof SETTINGS_ACTION_ID;

type SidebarActionBehavior = 'command' | 'toggle' | 'view';

interface SidebarActionContext {
  activeView: ActiveView;
  conversationTopicsEnabled: boolean;
  settingsCategory: SettingsCategory;
  createShellPane: () => void;
  fileBrowserOpen: boolean;
  openSettings: (category?: SettingsCategory) => void;
  openWorkspacePicker: () => void;
  setActiveView: (view: ActiveView) => void;
  toggleFileBrowser: () => void;
}

interface SidebarActionDefinition {
  id: SidebarActionId;
  Icon: LucideIcon;
  behavior: SidebarActionBehavior;
  expandedLabel: string | ((context: SidebarActionContext) => string);
  isActive?: (context: SidebarActionContext) => boolean;
  isVisible?: (context: SidebarActionContext) => boolean;
  onSelect: (context: SidebarActionContext) => void;
  testId?: string;
  title: string | ((context: SidebarActionContext) => string);
}

export interface ResolvedSidebarAction {
  id: SidebarActionId;
  Icon: LucideIcon;
  active: boolean;
  behavior: SidebarActionBehavior;
  expandedLabel: string;
  onSelect: () => void;
  testId?: string;
  title: string;
}

const SIDEBAR_FILE_BROWSER_TEST_ID = 'sidebar-file-browser-toggle';
const SIDEBAR_OPEN_PROJECT_TEST_ID = 'sidebar-open-project';
const SIDEBAR_SHELL_TEST_ID = 'sidebar-shell';

const MARKETPLACE_CATEGORY: SettingsCategory = 'marketplace';

function isSettingsCategoryOpen(context: SidebarActionContext, category: SettingsCategory): boolean {
  return context.activeView === 'settings' && context.settingsCategory === category;
}

const SIDEBAR_ACTIONS: readonly SidebarActionDefinition[] = [
  {
    id: SHELL_ACTION_ID,
    Icon: TerminalSquare,
    behavior: 'command',
    expandedLabel: 'Shell',
    onSelect: (context) => context.createShellPane(),
    testId: SIDEBAR_SHELL_TEST_ID,
    title: 'Open a shell in this project',
  },
  {
    id: FILE_BROWSER_ACTION_ID,
    Icon: FolderTree,
    behavior: 'toggle',
    expandedLabel: (context) => (context.fileBrowserOpen ? 'Hide Files' : 'Show Files'),
    isActive: (context) => context.fileBrowserOpen,
    onSelect: (context) => context.toggleFileBrowser(),
    testId: SIDEBAR_FILE_BROWSER_TEST_ID,
    title: (context) => (context.fileBrowserOpen ? 'Hide file browser' : 'Show file browser'),
  },
  {
    id: OPEN_PROJECT_ACTION_ID,
    Icon: FolderPlus,
    behavior: 'command',
    expandedLabel: 'Open project…',
    onSelect: (context) => context.openWorkspacePicker(),
    testId: SIDEBAR_OPEN_PROJECT_TEST_ID,
    title: 'Open another project',
  },
  {
    id: TOPICS_ACTION_ID,
    Icon: MessagesSquare,
    behavior: 'view',
    expandedLabel: 'Topics',
    isActive: (context) => context.activeView === 'topics',
    isVisible: (context) => context.conversationTopicsEnabled,
    onSelect: (context) => selectSidebarView(context, 'topics'),
    title: 'Conversation topics',
  },
  {
    id: MARKETPLACE_ACTION_ID,
    Icon: PackageOpen,
    behavior: 'view',
    expandedLabel: 'Marketplace',
    isActive: (context) => isSettingsCategoryOpen(context, MARKETPLACE_CATEGORY),
    onSelect: (context) => context.openSettings('marketplace'),
    title: 'Marketplace',
  },
  {
    id: SETTINGS_ACTION_ID,
    Icon: Settings,
    behavior: 'view',
    expandedLabel: 'Settings',
    // Marketplace owns its own row, so Settings is not "current" while it is open.
    isActive: (context) => context.activeView === 'settings'
      && !isSettingsCategoryOpen(context, MARKETPLACE_CATEGORY),
    onSelect: (context) => context.openSettings(),
    title: 'Settings',
  },
];

export function createSidebarActionContext(context: SidebarActionContext): SidebarActionContext {
  return context;
}

export function resolveSidebarActions(context: SidebarActionContext): ResolvedSidebarAction[] {
  return SIDEBAR_ACTIONS
    .filter((action) => action.isVisible?.(context) ?? true)
    .map((action) => ({
      id: action.id,
      Icon: action.Icon,
      active: action.isActive?.(context) ?? false,
      behavior: action.behavior,
      expandedLabel: resolveActionText(action.expandedLabel, context),
      onSelect: () => action.onSelect(context),
      testId: action.testId,
      title: resolveActionText(action.title, context),
    }));
}

function resolveActionText(
  value: string | ((context: SidebarActionContext) => string),
  context: SidebarActionContext,
): string {
  return typeof value === 'string' ? value : value(context);
}

function selectSidebarView(context: SidebarActionContext, view: Exclude<ActiveView, 'dashboard'>): void {
  context.setActiveView(context.activeView === view ? 'dashboard' : view);
}
