export const FILE_BROWSER_PANEL_CLASS = 'h-full flex flex-col overflow-hidden bg-[var(--surface)]';

const FILE_BROWSER_DEFAULT_PANEL_SIZE = 17.25;

export const FILE_BROWSER_DEFAULT_PANEL_SIZE_VALUE = `${FILE_BROWSER_DEFAULT_PANEL_SIZE}%`;

const MAIN_PANEL_DEFAULT_SIZE = 82.75;

export const MAIN_PANEL_DEFAULT_SIZE_VALUE = `${MAIN_PANEL_DEFAULT_SIZE}%`;

export const FILE_BROWSER_COLLAPSED_PANEL_SIZE_VALUE = '0%';

export const FILE_BROWSER_MIN_PANEL_SIZE_VALUE = '10%';

export const FILE_BROWSER_MAX_PANEL_SIZE_VALUE = '70%';

export const MAIN_PANEL_MIN_SIZE_VALUE = '30%';

export const FILE_VIEWER_PANEL_CLASS = 'flex flex-col flex-1 h-full min-w-0 overflow-hidden';

export const FILE_BROWSER_RESIZE_HANDLE_CLASS = 'muxbase-resize-handle muxbase-resize-handle--file-browser';

export const FILE_BROWSER_SHELL_RESIZE_HANDLE_CLASS = `${FILE_BROWSER_RESIZE_HANDLE_CLASS} muxbase-resize-handle--file-browser-shell`;

export const FILE_BROWSER_VIEWER_RESIZE_HANDLE_CLASS = `${FILE_BROWSER_RESIZE_HANDLE_CLASS} muxbase-resize-handle--file-browser-viewer`;

export const FILE_BROWSER_CROWDED_RESIZE_HANDLE_CLASS = 'muxbase-resize-handle--file-browser-crowded';

export const FILE_BROWSER_CROWDED_VIEWER_CLASS = 'muxbase-file-viewer--crowded';

export const FILE_BROWSER_CROWDED_VIEWER_THRESHOLD = 220;

export const FILE_BROWSER_RESIZE_TARGET_MINIMUM_SIZE = {
  fine: 14,
  coarse: 28,
} as const;

export const FILE_BROWSER_SHELL_SEPARATOR_ID = 'file-browser-shell-separator';
