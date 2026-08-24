// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  applyTerminalViewportStyle,
  TERMINAL_TOP_INSET_PX,
} from '../../src/renderer/lib/terminal-viewport-style';
import { TERMINAL_BACKGROUND_COLORS } from '../../src/shared/app-colors';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));

// Mirrors the renderer entry order: vendor xterm.css first, app styles last.
// `@import` is dropped because the Tailwind entry is resolved by the bundler.
function loadStylesheet(relativePath: string): void {
  const style = document.createElement('style');
  style.textContent = readFileSync(resolve(TEST_DIR, relativePath), 'utf8').replace(
    /^@import[^;]*;$/gm,
    '',
  );
  document.head.appendChild(style);
}

function themeToken(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function mountXtermElement(childClassName: string): HTMLElement {
  const root = document.createElement('div');
  root.className = 'xterm';
  const child = document.createElement('div');
  child.className = childClassName;
  root.appendChild(child);
  document.body.appendChild(root);
  return child;
}

describe('terminal viewport style', () => {
  it('reserves top inset on the xterm element so first-row glyphs are not clipped', () => {
    // Arrange
    const element = document.createElement('div');

    // Act
    applyTerminalViewportStyle({ element }, TERMINAL_BACKGROUND_COLORS.dark);

    // Assert
    expect(element.style.paddingTop).toBe(`${TERMINAL_TOP_INSET_PX}px`);
    expect(element.style.backgroundColor).toBe(TERMINAL_BACKGROUND_COLORS.dark);
  });

  it('paints the resolved background so a live theme swap repaints the viewport', () => {
    // Arrange
    const element = document.createElement('div');
    applyTerminalViewportStyle({ element }, TERMINAL_BACKGROUND_COLORS.dark);

    // Act
    applyTerminalViewportStyle({ element }, TERMINAL_BACKGROUND_COLORS.light);

    // Assert
    expect(element.style.backgroundColor).toBe(TERMINAL_BACKGROUND_COLORS.light);
  });
});

describe('xterm vendor css overrides', () => {
  it('clears the vendor black viewport so the themed background is not framed by dark edges', () => {
    // Arrange
    loadStylesheet('../../node_modules/@xterm/xterm/css/xterm.css');
    const viewport = mountXtermElement('xterm-viewport');
    expect(getComputedStyle(viewport).backgroundColor).toBe('#000');

    // Act
    loadStylesheet('../../src/renderer/styles/globals.css');

    // Assert
    expect(getComputedStyle(viewport).backgroundColor).toBe('transparent');
  });

  it('themes the vendor IME popup so it is not a black box in light mode', () => {
    // Arrange
    loadStylesheet('../../node_modules/@xterm/xterm/css/xterm.css');
    loadStylesheet('../../src/renderer/styles/theme.css');
    loadStylesheet('../../src/renderer/styles/globals.css');
    const composition = mountXtermElement('composition-view');

    // Act
    document.documentElement.setAttribute('data-theme', 'light');

    // Assert
    const style = getComputedStyle(composition);
    expect(style.backgroundColor).not.toBe('#000');
    expect(style.backgroundColor).toBe(themeToken('--bg'));
    expect(style.color).toBe(themeToken('--text'));
  });
});
