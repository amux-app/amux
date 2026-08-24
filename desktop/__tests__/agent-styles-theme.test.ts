import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AGENT_STYLES, paneSidebarTopLineColor } from '../src/renderer/lib/constants';

const CONSTANTS_SOURCE = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../src/renderer/lib/constants.ts'),
  'utf8',
);

const DENSE_SOURCE = CONSTANTS_SOURCE.replace(/\s+/g, '').toLowerCase();

const RETIRED_SHELL_LITERALS = [
  '#5EEAD4',
  '#A7F3D0',
  'rgba(52,211,153',
  'rgba(255,255,255,0.03)',
  'rgba(255,255,255,0.04)',
];

const SHELL_STYLE = {
  badgeBg: 'var(--agent-brand-shell-badge-bg)',
  badgeBorder: 'var(--agent-brand-shell-border)',
  badgeText: 'var(--agent-brand-shell-badge)',
  bg: 'var(--agent-brand-shell-bg)',
  letter: '>',
  text: 'var(--agent-brand-shell)',
};

const BRAND_IDENTITY = {
  claude: {
    badgeBg: 'rgba(139, 92, 246, 0.18)',
    badgeBorder: 'rgba(139, 92, 246, 0.35)',
    badgeText: 'var(--agent-brand-claude-badge)',
    bg: 'rgba(139, 92, 246, 0.12)',
    letter: 'C',
    text: 'var(--agent-brand-claude)',
  },
  codex: {
    badgeBg: 'rgba(245, 158, 11, 0.18)',
    badgeBorder: 'rgba(245, 158, 11, 0.35)',
    badgeText: 'var(--agent-brand-codex-badge)',
    bg: 'rgba(245, 158, 11, 0.12)',
    letter: 'X',
    text: 'var(--agent-brand-codex)',
  },
  opencode: {
    badgeBg: 'rgba(56, 189, 248, 0.18)',
    badgeBorder: 'rgba(56, 189, 248, 0.35)',
    badgeText: 'var(--agent-brand-opencode-badge)',
    bg: 'rgba(125, 211, 252, 0.12)',
    letter: 'O',
    text: 'var(--agent-brand-opencode)',
  },
};

describe('shell agent identity tokens', () => {
  it('drives every shell surface from the semantic shell tokens', () => {
    // Assert
    expect(AGENT_STYLES.shell).toEqual(SHELL_STYLE);
  });

  it('drops every dark-only shell literal from the constants module', () => {
    // Act
    const survivors = RETIRED_SHELL_LITERALS.filter((literal) =>
      DENSE_SOURCE.includes(literal.replace(/\s+/g, '').toLowerCase()),
    );

    // Assert
    expect(survivors).toEqual([]);
  });

  it('keeps the sidebar top-line consumer contract on the shell badge token', () => {
    // Assert
    expect(paneSidebarTopLineColor('shell', true)).toBe(
      'color-mix(in srgb, var(--agent-brand-shell-badge) 62%, transparent)',
    );
    expect(paneSidebarTopLineColor('shell', false)).toBeUndefined();
  });
});

describe('branded agent identity', () => {
  it('leaves the claude, codex and opencode identity colours untouched', () => {
    // Act
    const branded = Object.fromEntries(
      Object.keys(BRAND_IDENTITY).map((agent) => [agent, AGENT_STYLES[agent]]),
    );

    // Assert
    expect(branded).toEqual(BRAND_IDENTITY);
  });
});
