/**
 * Timing constants for delays and intervals throughout the application.
 * Centralized here for easier tuning and documentation.
 */

// Tmux operation delays
export const TMUX_PANE_CREATION_DELAY = 50; // Wait for pane to be fully registered in tmux
export const TMUX_SPLIT_DELAY = 100; // Wait after splitting pane for tmux to stabilize (ms)
export const TMUX_COMMAND_TIMEOUT = 1000; // Timeout for tmux command execution (ms)
export const TMUX_LAYOUT_APPLY_DELAY = 1000; // Wait for layout to fully apply before continuing
export const TMUX_SHELL_READY_DELAY = 300; // Wait for shell to initialize in new tmux pane before sending commands

export const ASCII_ART_RENDER_DELAY = 100; // Delay for ASCII art rendering

// Pane status polling. One manager-owned tick batches every pane due on the
// same cadence; quiet panes back off until activity re-arms the fast cadence.
export const WORKER_ACTIVE_POLL_INTERVAL = 1000; // Shared cadence while a pane is active
export const WORKER_IDLE_POLL_INTERVAL = 3000; // Poll interval once a pane has gone quiet
export const WORKER_QUIET_TICKS_BEFORE_IDLE = 3; // Unchanged ticks required before backing off
export const WORKER_CAPTURE_HISTORY_LINES = 30; // Scrollback lines captured per status tick
export const WORKER_ACTIVITY_NOTIFY_THROTTLE = 1000; // Min gap between pane-input notifications
export const FIRST_IDLE_STABLE_CAPTURES = 3; // Bounded fallback evidence; lifecycle adapters remain the fast path.
export const STATUS_REASSERT_CAPTURES = 5; // Re-publish an unchanged status so its evidence stays fresh
