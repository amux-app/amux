import { describe, expect, it } from 'vitest';
import { createTerminalTheme, type TerminalTheme } from '../../src/shared/terminal-profile';

const MIN_CONTRAST_RATIO = 4.5;
// Regression guard: xterm's ThemeService computes selectionBackgroundOpaque by
// blending the FULL-STRENGTH selectionBackground over the terminal background,
// and only afterwards derives the 30%-alpha variant. Both the DOM renderer and
// the WebGL CellColorResolver read the opaque one whenever selectionForeground
// is set, so an opaque selectionBackground paints solid. Never "optimize" the
// selection back to a saturated value: the text sits directly on this fill.
const OPAQUE_ALPHA = 1;
const MIN_SELECTION_TINT_RATIO = 1.3;

const FOREGROUND_KEYS = [
  'foreground',
  'cursor',
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
] as const satisfies readonly (keyof TerminalTheme)[];

// Primer light `ansi` entries that fall below the 4.5:1 floor on #f6f8fa, and
// the value shipped instead. Sources: @primer/primitives 7.10.0
// colors/light_high_contrast.json (ansi) and colors/light.json (scale.gray).
// brightCyan has no passing counterpart in any Primer light variant, so it is
// ansi.cyan (#1b7c83) darkened to 80% RGB.
const SUBSTITUTIONS: Record<string, { primer: string; shipped: string }> = {
  brightBlue: { primer: '#218bff', shipped: '#1168e3' },
  brightCyan: { primer: '#3192aa', shipped: '#166369' },
  brightMagenta: { primer: '#a475f9', shipped: '#844ae7' },
  brightWhite: { primer: '#8c959f', shipped: '#66707b' },
  white: { primer: '#6e7781', shipped: '#57606a' },
};

// Reassigning `white` down the Primer gray ramp frees #57606a from ansi.blackBright,
// so brightBlack takes the next step (scale.gray[7]) to keep four distinct grays.
const GRAY_RAMP = ['#24292f', '#424a53', '#57606a', '#66707b'] as const;

function channelLuminance(channel: number): number {
  const value = channel / 255;
  return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance(hex: string): number {
  const value = hex.replace('#', '');
  const red = channelLuminance(parseInt(value.slice(0, 2), 16));
  const green = channelLuminance(parseInt(value.slice(2, 4), 16));
  const blue = channelLuminance(parseInt(value.slice(4, 6), 16));
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function blendOverBackground(color: string, background: string, alpha: number): string {
  const channels = [0, 2, 4].map((offset) => {
    const source = parseInt(color.replace('#', '').slice(offset, offset + 2), 16);
    const target = parseInt(background.replace('#', '').slice(offset, offset + 2), 16);
    return Math.round(alpha * source + (1 - alpha) * target);
  });
  return `#${channels.map((channel) => channel.toString(16).padStart(2, '0')).join('')}`;
}

function selectionAlpha(color: string): number {
  const value = color.replace('#', '');
  return value.length === 8 ? parseInt(value.slice(6, 8), 16) / 255 : OPAQUE_ALPHA;
}

function resolveSelectionFill(selectionBackground: string, background: string): string {
  return blendOverBackground(selectionBackground, background, selectionAlpha(selectionBackground));
}

function contrastRatio(foreground: string, background: string): number {
  const first = relativeLuminance(foreground);
  const second = relativeLuminance(background);
  const lighter = Math.max(first, second);
  const darker = Math.min(first, second);
  return (lighter + 0.05) / (darker + 0.05);
}

describe('terminal theme contrast', () => {
  it('computes WCAG contrast ratios against known reference pairs', () => {
    // Assert
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrastRatio('#ffffff', '#ffffff')).toBeCloseTo(1, 5);
    expect(contrastRatio('#767676', '#ffffff')).toBeCloseTo(4.54, 2);
  });

  it('keeps every light foreground readable on the light terminal background', () => {
    // Arrange
    const theme = createTerminalTheme('light');

    // Act
    const ratios = FOREGROUND_KEYS.map((key) => ({
      key,
      ratio: contrastRatio(theme[key], theme.background),
    }));

    // Assert
    expect(theme.background).toBe('#f6f8fa');
    for (const { key, ratio } of ratios) {
      expect(ratio, `${key} (${theme[key]}) contrast ${ratio.toFixed(2)}:1`)
        .toBeGreaterThanOrEqual(MIN_CONTRAST_RATIO);
    }
  });

  it('pins the substitutions applied to Primer light values that fail the gate', () => {
    // Arrange
    const theme = createTerminalTheme('light');

    // Assert
    for (const [key, { primer, shipped }] of Object.entries(SUBSTITUTIONS)) {
      expect(contrastRatio(primer, theme.background)).toBeLessThan(MIN_CONTRAST_RATIO);
      expect(theme[key as keyof TerminalTheme]).toBe(shipped);
    }
    expect([theme.black, theme.brightBlack, theme.white, theme.brightWhite]).toEqual([...GRAY_RAMP]);
  });

  it('keeps selected text readable on the fill xterm actually paints', () => {
    // Arrange
    const themes = [createTerminalTheme('light'), createTerminalTheme('dark')];

    // Act
    const selections = themes.map((theme) => ({
      theme,
      fill: resolveSelectionFill(theme.selectionBackground, theme.background),
    }));

    // Assert
    for (const { theme, fill } of selections) {
      expect(contrastRatio(theme.selectionForeground, fill), `selected text on ${fill}`)
        .toBeGreaterThanOrEqual(MIN_CONTRAST_RATIO);
      expect(contrastRatio(fill, theme.background), `selection tint ${fill}`)
        .toBeGreaterThanOrEqual(MIN_SELECTION_TINT_RATIO);
    }
  });

  it('keeps the light palette worst case at or above the floor', () => {
    // Arrange
    const theme = createTerminalTheme('light');

    // Act
    const worst = Math.min(
      ...FOREGROUND_KEYS.map((key) => contrastRatio(theme[key], theme.background)),
    );

    // Assert
    expect(worst).toBeGreaterThanOrEqual(MIN_CONTRAST_RATIO);
  });
});
