import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  FILE_BROWSER_COLLAPSED_PANEL_SIZE_VALUE,
  FILE_BROWSER_CROWDED_RESIZE_HANDLE_CLASS,
  FILE_BROWSER_CROWDED_VIEWER_CLASS,
  FILE_BROWSER_CROWDED_VIEWER_THRESHOLD,
  FILE_BROWSER_DEFAULT_PANEL_SIZE_VALUE,
  FILE_BROWSER_MAX_PANEL_SIZE_VALUE,
  FILE_BROWSER_MIN_PANEL_SIZE_VALUE,
  FILE_BROWSER_PANEL_CLASS,
  FILE_BROWSER_RESIZE_HANDLE_CLASS,
  FILE_BROWSER_RESIZE_TARGET_MINIMUM_SIZE,
  FILE_BROWSER_SHELL_RESIZE_HANDLE_CLASS,
  FILE_BROWSER_VIEWER_RESIZE_HANDLE_CLASS,
  FILE_VIEWER_PANEL_CLASS,
  MAIN_PANEL_DEFAULT_SIZE_VALUE,
  MAIN_PANEL_MIN_SIZE_VALUE,
} from '../src/renderer/components/file-browser/fileBrowserLayout';

describe('file browser resize layout contract', () => {
  it('lets separators own the file browser seams', () => {
    expect(FILE_BROWSER_PANEL_CLASS.split(' ')).not.toContain('border-r');
    expect(FILE_VIEWER_PANEL_CLASS.split(' ')).not.toContain('border-l');
    expect(FILE_BROWSER_RESIZE_HANDLE_CLASS.split(' ')).toContain('aumx-resize-handle--file-browser');
    expect(FILE_BROWSER_SHELL_RESIZE_HANDLE_CLASS.split(' ')).toContain('aumx-resize-handle--file-browser-shell');
    expect(FILE_BROWSER_VIEWER_RESIZE_HANDLE_CLASS.split(' ')).toContain('aumx-resize-handle--file-browser-viewer');
  });

  it('uses a larger resize hit target for file browser splits', () => {
    expect(FILE_BROWSER_RESIZE_TARGET_MINIMUM_SIZE).toEqual({ fine: 14, coarse: 28 });
  });

  it('uses explicit percentage strings for resizable panel layout sizes', () => {
    expect(FILE_BROWSER_COLLAPSED_PANEL_SIZE_VALUE).toBe('0%');
    expect(FILE_BROWSER_DEFAULT_PANEL_SIZE_VALUE).toBe('17.25%');
    expect(FILE_BROWSER_MIN_PANEL_SIZE_VALUE).toBe('10%');
    expect(FILE_BROWSER_MAX_PANEL_SIZE_VALUE).toBe('70%');
    expect(MAIN_PANEL_DEFAULT_SIZE_VALUE).toBe('82.75%');
    expect(MAIN_PANEL_MIN_SIZE_VALUE).toBe('30%');
  });

  it('defines a crowded-state cue when the viewer becomes too narrow', () => {
    expect(FILE_BROWSER_CROWDED_RESIZE_HANDLE_CLASS).toBe('aumx-resize-handle--file-browser-crowded');
    expect(FILE_BROWSER_CROWDED_VIEWER_CLASS).toBe('aumx-file-viewer--crowded');
    expect(FILE_BROWSER_CROWDED_VIEWER_THRESHOLD).toBe(220);
  });

  it('defines a dedicated file browser separator affordance', () => {
    const css = readFileSync(new URL('../src/renderer/styles/globals.css', import.meta.url), 'utf8');

    expect(css).toContain('.aumx-resize-handle--file-browser');
    expect(css).toContain('.aumx-resize-handle--file-browser-crowded');
    expect(css).toContain('.aumx-file-viewer--crowded');
    expect(css).toContain('width: 11px;');
    expect(css).toContain('height: 34px;');
    expect(css).toContain('translate(calc(-50% - 3px), -50%)');
    expect(css).toContain('translate(calc(-50% + 3px), -50%)');
  });
});
