// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react';
import { readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import React from 'react';
import { fileURLToPath } from 'url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProseMarkdown } from '../src/renderer/components/shared/ProseMarkdown';
import { useUiStore } from '../src/renderer/stores/ui.store';

vi.mock('../src/renderer/api/system.api', () => ({
  openExternal: vi.fn(),
}));

vi.mock('../src/renderer/api/file.api', () => ({
  readFileBinary: vi.fn(),
}));

afterEach(() => {
  cleanup();
  useUiStore.setState({ theme: 'dark' });
  document.documentElement.removeAttribute('data-theme');
});

function themeVariables(css: string, selector: string): Record<string, string> {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const block = css.match(new RegExp(`${escapedSelector}\\s*\\{([^}]*)\\}`, 's'))?.[1] ?? '';
  return Object.fromEntries(
    Array.from(block.matchAll(/--([\w-]+):\s*(#[0-9a-f]{6});/gi), (match) => [match[1], match[2]]),
  );
}

function relativeLuminance(hex: string): number {
  const channels = [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255);
  const [red, green, blue] = channels.map((channel) => (
    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  ));
  return (0.2126 * red) + (0.7152 * green) + (0.0722 * blue);
}

function contrastRatio(foreground: string, background: string): number {
  const lighter = Math.max(relativeLuminance(foreground), relativeLuminance(background));
  const darker = Math.min(relativeLuminance(foreground), relativeLuminance(background));
  return (lighter + 0.05) / (darker + 0.05);
}

describe('ProseMarkdown', () => {
  it('renders GFM tables inside a keyboard-scrollable responsive region', () => {
    const markdown = [
      '| Tool | Purpose | Notes |',
      '| --- | --- | --- |',
      '| Read | Opens files | Useful for inspection |',
      '| Bash | Runs commands | Can produce wide output |',
    ].join('\n');

    const { container } = render(<ProseMarkdown content={markdown} />);

    const region = screen.getByRole('region', { name: /scrollable markdown table/i });
    const table = screen.getByRole('table');

    expect(region.getAttribute('tabindex')).toBe('0');
    expect(region.classList.contains('prose-markdown-table-scroll')).toBe(true);
    expect(table.parentElement).toBe(region);
    expect(table.classList.contains('prose-markdown-responsive-table')).toBe(true);
    expect(container.querySelectorAll('table')).toHaveLength(1);
    expect(screen.getByRole('columnheader', { name: 'Tool' })).toBeTruthy();
    expect(screen.getByRole('cell', { name: 'Bash' })).toBeTruthy();
  });

  it('keeps the responsive table CSS contract explicit', () => {
    const cssPath = resolve(
      dirname(fileURLToPath(import.meta.url)),
      '../src/renderer/components/shared/ProseMarkdown.css',
    );
    const css = readFileSync(cssPath, 'utf8');

    expect(css).toMatch(/\.prose-markdown-chat\.markdown-body\s*\{[^}]*font-size:\s*inherit;/s);
    expect(css).toMatch(/\.prose-markdown-chat\.markdown-body\s*\{[^}]*line-height:\s*inherit;/s);
    expect(css).toMatch(/\.prose-markdown-table-scroll\s*\{[^}]*max-width:\s*100%;/s);
    expect(css).toMatch(/\.prose-markdown-table-scroll\s*\{[^}]*margin-block:\s*0 16px;/s);
    expect(css).toMatch(/\.prose-markdown-table-scroll\s*\{[^}]*overflow-x:\s*auto;/s);
    expect(css).toMatch(/\.prose-markdown-responsive-table\s*\{[^}]*display:\s*table;/s);
    expect(css).toMatch(/\.prose-markdown-responsive-table\s*\{[^}]*width:\s*max-content;/s);
    expect(css).toMatch(/\.prose-markdown-responsive-table\s*\{[^}]*min-width:\s*100%;/s);
    expect(css).toMatch(/\.prose-markdown-responsive-table\s*\{[^}]*overflow:\s*visible;/s);
  });

  it('maps GitHub markdown semantic colors to the explicit app theme outside OS media queries', () => {
    const cssPath = resolve(
      dirname(fileURLToPath(import.meta.url)),
      '../src/renderer/components/shared/ProseMarkdown.css',
    );
    const css = readFileSync(cssPath, 'utf8');
    const baseBlock = css.match(/\.prose-markdown\.markdown-body\s*\{([^}]*)\}/s)?.[1] ?? '';

    expect(baseBlock).toContain('--bgColor-default: transparent;');
    expect(baseBlock).toContain('--bgColor-muted: var(--prose-pre-bg);');
    expect(baseBlock).toContain('--bgColor-neutral-muted: var(--prose-code-bg);');
    expect(baseBlock).toContain('--fgColor-default: var(--prose-body);');
    expect(baseBlock).toContain('--fgColor-muted: var(--prose-muted);');
    expect(baseBlock).toContain('--fgColor-accent: var(--prose-link);');
    expect(baseBlock).toContain('--fgColor-success: var(--prose-success);');
    expect(baseBlock).toContain('--fgColor-attention: var(--prose-warning);');
    expect(baseBlock).toContain('--fgColor-danger: var(--prose-danger);');
    expect(baseBlock).toContain('--borderColor-default: var(--border);');
    expect(baseBlock).toContain('--borderColor-muted: var(--divider);');
    expect(baseBlock).toContain('--focus-outlineColor: var(--prose-accent);');
    expect(baseBlock).toContain('--color-prettylights-syntax-comment: var(--prose-muted);');
    expect(baseBlock).toContain('--color-prettylights-syntax-keyword: var(--prose-danger);');
    expect(baseBlock).toContain('--color-prettylights-syntax-string: var(--prose-success);');
  });

  it('keeps every colorful prose text and syntax token at WCAG AA contrast on light surfaces', () => {
    const themePath = resolve(
      dirname(fileURLToPath(import.meta.url)),
      '../src/renderer/styles/theme.css',
    );
    const variables = themeVariables(readFileSync(themePath, 'utf8'), '[data-theme="colorful"]');
    const bodyBackground = variables.bg;
    const codeBackground = variables['prose-pre-bg'];
    const proseTokens = [
      'prose-heading',
      'prose-body',
      'prose-muted',
      'prose-link',
      'prose-code-text',
      'prose-accent',
      'prose-success',
      'prose-warning',
      'prose-danger',
    ];

    expect(bodyBackground).toMatch(/^#[0-9a-f]{6}$/i);
    expect(codeBackground).toMatch(/^#[0-9a-f]{6}$/i);
    for (const token of proseTokens) {
      const color = variables[token];
      expect(color, `${token} must be an explicit hex token`).toMatch(/^#[0-9a-f]{6}$/i);
      if (!color) continue;
      expect(contrastRatio(color, bodyBackground), `${token} on colorful body`).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(color, codeBackground), `${token} on colorful code`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('keeps colorful terminal failure actions and critical copy at WCAG AA contrast', () => {
    const themePath = resolve(
      dirname(fileURLToPath(import.meta.url)),
      '../src/renderer/styles/theme.css',
    );
    const variables = themeVariables(readFileSync(themePath, 'utf8'), '[data-theme="colorful"]');
    expect(variables['accent-contrast']).toMatch(/^#[0-9a-f]{6}$/i);
    if (!variables['accent-contrast']) return;
    expect(contrastRatio(variables['accent-contrast'], variables.accent)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(variables['text-secondary'], variables['surface-raised'])).toBeGreaterThanOrEqual(4.5);
  });

  it('keeps pane-creation helper copy on an AA semantic text token', () => {
    const testDirectory = dirname(fileURLToPath(import.meta.url));
    const variables = themeVariables(
      readFileSync(resolve(testDirectory, '../src/renderer/styles/theme.css'), 'utf8'),
      '[data-theme="colorful"]',
    );
    const helperCopySources = [
      '../src/renderer/components/create/AgentSelector.tsx',
      '../src/renderer/components/create/CreatePaneDialog.tsx',
      '../src/renderer/components/create/SessionPicker.tsx',
    ].map((path) => readFileSync(resolve(testDirectory, path), 'utf8'));

    expect(contrastRatio(variables['text-secondary'], variables['surface-raised'])).toBeGreaterThanOrEqual(4.5);
    for (const source of helperCopySources) {
      expect(source).not.toContain('text-[color-mix(in_srgb,var(--text-muted)_70%,transparent)]');
    }
  });

  it('inherits the resolved root color scheme without subscribing to the unresolved system preference', () => {
    document.documentElement.setAttribute('data-theme', 'light');
    useUiStore.setState({ theme: 'system' });

    const { container } = render(<ProseMarkdown content="Root-resolved theme" />);
    const article = container.querySelector('article');
    const componentSource = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), '../src/renderer/components/shared/ProseMarkdown.tsx'),
      'utf8',
    );
    const proseCss = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), '../src/renderer/components/shared/ProseMarkdown.css'),
      'utf8',
    );
    const themeCss = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), '../src/renderer/styles/theme.css'),
      'utf8',
    );

    expect(article?.hasAttribute('data-theme')).toBe(false);
    expect(componentSource).not.toContain('useUiStore');
    expect(proseCss).toMatch(/\.prose-markdown\.markdown-body\s*\{[^}]*color-scheme:\s*inherit;/s);
    expect(proseCss).not.toMatch(/\.prose-markdown\.markdown-body\[data-theme=/);
    expect(themeCss).toMatch(/:root\s*\{[^}]*color-scheme:\s*dark;/s);
    expect(themeCss).toMatch(/\[data-theme="colorful"\]\s*\{[^}]*color-scheme:\s*light;/s);
    expect(themeCss).toMatch(/\[data-theme="light"\]\s*\{[^}]*color-scheme:\s*light;/s);
    expect(themeCss).toMatch(/\[data-theme="dark-colorful"\]\s*\{[^}]*color-scheme:\s*dark;/s);
  });

  it('strips raw HTML style and class attributes from untrusted markdown', () => {
    const markdown = '<div style="position:fixed;inset:0" class="spoof">Visible text</div>';

    render(<ProseMarkdown content={markdown} />);

    const div = screen.getByText('Visible text');
    expect(div.getAttribute('style')).toBeNull();
    expect(div.getAttribute('class')).toBeNull();
  });

  it('strips unsafe link protocols after applying the custom URL transform', () => {
    render(<ProseMarkdown content="[bad](javascript:alert(1))" />);

    const link = screen.getByText('bad').closest('a');
    expect(link).not.toBeNull();
    expect(link?.hasAttribute('href')).toBe(false);
  });
});
