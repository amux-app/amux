/**
 * Sidebar column bounds. Shared because the renderer clamps the live drag with
 * them and the main process validates the persisted setting against the same
 * range — duplicating the numbers would let the two sides drift apart.
 */

/** Default expanded width; sized to the nav labels, not to the widest agent name. */
export const SIDEBAR_DEFAULT_WIDTH = 260;

/** Narrowest width that still fits a nav label beside its icon before truncating. */
export const SIDEBAR_MIN_WIDTH = 180;

/** At the 800px minimum window this still leaves the content column its default 320px. */
export const SIDEBAR_MAX_WIDTH = 480;
