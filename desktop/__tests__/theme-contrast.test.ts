import { readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';

const AA_TEXT = 4.5;
const AA_LARGE_TEXT = 3;
const AA_NON_TEXT = 3;
const MIN_ROLE_SEPARATION = 25;
const FLAT_MIX = 100;
const RETIRED_READY_HIGHLIGHT_MIX = 55;
const READY_HIGHLIGHT_LEGIBLE_FLOOR = 95;
const MIX_STEPS = Array.from({ length: FLAT_MIX }, (_, index) => index + 1);

const ALL_BACKDROPS = ['bg', 'surface', 'chrome', 'surface-raised'];
const THEME_BLOCK = /^(:root|\[data-theme="[^"]+"\])\s*\{([^}]*)\}/gm;
const DECLARATION = /--([\w-]+):\s*([^;]+);/g;
const DEFAULT_THEME = 'dark';

interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

interface Pair {
  fg: string;
  layers: string[];
  min: number;
}

const themeCss = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../src/renderer/styles/theme.css'),
  'utf8',
);

function declarations(block: string): Record<string, string> {
  return Object.fromEntries(
    Array.from(block.matchAll(DECLARATION), (match) => [match[1], match[2].trim()]),
  );
}

/** Effective token maps: every theme inherits `:root` and overrides only what it redeclares. */
function effectiveThemes(css: string): Record<string, Record<string, string>> {
  const blocks: Record<string, Record<string, string>> = {};
  for (const [, selector, body] of css.matchAll(THEME_BLOCK)) {
    const name = selector === ':root' ? DEFAULT_THEME : selector.slice('[data-theme="'.length, -2);
    blocks[name] = declarations(body);
  }
  const base = blocks[DEFAULT_THEME];
  return Object.fromEntries(
    Object.entries(blocks).map(([name, tokens]) => [name, { ...base, ...tokens }]),
  );
}

function parseColor(value: string): Rgba {
  const rgba = value.match(/^rgba?\(([^)]+)\)$/);
  if (rgba) {
    const parts = rgba[1].split(',').map((part) => Number(part.trim()));
    return { r: parts[0], g: parts[1], b: parts[2], a: parts[3] ?? 1 };
  }
  const hex = value.replace('#', '');
  const full = hex.length === 3 ? hex.split('').map((c) => c + c).join('') : hex;
  const [r, g, b] = [0, 2, 4].map((offset) => Number.parseInt(full.slice(offset, offset + 2), 16));
  return { r, g, b, a: 1 };
}

function composite(source: Rgba, backdrop: Rgba): Rgba {
  const mix = (from: number, to: number) => source.a * from + (1 - source.a) * to;
  return { r: mix(source.r, backdrop.r), g: mix(source.g, backdrop.g), b: mix(source.b, backdrop.b), a: 1 };
}

/** Bottom-first stack: layers[0] must be opaque, later layers paint over it. */
function flatten(layers: Rgba[]): Rgba {
  return layers.reduce((backdrop, layer) => composite(layer, backdrop));
}

function relativeLuminance({ r, g, b }: Rgba): number {
  const [red, green, blue] = [r, g, b].map((channel) => {
    const v = channel / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrastRatio(foreground: Rgba, backdrop: Rgba): number {
  const [first, second] = [relativeLuminance(composite(foreground, backdrop)), relativeLuminance(backdrop)];
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

function labColor(color: Rgba): number[] {
  const [r, g, b] = [color.r, color.g, color.b].map((channel) => {
    const v = channel / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  const xyz = [
    (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047,
    0.2126729 * r + 0.7151522 * g + 0.072175 * b,
    (0.0193339 * r + 0.119192 * g + 0.9503041 * b) / 1.08883,
  ].map((t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116));
  return [116 * xyz[1] - 16, 500 * (xyz[0] - xyz[1]), 200 * (xyz[1] - xyz[2])];
}

/** CIE76 colour difference: guards that two role colours stay perceptually separate. */
function colorDistance(first: Rgba, second: Rgba): number {
  const [a, b] = [labColor(first), labColor(second)];
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

const themes = effectiveThemes(themeCss);

function tokenColor(theme: string, token: string): Rgba {
  const value = themes[theme][token];
  expect(value, `${theme} must define --${token}`).toBeDefined();
  return parseColor(value);
}

/** CSS `color-mix(in srgb, <color> <percent>%, white)`: linear interpolation of the gamma-encoded channels. */
function mixWithWhite({ r, g, b }: Rgba, percent: number): Rgba {
  const share = percent / FLAT_MIX;
  const channel = (value: number) => share * value + (1 - share) * 255;
  return { r: channel(r), g: channel(g), b: channel(b), a: 1 };
}

/** Ready check ink over the dot lifted by a `percent` white highlight; `FLAT_MIX` is the un-highlighted dot. */
function readyInkOnDot(theme: string, percent: number): number {
  return contrastRatio(
    tokenColor(theme, 'attention-ready-icon'),
    mixWithWhite(tokenColor(theme, 'attention-ready-dot'), percent),
  );
}

function measure(theme: string, { fg, layers }: Pair): number {
  const backdrop = flatten(layers.map((token) => tokenColor(theme, token)));
  return contrastRatio(tokenColor(theme, fg), backdrop);
}

function describePair({ fg, layers }: Pair): string {
  return `--${fg} on ${layers.map((token) => `--${token}`).join(' over ')}`;
}

/** `surface-raised` is in scope because every popup — attention peek, review launcher — paints on it. */
function textPairs(): Pair[] {
  return ['text', 'text-secondary', 'text-muted', 'attention-waiting-text'].flatMap((fg) =>
    ALL_BACKDROPS.map((backdrop) => ({ fg, layers: [backdrop], min: AA_TEXT })),
  );
}

function shellPairs(): Pair[] {
  return ALL_BACKDROPS.flatMap((backdrop) => [
    { fg: 'agent-brand-shell', layers: [backdrop, 'agent-brand-shell-bg'], min: AA_TEXT },
    { fg: 'agent-brand-shell-badge', layers: [backdrop, 'agent-brand-shell-badge-bg'], min: AA_TEXT },
    { fg: 'agent-brand-shell-border', layers: [backdrop], min: AA_NON_TEXT },
    { fg: 'agent-brand-shell-border', layers: [backdrop, 'agent-brand-shell-badge-bg'], min: AA_NON_TEXT },
  ]);
}

function attentionPairs(): Pair[] {
  return [
    { fg: 'attention-waiting-edge', layers: ['surface'], min: AA_NON_TEXT },
    { fg: 'attention-ready-dot', layers: ['surface'], min: AA_NON_TEXT },
    { fg: 'attention-ready-icon', layers: ['attention-ready-dot'], min: AA_TEXT },
  ];
}

function chromePairs(): Pair[] {
  return [
    { fg: 'accent-contrast', layers: ['accent'], min: AA_TEXT },
    ...ALL_BACKDROPS.map((backdrop) => ({ fg: 'focus-ring', layers: [backdrop], min: AA_NON_TEXT })),
  ];
}

function workspacePairs(): Pair[] {
  return ['workspace-wordmark-from', 'workspace-wordmark-via', 'workspace-wordmark-to'].map((fg) => ({
    fg,
    layers: ['bg'],
    min: AA_LARGE_TEXT,
  }));
}

const LOCKED_PAIRS: Pair[] = [
  ...textPairs(),
  ...attentionPairs(),
  ...chromePairs(),
  ...shellPairs(),
  ...workspacePairs(),
];

describe('theme contrast', () => {
  it('computes WCAG contrast against known reference pairs', () => {
    // Arrange
    const white = parseColor('#ffffff');

    // Assert
    expect(contrastRatio(parseColor('#000'), white)).toBeCloseTo(21, 5);
    expect(contrastRatio(parseColor('#767676'), white)).toBeCloseTo(4.54, 2);
    expect(contrastRatio(parseColor('rgba(0, 0, 0, 0.5)'), white)).toBeCloseTo(3.98, 2);
    expect(mixWithWhite(parseColor('#000'), 50)).toEqual({ r: 127.5, g: 127.5, b: 127.5, a: 1 });
    expect(mixWithWhite(parseColor('#123456'), FLAT_MIX)).toEqual(parseColor('#123456'));
  });

  it('resolves every theme against the :root fallback', () => {
    // Assert
    expect(Object.keys(themes).sort()).toEqual(['colorful', 'dark', 'dark-colorful', 'light']);
    expect(themes['dark-colorful'].chrome).toBe(themes.dark.chrome);
    expect(themes['dark-colorful']['attention-waiting-edge']).not.toBe(themes.dark['attention-waiting-edge']);
  });

  it('keeps every locked role pair at or above its WCAG floor in all themes', () => {
    // Act
    const failures = Object.keys(themes).flatMap((theme) =>
      LOCKED_PAIRS.map((pair) => ({ pair, ratio: measure(theme, pair), theme })).filter(
        ({ pair, ratio }) => ratio < pair.min,
      ),
    );

    // Assert
    expect(
      failures.map(({ pair, ratio, theme }) =>
        `${theme}: ${describePair(pair)} = ${ratio.toFixed(2)}:1 (needs ${pair.min}:1)`,
      ),
    ).toEqual([]);
  });

  it('keeps muted text visually distinct from secondary text in every theme', () => {
    // Assert
    expect(
      Object.keys(themes).filter(
        (theme) => themes[theme]['text-muted'] === themes[theme]['text-secondary'],
      ),
    ).toEqual([]);
  });

  it('pins the ready check contrast on the shipped flat dot in every theme', () => {
    // Act
    const measured = Object.fromEntries(
      Object.keys(themes).map((theme) => [theme, Number(readyInkOnDot(theme, FLAT_MIX).toFixed(2))]),
    );

    // Assert
    expect(measured).toEqual({ colorful: 5.48, dark: 8.23, 'dark-colorful': 8.23, light: 5.02 });
  });

  it('rejects every white-lifted ready highlight below the legibility floor', () => {
    // Act
    const legible = MIX_STEPS.filter((percent) =>
      Object.keys(themes).every((theme) => readyInkOnDot(theme, percent) >= AA_TEXT),
    );

    // Assert: only a lift too small to see survives, so the ready dot ships flat.
    expect(Math.min(...legible)).toBe(READY_HIGHLIGHT_LEGIBLE_FLOOR);
    expect(readyInkOnDot('colorful', RETIRED_READY_HIGHLIGHT_MIX)).toBeCloseTo(2.37, 2);
    expect(readyInkOnDot('light', RETIRED_READY_HIGHLIGHT_MIX)).toBeCloseTo(2.26, 2);
  });

  it('keeps the ready dot perceptually distinct from waiting and selection roles', () => {
    // Act
    const separations = Object.keys(themes).flatMap((theme) =>
      ['attention-waiting-text', 'attention-waiting-edge', 'accent'].map((token) => ({
        distance: colorDistance(tokenColor(theme, 'attention-ready-dot'), tokenColor(theme, token)),
        theme,
        token,
      })),
    );

    // Assert
    expect(
      separations
        .filter(({ distance }) => distance < MIN_ROLE_SEPARATION)
        .map(({ distance, theme, token }) =>
          `${theme}: --attention-ready-dot vs --${token} = ${distance.toFixed(1)} (needs ${MIN_ROLE_SEPARATION})`,
        ),
    ).toEqual([]);
  });
});
