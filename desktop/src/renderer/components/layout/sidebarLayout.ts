import { SIDEBAR_MAX_WIDTH, SIDEBAR_MIN_WIDTH } from '../../lib/constants';

/**
 * The live sidebar column width. The drag writes it on every pointer move so the
 * titlebar strip and the sidebar's inner surface track the handle without a
 * React render, and it stays pinned while a collapse animates the column to 0.
 */
export const SIDEBAR_LIVE_WIDTH_VAR = '--sidebar-live-width';
export const SIDEBAR_LIVE_WIDTH_VALUE = `var(${SIDEBAR_LIVE_WIDTH_VAR})`;

/** Hover dwell before any sidebar tooltip opens, so scanning the column stays quiet. */
export const SIDEBAR_TOOLTIP_DELAY_MS = 400;

export const SIDEBAR_PANEL_ID = 'sidebar-panel';
/** Added to the panel's sized element so collapse animates without fighting the drag. */
export const SIDEBAR_PANEL_CLASS = 'sidebar-panel';
export const SIDEBAR_SEPARATOR_ID = 'sidebar-separator';

/** Marks an in-flight pointer drag so the collapse transition never lags the handle. */
export const SIDEBAR_DRAGGING_ATTRIBUTE = 'data-sidebar-dragging';

/** The separator's collapse toggle. It moves no boundary, so it never commits a width. */
export const SIDEBAR_COLLAPSE_KEY = 'Enter';

/** Keys the separator moves the boundary with; they commit like a drag. */
export const SIDEBAR_RESIZE_KEYS: ReadonlySet<string> = new Set([
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'ArrowUp',
  'End',
  'Home',
]);

export const SIDEBAR_PANEL_COLLAPSED_SIZE = '0px';
export const SIDEBAR_PANEL_MIN_SIZE = `${SIDEBAR_MIN_WIDTH}px`;
export const SIDEBAR_PANEL_MAX_SIZE = `${SIDEBAR_MAX_WIDTH}px`;

/** Leaves the content column its default width at the app's 800px minimum window. */
export const SIDEBAR_CONTENT_MIN_SIZE = '320px';

export const SIDEBAR_RESIZE_HANDLE_CLASS = 'muxbase-resize-handle muxbase-resize-handle--sidebar';
