export type ThemeMode = 'dark' | 'light';
export type TerminalThemePreference = 'dark' | 'follow';

const LIGHT_THEMES = new Set<string>(['colorful', 'light']);

export function isLightTheme(theme: string | undefined): boolean {
  return theme !== undefined && LIGHT_THEMES.has(theme);
}

export function resolveThemeMode(theme: string | undefined): ThemeMode {
  return isLightTheme(theme) ? 'light' : 'dark';
}

export function resolveTerminalThemeMode(
  theme: string | undefined,
  preference: TerminalThemePreference | undefined,
): ThemeMode {
  return preference === 'dark' ? 'dark' : resolveThemeMode(theme);
}
