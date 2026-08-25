import type { MuxBasePane, ProjectSettings } from '../types.js';

export type ActionResultType =
  | 'success'
  | 'error'
  | 'confirm'
  | 'choice'
  | 'input'
  | 'info'
  | 'progress'
  | 'navigation';

export interface ActionOption {
  id: string;
  label: string;
  description?: string;
  danger?: boolean;
  default?: boolean;
}

export interface ActionResult {
  type: ActionResultType;
  message: string;
  title?: string;

  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm?: () => Promise<ActionResult>;
  onCancel?: () => Promise<ActionResult>;

  options?: ActionOption[];
  onSelect?: (optionId: string) => Promise<ActionResult>;

  placeholder?: string;
  defaultValue?: string;
  onSubmit?: (value: string) => Promise<ActionResult>;

  progress?: number;

  targetPaneId?: string;

  data?: unknown;
  dismissable?: boolean;
}

export interface ActionContext {
  panes: MuxBasePane[];
  currentPaneId?: string;
  sessionName: string;
  projectName: string;
  /** Optional local OTLP receiver forwarded to newly launched Claude panes. */
  otlpEndpoint?: string;
  /** Directory that owns raw tmux transcripts for newly launched panes. */
  terminalTranscriptDir?: string;
  savePanes: (panes: MuxBasePane[]) => Promise<void>;

  onPaneUpdate?: (pane: MuxBasePane) => void;
  onPaneRemove?: (paneId: string) => void;
  onActionResult?: (result: ActionResult) => Promise<void>;
  skipLastPaneWelcome?: boolean;
}

export type ActionFunction<TParams = unknown> = (
  pane: MuxBasePane,
  context: ActionContext,
  params?: TParams
) => Promise<ActionResult>;

export enum PaneAction {
  VIEW = 'view',
  CLOSE = 'close',
  MERGE = 'merge',
  RENAME = 'rename',
  DUPLICATE = 'duplicate',
  RUN_TEST = 'run_test',
  RUN_DEV = 'run_dev',
  OPEN_OUTPUT = 'open_output',
  COPY_PATH = 'copy_path',
  OPEN_IN_EDITOR = 'open_in_editor',
}

export interface ActionMetadata {
  id: PaneAction;
  label: string;
  description: string;
  icon?: string;
  shortcut?: string;
  requires?: {
    worktree?: boolean;
    testCommand?: boolean;
    devCommand?: boolean;
    runningProcess?: boolean;
  };
  danger?: boolean;
}

/**
 * Registry of all available actions with metadata
 */
export const ACTION_REGISTRY: Record<PaneAction, ActionMetadata> = {
  [PaneAction.VIEW]: {
    id: PaneAction.VIEW,
    label: 'View',
    description: 'Jump to this pane',
    icon: '👁',
    shortcut: 'j',
  },
  [PaneAction.CLOSE]: {
    id: PaneAction.CLOSE,
    label: 'Close',
    description: 'Close this pane',
    icon: '✕',
    shortcut: 'x',
    danger: true,
  },
  [PaneAction.MERGE]: {
    id: PaneAction.MERGE,
    label: 'Merge',
    description: 'Merge worktree to main branch',
    icon: '⎇',
    shortcut: 'm',
    requires: { worktree: true },
  },
  [PaneAction.RENAME]: {
    id: PaneAction.RENAME,
    label: 'Rename',
    description: 'Rename this pane',
    icon: '✎',
  },
  [PaneAction.DUPLICATE]: {
    id: PaneAction.DUPLICATE,
    label: 'Duplicate',
    description: 'Create a copy of this pane',
    icon: '⎘',
  },
  [PaneAction.RUN_TEST]: {
    id: PaneAction.RUN_TEST,
    label: 'Run Tests',
    description: 'Run test command',
    icon: '🧪',
    shortcut: 't',
    requires: { worktree: true },
  },
  [PaneAction.RUN_DEV]: {
    id: PaneAction.RUN_DEV,
    label: 'Run Dev Server',
    description: 'Start development server',
    icon: '▶',
    shortcut: 'd',
    requires: { worktree: true },
  },
  [PaneAction.OPEN_OUTPUT]: {
    id: PaneAction.OPEN_OUTPUT,
    label: 'Open Output',
    description: 'View test or dev output',
    icon: '📋',
    shortcut: 'o',
    requires: { runningProcess: true },
  },
  [PaneAction.COPY_PATH]: {
    id: PaneAction.COPY_PATH,
    label: 'Copy Path',
    description: 'Copy worktree path to clipboard',
    icon: '📁',
    requires: { worktree: true },
  },
  [PaneAction.OPEN_IN_EDITOR]: {
    id: PaneAction.OPEN_IN_EDITOR,
    label: 'Open in Editor',
    description: 'Open worktree in external editor',
    icon: '✎',
    requires: { worktree: true },
  },
};

const HIDDEN_MENU_ACTIONS = new Set<PaneAction>([
  PaneAction.DUPLICATE,
  PaneAction.RUN_TEST,
  PaneAction.RUN_DEV,
]);

/**
 * Get available actions for a pane based on its state
 */
export function getAvailableActions(
  pane: MuxBasePane,
  projectSettings?: Pick<ProjectSettings, 'testCommand' | 'devCommand'>
): ActionMetadata[] {
  return Object.values(ACTION_REGISTRY).filter(action => {
    if (HIDDEN_MENU_ACTIONS.has(action.id)) return false;
    if (!action.requires) return true;

    const { worktree, testCommand, devCommand, runningProcess } = action.requires;

    if (worktree && !pane.worktreePath) return false;
    if (testCommand && !projectSettings?.testCommand) return false;
    if (devCommand && !projectSettings?.devCommand) return false;
    if (runningProcess && !pane.testWindowId && !pane.devWindowId) return false;

    return true;
  });
}
