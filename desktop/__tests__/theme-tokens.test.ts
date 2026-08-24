import { readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';

const THEME_BLOCK = /^(:root|\[data-theme="[^"]+"\])\s*\{([^}]*)\}/gm;
const DECLARATION = /--([\w-]+):\s*([^;]+);/g;
const COLOR_VALUE = /^(#[0-9a-f]{3}|#[0-9a-f]{6}|rgba?\([\d\s.,]+\))$/i;
const DEFAULT_THEME = 'dark';

const COLOR_ROLES = [
  'accent',
  'accent-contrast',
  'agent-brand-shell',
  'agent-brand-shell-badge',
  'agent-brand-shell-badge-bg',
  'agent-brand-shell-bg',
  'agent-brand-shell-border',
  'attention-ready-dot',
  'attention-ready-icon',
  'attention-waiting-edge',
  'attention-waiting-text',
  'bg',
  'chrome',
  'focus-ring',
  'surface',
  'surface-raised',
  'text',
  'text-muted',
  'text-secondary',
  'workspace-orb-primary',
  'workspace-orb-secondary',
  'workspace-wordmark-from',
  'workspace-wordmark-to',
  'workspace-wordmark-via',
];

/** `--control-dense` encodes the shipped 22px icon-button metric; 24px is the floor elsewhere. */
const METRIC_ROLES: Record<string, string> = {
  'control-dense': '22px',
  'control-min': '24px',
  'space-content': '16px',
  'space-dense': '8px',
  'space-panel': '12px',
};

const themeCss = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../src/renderer/styles/theme.css'),
  'utf8',
);

function themeBlocks(css: string): Record<string, Record<string, string>> {
  const blocks: Record<string, Record<string, string>> = {};
  for (const [, selector, body] of css.matchAll(THEME_BLOCK)) {
    const name = selector === ':root' ? DEFAULT_THEME : selector.slice('[data-theme="'.length, -2);
    blocks[name] = Object.fromEntries(
      Array.from(body.matchAll(DECLARATION), (match) => [match[1], match[2].trim()]),
    );
  }
  return blocks;
}

const blocks = themeBlocks(themeCss);
const effective = Object.fromEntries(
  Object.entries(blocks).map(([name, tokens]) => [name, { ...blocks[DEFAULT_THEME], ...tokens }]),
);

function missingRoles(tokens: Record<string, string>, roles: string[]): string[] {
  return roles.filter((role) => !tokens[role]);
}

describe('theme token roles', () => {
  it('discovers every shipped theme block', () => {
    // Assert
    expect(Object.keys(blocks).sort()).toEqual(['colorful', 'dark', 'dark-colorful', 'light']);
  });

  it('gives every theme the full semantic colour role set', () => {
    // Act
    const gaps = Object.entries(effective)
      .map(([theme, tokens]) => ({ missing: missingRoles(tokens, COLOR_ROLES), theme }))
      .filter(({ missing }) => missing.length > 0);

    // Assert
    expect(gaps.map(({ missing, theme }) => `${theme} is missing ${missing.join(', ')}`)).toEqual([]);
  });

  it('keeps every colour role parseable as hex or rgba', () => {
    // Act
    const invalid = Object.entries(effective).flatMap(([theme, tokens]) =>
      COLOR_ROLES.filter((role) => !COLOR_VALUE.test(tokens[role])).map(
        (role) => `${theme}: --${role} = ${tokens[role]}`,
      ),
    );

    // Assert
    expect(invalid).toEqual([]);
  });

  it('pins the spacing and control metrics to their exact values in every theme', () => {
    // Act
    const drift = Object.entries(effective).flatMap(([theme, tokens]) =>
      Object.entries(METRIC_ROLES)
        .filter(([role, value]) => tokens[role] !== value)
        .map(([role, value]) => `${theme}: --${role} = ${tokens[role]} (expected ${value})`),
    );

    // Assert
    expect(drift).toEqual([]);
  });

  it('keeps the primary text role on --text and rejects a --text-primary duplicate', () => {
    // Act
    const duplicates = Object.entries(blocks)
      .filter(([, tokens]) => 'text-primary' in tokens)
      .map(([theme]) => theme);

    // Assert
    expect(duplicates).toEqual([]);
    expect(themeCss).not.toContain('--text-primary');
    expect(Object.values(effective).every((tokens) => Boolean(tokens.text))).toBe(true);
  });

  it('overrides only the roles a theme actually diverges on', () => {
    // Assert
    expect(blocks['dark-colorful'].chrome).toBeUndefined();
    expect(blocks['dark-colorful']['agent-brand-shell']).toBeUndefined();
    expect(effective['dark-colorful'].chrome).toBe(blocks.dark.chrome);
    expect(effective['dark-colorful']['agent-brand-shell']).toBe(blocks.dark['agent-brand-shell']);
  });
});
