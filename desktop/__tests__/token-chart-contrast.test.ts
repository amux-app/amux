// @vitest-environment happy-dom
import { readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';
import {
  COMPACTION_ALPHA,
  SERIES_ALPHA,
  seriesFill,
} from '../src/renderer/components/agent-devtools/TokenUsageDashboard';
import { CTA_LABEL_COLOR, CTA_STYLE } from '../src/renderer/components/shared/EmptyState';
import type { ThemeMode } from '../src/shared/theme-mode';

const GRAPHICAL_FLOOR = 3;
const SMALL_TEXT_FLOOR = 4.5;
// Compaction paints one hue at four alphas, so its lowest step trades contrast
// for the alpha separation that encodes the series. These pin the light-mode
// improvement (was 1.58 colorful / 1.79 light) without claiming the 3:1 floor.
const COMPACTION_LIGHT_FLOOR = 2.5;
const MIN_SERIES_SEPARATION = 10;
const MIN_COMPACTION_SEPARATION = 7.5;
const CHART_BACKDROP_BG_ALPHA = 0.6;

const SERIES = ['input', 'output', 'cacheRead', 'cacheCreate'] as const;
const THEME_SELECTORS: Record<string, { selector: string; mode: ThemeMode }> = {
  colorful: { selector: '[data-theme="colorful"]', mode: 'light' },
  dark: { selector: ':root', mode: 'dark' },
  'dark-colorful': { selector: '[data-theme="dark-colorful"]', mode: 'dark' },
  light: { selector: '[data-theme="light"]', mode: 'light' },
};

const themeCss = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../src/renderer/styles/theme.css'),
  'utf8',
);

function themeVariables(selector: string): Record<string, string> {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const block = themeCss.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, 's'))?.[1] ?? '';
  return Object.fromEntries(
    Array.from(block.matchAll(/--([\w-]+):\s*(#[0-9a-f]{3,8});/gi), (m) => [m[1], m[2].toLowerCase()]),
  );
}

function tokensFor(selector: string): Record<string, string> {
  return { ...themeVariables(':root'), ...themeVariables(selector) };
}

function channels(hex: string): number[] {
  return [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16));
}

function toHex(rgb: number[]): string {
  return `#${rgb.map((c) => Math.round(c).toString(16).padStart(2, '0')).join('')}`;
}

function blend(source: string, target: string, ratio: number): string {
  const [a, b] = [channels(source), channels(target)];
  return toHex([0, 1, 2].map((i) => ratio * a[i] + (1 - ratio) * b[i]));
}

function relativeLuminance(hex: string): number {
  const linear = channels(hex).map((c) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

function contrastRatio(foreground: string, background: string): number {
  const [first, second] = [relativeLuminance(foreground), relativeLuminance(background)];
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

function splitTopLevel(args: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const char of args) {
    if (char === '(') depth += 1;
    if (char === ')') depth -= 1;
    if (char === ',' && depth === 0) {
      parts.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  parts.push(current.trim());
  return parts;
}

function splitPercent(part: string): { color: string; percent: number | null } {
  const match = part.match(/^(.*?)\s+(\d+(?:\.\d+)?)%$/s);
  return match ? { color: match[1], percent: Number(match[2]) } : { color: part, percent: null };
}

/** Resolves the CSS the component actually ships, so a syntax slip fails loudly. */
function resolveColor(expression: string, tokens: Record<string, string>, backdrop: string): string {
  const expr = expression.trim();
  if (expr.startsWith('#')) return expr;

  const variable = expr.match(/^var\(--([\w-]+)\)$/);
  if (variable) return tokens[variable[1]];

  const mix = expr.match(/^color-mix\((.*)\)$/s);
  if (!mix) throw new Error(`unsupported color expression: ${expr}`);

  const [space, first, second] = splitTopLevel(mix[1]);
  expect(space).toBe('in srgb');
  const from = splitPercent(first);
  const ratio = (from.percent ?? 100 - (splitPercent(second).percent ?? 0)) / 100;
  const source = resolveColor(from.color, tokens, backdrop);
  const target = splitPercent(second).color === 'transparent'
    ? backdrop
    : resolveColor(splitPercent(second).color, tokens, backdrop);
  return blend(source, target, ratio);
}

function labColor(hex: string): number[] {
  const [r, g, b] = channels(hex).map((c) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  const xyz = [
    (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047,
    0.2126729 * r + 0.7151522 * g + 0.072175 * b,
    (0.0193339 * r + 0.119192 * g + 0.9503041 * b) / 1.08883,
  ].map((t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116));
  return [116 * xyz[1] - 16, 500 * (xyz[0] - xyz[1]), 200 * (xyz[1] - xyz[2])];
}

/** CIEDE2000 with the kL/kC/kH weights left at 1. */
function deltaE00(first: string, second: string): number {
  const [l1, a1, b1] = labColor(first);
  const [l2, a2, b2] = labColor(second);
  const toDeg = (r: number) => (r * 180) / Math.PI;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const meanC = (Math.hypot(a1, b1) + Math.hypot(a2, b2)) / 2;
  const g = 0.5 * (1 - Math.sqrt(meanC ** 7 / (meanC ** 7 + 25 ** 7)));
  const [ap1, ap2] = [a1 * (1 + g), a2 * (1 + g)];
  const [cp1, cp2] = [Math.hypot(ap1, b1), Math.hypot(ap2, b2)];
  const meanCp = (cp1 + cp2) / 2;
  const [hp1, hp2] = [(toDeg(Math.atan2(b1, ap1)) + 360) % 360, (toDeg(Math.atan2(b2, ap2)) + 360) % 360];
  const rawDh = hp2 - hp1;
  const dhp = cp1 * cp2 === 0 ? 0 : rawDh - 360 * Math.round(rawDh / 360);
  const dHp = 2 * Math.sqrt(cp1 * cp2) * Math.sin(toRad(dhp) / 2);
  const meanHp = cp1 * cp2 === 0 ? hp1 + hp2 : hp1 + rawDh / 2 - 180 * Math.round(rawDh / 360);
  const meanL = (l1 + l2) / 2;
  const t = 1 - 0.17 * Math.cos(toRad(meanHp - 30)) + 0.24 * Math.cos(toRad(2 * meanHp))
    + 0.32 * Math.cos(toRad(3 * meanHp + 6)) - 0.2 * Math.cos(toRad(4 * meanHp - 63));
  const sl = 1 + (0.015 * (meanL - 50) ** 2) / Math.sqrt(20 + (meanL - 50) ** 2);
  const sc = 1 + 0.045 * meanCp;
  const sh = 1 + 0.015 * meanCp * t;
  const rt = -2 * Math.sqrt(meanCp ** 7 / (meanCp ** 7 + 25 ** 7))
    * Math.sin(toRad(60 * Math.exp(-(((meanHp - 275) / 25) ** 2))));
  const [dl, dc] = [(l2 - l1) / sl, (cp2 - cp1) / sc];
  return Math.sqrt(dl ** 2 + dc ** 2 + (dHp / sh) ** 2 + rt * dc * (dHp / sh));
}

function chartFills(theme: string, isCompaction: boolean) {
  const { mode, selector } = THEME_SELECTORS[theme];
  const tokens = tokensFor(selector);
  const backdrop = blend(tokens.bg, tokens.surface, CHART_BACKDROP_BG_ALPHA);
  return {
    backdrop,
    fills: SERIES.map((series) => ({
      series,
      hex: resolveColor(seriesFill(series, isCompaction, mode), tokens, backdrop),
    })),
  };
}

function minimumSeparation(fills: Array<{ hex: string }>): number {
  const distances = fills.flatMap((a, i) => fills.slice(i + 1).map((b) => deltaE00(a.hex, b.hex)));
  return Math.min(...distances);
}

describe('token usage chart contrast', () => {
  it('computes WCAG contrast against known reference pairs', () => {
    // Assert
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrastRatio('#767676', '#ffffff')).toBeCloseTo(4.54, 2);
  });

  it('keeps dark-mode series fills byte-identical to the tuned originals', () => {
    // Assert
    expect(SERIES_ALPHA.dark).toEqual({ input: 45, output: 90, cacheRead: 65, cacheCreate: 75 });
    expect(COMPACTION_ALPHA.dark).toEqual({ input: 70, output: 95, cacheRead: 35, cacheCreate: 55 });
    expect(seriesFill('input', false, 'dark')).toBe('color-mix(in srgb, var(--accent) 45%, transparent)');
  });

  it('clears the 3:1 graphical floor for every series on light backdrops', () => {
    // Act
    const measured = ['colorful', 'light'].map((theme) => ({ theme, ...chartFills(theme, false) }));

    // Assert
    for (const { theme, backdrop, fills } of measured) {
      for (const { series, hex } of fills) {
        expect(contrastRatio(hex, backdrop), `${theme}/${series} ${hex} on ${backdrop}`)
          .toBeGreaterThanOrEqual(GRAPHICAL_FLOOR);
      }
    }
  });

  it('keeps co-rendered series perceptually separated in all four themes', () => {
    // Act
    const separations = Object.keys(THEME_SELECTORS).map((theme) => ({
      theme,
      series: minimumSeparation(chartFills(theme, false).fills),
      compaction: minimumSeparation(chartFills(theme, true).fills),
    }));

    // Assert
    for (const { theme, series, compaction } of separations) {
      expect(series, `${theme} series ΔE00 ${series.toFixed(1)}`).toBeGreaterThanOrEqual(MIN_SERIES_SEPARATION);
      expect(compaction, `${theme} compaction ΔE00 ${compaction.toFixed(1)}`)
        .toBeGreaterThanOrEqual(MIN_COMPACTION_SEPARATION);
    }
  });

  it('lifts compaction bars off the light backdrops', () => {
    // Act
    const measured = ['colorful', 'light'].map((theme) => ({ theme, ...chartFills(theme, true) }));

    // Assert
    for (const { theme, backdrop, fills } of measured) {
      for (const { series, hex } of fills) {
        expect(contrastRatio(hex, backdrop), `${theme}/${series} ${hex} on ${backdrop}`)
          .toBeGreaterThanOrEqual(COMPACTION_LIGHT_FLOOR);
      }
    }
  });

  it('gives cache-create and tool-results distinct tokens', () => {
    // Assert
    expect(seriesFill('cacheCreate', false, 'dark')).toContain('var(--warning)');
    expect(themeCss).toContain('--agent-waiting');
  });
});

describe('empty state CTA contrast', () => {
  it('keeps the CTA label above the small-text floor in every theme, resting and hovered', () => {
    // Arrange
    const label = CTA_LABEL_COLOR;
    const fill = `color-mix(in srgb, var(--accent) ${CTA_STYLE.fillPercent}%, transparent)`;
    const hover = `color-mix(in srgb, var(--accent) ${CTA_STYLE.hoverPercent}%, transparent)`;

    // Act
    const measured = Object.entries(THEME_SELECTORS).map(([theme, { selector }]) => {
      const tokens = tokensFor(selector);
      const resting = resolveColor(fill, tokens, tokens.bg);
      return {
        theme,
        hovered: contrastRatio(resolveColor(label, tokens, resting), resolveColor(hover, tokens, resting)),
        resting: contrastRatio(resolveColor(label, tokens, resting), resting),
      };
    });

    // Assert
    for (const { theme, hovered, resting } of measured) {
      expect(resting, `${theme} resting ${resting.toFixed(2)}:1`).toBeGreaterThanOrEqual(SMALL_TEXT_FLOOR);
      expect(hovered, `${theme} hovered ${hovered.toFixed(2)}:1`).toBeGreaterThanOrEqual(SMALL_TEXT_FLOOR);
    }
  });
});
