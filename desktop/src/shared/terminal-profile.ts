import { TERMINAL_BACKGROUND_COLORS, TERMINAL_FOREGROUND_COLORS } from './app-colors.js';
import type { ThemeMode } from './theme-mode.js';

export type TerminalThemeMode = ThemeMode;

export interface TerminalTheme {
  background: string;
  foreground: string;
  cursor: string;
  cursorAccent: string;
  selectionBackground: string;
  selectionForeground: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
}

export const SYSTEM_MONO_TERMINAL_FONT_FAMILY =
  'ui-monospace, "SFMono-Regular", "SF Mono", Menlo, Consolas, "Liberation Mono", monospace';
export const INTEL_ONE_MONO_TERMINAL_FONT_FAMILY =
  '"Intel One Mono", "Google Sans Code", ui-monospace, "SFMono-Regular", "SF Mono", Menlo, Consolas, "Liberation Mono", monospace';
export const GOOGLE_SANS_CODE_TERMINAL_FONT_FAMILY =
  '"Google Sans Code", "Intel One Mono", ui-monospace, "SFMono-Regular", "SF Mono", Menlo, Consolas, "Liberation Mono", monospace';
export const JETBRAINS_TERMINAL_FONT_FAMILY =
  "'JetBrains Mono', 'Cascadia Mono', 'SF Mono', Menlo, Monaco, Consolas, 'Liberation Mono', monospace";
export const DEFAULT_TERMINAL_FONT_FAMILY = GOOGLE_SANS_CODE_TERMINAL_FONT_FAMILY;
export const LEGACY_JETBRAINS_TERMINAL_FONT_FAMILY = 'JetBrains Mono, Menlo, Monaco, monospace';
export const LEGACY_MONACO_TERMINAL_FONT_FAMILY = "Monaco, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace";
export const LEGACY_SF_MONO_TERMINAL_FONT_FAMILY = "'SF Mono', Menlo, Monaco, 'Courier New', monospace";
export const DEFAULT_TERMINAL_FONT_SIZE = 12;
export const TERMINAL_LETTER_SPACING = 0;
export const TERMINAL_LINE_HEIGHT = 1;

export interface TerminalFontFamilyOption {
  label: string;
  value: string;
}

export const TERMINAL_FONT_FAMILY_OPTIONS: TerminalFontFamilyOption[] = [
  { label: 'Google Sans Code (Recommended)', value: DEFAULT_TERMINAL_FONT_FAMILY },
  { label: 'Intel One Mono', value: INTEL_ONE_MONO_TERMINAL_FONT_FAMILY },
  { label: 'System Mono', value: SYSTEM_MONO_TERMINAL_FONT_FAMILY },
  { label: 'JetBrains Mono', value: JETBRAINS_TERMINAL_FONT_FAMILY },
  {
    label: 'Cascadia Mono',
    value: "'Cascadia Mono', 'JetBrains Mono', 'SF Mono', Menlo, Consolas, monospace",
  },
  {
    label: 'Fira Code',
    value: "'Fira Code', 'JetBrains Mono', 'SF Mono', Menlo, Consolas, monospace",
  },
  {
    label: 'System Monospace',
    value: "ui-monospace, 'SF Mono', Menlo, Monaco, Consolas, 'Liberation Mono', monospace",
  },
  { label: 'Monaco (Legacy)', value: LEGACY_MONACO_TERMINAL_FONT_FAMILY },
  { label: 'SF Mono (Legacy)', value: LEGACY_SF_MONO_TERMINAL_FONT_FAMILY },
  { label: 'JetBrains Mono (Legacy Stack)', value: LEGACY_JETBRAINS_TERMINAL_FONT_FAMILY },
];

const DARK_TERMINAL_THEME: TerminalTheme = {
  background: TERMINAL_BACKGROUND_COLORS.dark,
  foreground: TERMINAL_FOREGROUND_COLORS.dark,
  cursor: '#ffffff',
  cursorAccent: TERMINAL_BACKGROUND_COLORS.dark,
  selectionBackground: '#b3d7ff',
  selectionForeground: '#000000',
  black: TERMINAL_BACKGROUND_COLORS.dark,
  red: '#c91b00',
  green: '#00c200',
  yellow: '#c7c400',
  blue: '#0225c7',
  magenta: '#ca30c7',
  cyan: '#00c5c7',
  white: '#c7c7c7',
  brightBlack: '#686868',
  brightRed: '#ff6e67',
  brightGreen: '#5ffa68',
  brightYellow: '#fffc67',
  brightBlue: '#6871ff',
  brightMagenta: '#ff77ff',
  brightCyan: '#60fdff',
  brightWhite: '#ffffff',
};

// GitHub Light (Primer) ANSI palette, from @primer/primitives light.json `ansi`.
// Six entries are substituted because the stock values fall under the 4.5:1
// contrast floor on this background; see terminal-theme-contrast.test.ts, which
// pins each substitution and its source.
const LIGHT_TERMINAL_THEME: TerminalTheme = {
  background: TERMINAL_BACKGROUND_COLORS.light,
  foreground: TERMINAL_FOREGROUND_COLORS.light,
  cursor: TERMINAL_FOREGROUND_COLORS.light,
  cursorAccent: TERMINAL_BACKGROUND_COLORS.light,
  // xterm blends selectionBackground into the background at FULL opacity when
  // selectionForeground is set (the 30% variant is never read on that path), so
  // this value renders solid and is chosen for readable text on the fill. The
  // tint-vs-background delta is inherently subtle: WCAG 1.4.11 does not apply to
  // a selection tint, but 1.4.3 text contrast does.
  selectionBackground: '#54aeff',
  selectionForeground: '#1f2328',
  black: '#24292f',
  red: '#cf222e',
  green: '#116329',
  yellow: '#4d2d00',
  blue: '#0969da',
  magenta: '#8250df',
  cyan: '#1b7c83',
  white: '#57606a',
  brightBlack: '#424a53',
  brightRed: '#a40e26',
  brightGreen: '#1a7f37',
  brightYellow: '#633c01',
  brightBlue: '#1168e3',
  brightMagenta: '#844ae7',
  brightCyan: '#166369',
  brightWhite: '#66707b',
};

export function createTerminalTheme(mode: TerminalThemeMode): TerminalTheme {
  return { ...(mode === 'light' ? LIGHT_TERMINAL_THEME : DARK_TERMINAL_THEME) };
}
