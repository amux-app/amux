import { describe, expect, it } from 'vitest';
import {
  isLightTheme,
  resolveTerminalThemeMode,
  resolveThemeMode,
} from '../../src/shared/theme-mode';

describe('theme mode', () => {
  it('treats both light-family themes as light and both dark-family themes as dark', () => {
    // Assert
    expect(isLightTheme('light')).toBe(true);
    expect(isLightTheme('colorful')).toBe(true);
    expect(isLightTheme('dark')).toBe(false);
    expect(isLightTheme('dark-colorful')).toBe(false);
    expect(isLightTheme(undefined)).toBe(false);
    expect(resolveThemeMode('colorful')).toBe('light');
    expect(resolveThemeMode('dark-colorful')).toBe('dark');
  });

  it('lets the Always dark preference override a light app theme', () => {
    // Assert
    expect(resolveTerminalThemeMode('light', 'follow')).toBe('light');
    expect(resolveTerminalThemeMode('light', 'dark')).toBe('dark');
    expect(resolveTerminalThemeMode('colorful', 'dark')).toBe('dark');
    expect(resolveTerminalThemeMode('dark', 'follow')).toBe('dark');
  });

  it('follows the app theme when the preference has not loaded yet', () => {
    // Assert
    expect(resolveTerminalThemeMode('light', undefined)).toBe('light');
    expect(resolveTerminalThemeMode('dark', undefined)).toBe('dark');
  });
});
