import { describe, expect, it, vi } from 'vitest';
import {
  getTerminalFontFamilies,
  loadTerminalFonts,
  type TerminalFontLoader,
} from '../../src/renderer/lib/terminal-fonts';

function makeFontLoader(): TerminalFontLoader & { load: ReturnType<typeof vi.fn> } {
  return {
    load: vi.fn().mockResolvedValue([]),
    ready: Promise.resolve(),
  };
}

describe('terminal-fonts', () => {
  it('extracts named font families without generic fallbacks', () => {
    // Arrange
    const fontFamily = '"Google Sans Code", "Intel One Mono", ui-monospace, monospace';

    // Act
    const families = getTerminalFontFamilies(fontFamily);

    // Assert
    expect(families).toEqual(['Google Sans Code', 'Intel One Mono']);
  });

  it('waits for normal and bold terminal font faces before xterm starts rendering', async () => {
    // Arrange
    const fontLoader = makeFontLoader();

    // Act
    await loadTerminalFonts('"Google Sans Code", ui-monospace, monospace', 12, fontLoader);

    // Assert
    expect(fontLoader.load).toHaveBeenCalledWith('400 12px "Google Sans Code"', expect.any(String));
    expect(fontLoader.load).toHaveBeenCalledWith('700 12px "Google Sans Code"', expect.any(String));
  });

  it('probes box-drawing, block, and braille glyphs so TUI-banner subsets load before first paint', async () => {
    // Arrange
    const fontLoader = makeFontLoader();

    // Act
    await loadTerminalFonts('"Google Sans Code"', 12, fontLoader);

    // Assert: without a probe string, document.fonts.load defaults to a space
    // and only fetches the latin subset, leaving box/block glyphs (U+2500/U+2588)
    // as ASCII fallback on a cold cache.
    const probe = fontLoader.load.mock.calls[0]?.[1] ?? '';
    expect(probe).toContain('W');
    expect(probe).toContain('─');
    expect(probe).toContain('█');
    expect(probe).toContain('⠀');
  });
});
