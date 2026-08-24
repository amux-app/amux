import { describe, expect, it } from 'vitest';
import {
  createTerminalTheme,
  DEFAULT_TERMINAL_FONT_FAMILY,
  DEFAULT_TERMINAL_FONT_SIZE,
  GOOGLE_SANS_CODE_TERMINAL_FONT_FAMILY,
  INTEL_ONE_MONO_TERMINAL_FONT_FAMILY,
  JETBRAINS_TERMINAL_FONT_FAMILY,
  LEGACY_MONACO_TERMINAL_FONT_FAMILY,
  TERMINAL_FONT_FAMILY_OPTIONS,
  TERMINAL_LETTER_SPACING,
  TERMINAL_LINE_HEIGHT,
} from '../../src/shared/terminal-profile';
import { TERMINAL_BACKGROUND_COLORS, TERMINAL_FOREGROUND_COLORS } from '../../src/shared/app-colors';

const ANSI_KEYS = [
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',
  'brightBlack',
  'brightRed',
  'brightGreen',
  'brightYellow',
  'brightBlue',
  'brightMagenta',
  'brightCyan',
  'brightWhite',
] as const;

describe('terminal profile', () => {
  it('uses a complete pitch-black terminal palette in dark mode', () => {
    // Act
    const theme = createTerminalTheme('dark');

    // Assert
    expect(theme.background).toBe('#000000');
    // iTerm2 Dark Background foreground (aligned in the color pass).
    expect(theme.foreground).toBe('#c7c7c7');
    expect(TERMINAL_FOREGROUND_COLORS.dark).toBe(theme.foreground);
    expect(theme.cursorAccent).toBe('#000000');
    expect(theme.black).toBe('#000000');
    expect(theme.background).not.toBe('#15191f');
    expect(theme.black).not.toBe('#14191e');
    expect(theme.foreground).not.toBe('#ffffff');
    expect(theme.foreground).not.toBe('#dcdcdc');
    expect(ANSI_KEYS.every((key) => typeof theme[key] === 'string')).toBe(true);
  });

  it('blends the light palette with app chrome instead of stark white', () => {
    // Act
    const theme = createTerminalTheme('light');

    // Assert: matches `--surface` under [data-theme="light"] in theme.css.
    expect(theme.background).toBe('#f6f8fa');
    expect(TERMINAL_BACKGROUND_COLORS.light).toBe(theme.background);
    expect(theme.background).not.toBe('#ffffff');
    expect(theme.foreground).toBe(TERMINAL_FOREGROUND_COLORS.light);
    expect(theme.cursorAccent).toBe(theme.background);
    expect(theme.black).not.toBe(theme.background);
    expect(ANSI_KEYS.every((key) => typeof theme[key] === 'string')).toBe(true);
  });

  it('returns an isolated copy per call so live re-theming cannot mutate a palette', () => {
    // Act
    const first = createTerminalTheme('dark');
    first.background = '#123456';

    // Assert
    expect(createTerminalTheme('dark').background).toBe('#000000');
  });

  it('matches Google Sans Code terminal typography defaults', () => {
    // Assert
    expect(DEFAULT_TERMINAL_FONT_FAMILY).toBe(GOOGLE_SANS_CODE_TERMINAL_FONT_FAMILY);
    expect(DEFAULT_TERMINAL_FONT_FAMILY.startsWith('"Google Sans Code"')).toBe(true);
    expect(DEFAULT_TERMINAL_FONT_FAMILY).toContain('"Intel One Mono"');
    expect(DEFAULT_TERMINAL_FONT_FAMILY).toContain('ui-monospace');
    expect(DEFAULT_TERMINAL_FONT_SIZE).toBe(12);
    expect(TERMINAL_LINE_HEIGHT).toBe(1);
    expect(TERMINAL_LETTER_SPACING).toBe(0);
  });

  it('offers recommended and legacy terminal font presets', () => {
    // Assert
    expect(TERMINAL_FONT_FAMILY_OPTIONS).toContainEqual({
      label: 'Google Sans Code (Recommended)',
      value: DEFAULT_TERMINAL_FONT_FAMILY,
    });
    expect(TERMINAL_FONT_FAMILY_OPTIONS).toContainEqual({
      label: 'Intel One Mono',
      value: INTEL_ONE_MONO_TERMINAL_FONT_FAMILY,
    });
    expect(TERMINAL_FONT_FAMILY_OPTIONS).toContainEqual({
      label: 'JetBrains Mono',
      value: JETBRAINS_TERMINAL_FONT_FAMILY,
    });
    expect(TERMINAL_FONT_FAMILY_OPTIONS).toContainEqual({
      label: 'Monaco (Legacy)',
      value: LEGACY_MONACO_TERMINAL_FONT_FAMILY,
    });
  });
});
