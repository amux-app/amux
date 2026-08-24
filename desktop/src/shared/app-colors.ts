import type { ThemeMode } from './theme-mode.js';

const PREMIUM_BLACK = '#000000';

// Light values target `[data-theme="light"]` in renderer/styles/theme.css so the
// terminal blends with app chrome, and are intentionally shared by `colorful`,
// which also resolves to light mode with a marginally lighter surface. This
// module is imported by the main process, so every value must stay a static
// literal.
export const APP_WINDOW_BACKGROUND_COLORS: Record<ThemeMode, string> = {
  dark: PREMIUM_BLACK,
  light: '#ffffff',
};

export const TERMINAL_BACKGROUND_COLORS: Record<ThemeMode, string> = {
  dark: PREMIUM_BLACK,
  light: '#f6f8fa',
};

export const TERMINAL_FOREGROUND_COLORS: Record<ThemeMode, string> = {
  dark: '#c7c7c7',
  light: '#1f2328',
};

export const TERMINAL_FOREGROUND_MUTED_COLORS: Record<ThemeMode, string> = {
  dark: '#8b8f99',
  light: '#656d76',
};

export const TERMINAL_ACCENT_COLORS: Record<ThemeMode, string> = {
  dark: '#58a6ff',
  light: '#0969da',
};

export const TERMINAL_OVERLAY_TRACK_COLORS: Record<ThemeMode, string> = {
  dark: 'rgba(255, 255, 255, 0.12)',
  light: 'rgba(0, 0, 0, 0.12)',
};
