import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { basename, resolve } from 'path';
import { APP_WINDOW_BACKGROUND_COLORS, TERMINAL_BACKGROUND_COLORS } from '../src/shared/app-colors';
import { IPC, IPC_EVENT } from '../src/shared/ipc-channels';
import { createTerminalTheme } from '../src/shared/terminal-profile';

const ROOT = resolve(__dirname, '..');
const OUT = resolve(ROOT, 'out');
const HAS_BUILD_OUTPUT = existsSync(resolve(OUT, 'main/index.js'))
  && existsSync(resolve(OUT, 'preload/index.js'))
  && existsSync(resolve(OUT, 'renderer/index.html'));

if (!HAS_BUILD_OUTPUT) {
  describe('Build output', () => {
    it('is deferred until the desktop build command runs', () => {
      expect(HAS_BUILD_OUTPUT).toBe(false);
    });
  });
} else {
describe('Build output', () => {
  it('main/index.js exists', () => {
    expect(existsSync(resolve(OUT, 'main/index.js'))).toBe(true);
  });

  it('preload/index.js exists', () => {
    expect(existsSync(resolve(OUT, 'preload/index.js'))).toBe(true);
  });

  it('renderer/index.html exists', () => {
    expect(existsSync(resolve(OUT, 'renderer/index.html'))).toBe(true);
  });

  it('uses the canonical app shell background in packaged entry points', () => {
    const mainBundle = readFileSync(resolve(OUT, 'main/index.js'), 'utf-8');
    const rendererHTML = readFileSync(resolve(OUT, 'renderer/index.html'), 'utf-8');
    const rendererAssets = resolve(OUT, 'renderer/assets');
    const rendererCss = readdirSync(rendererAssets)
      .filter((file) => file.endsWith('.css'))
      .map((file) => readFileSync(resolve(rendererAssets, file), 'utf-8'))
      .join('\n');

    expect(mainBundle).toContain('const PREMIUM_BLACK = "#000000"');
    expect(mainBundle).toContain('dark: PREMIUM_BLACK');
    expect(mainBundle).toContain('backgroundColor: APP_WINDOW_BACKGROUND_COLORS[getAppThemeMode()]');
    expect(APP_WINDOW_BACKGROUND_COLORS.dark).toBe('#000000');
    // The native window background owns the pre-React frame so it can follow the
    // persisted theme; a hardcoded body color would black out light launches.
    expect(rendererHTML).toContain('body { margin: 0; }');
    expect(rendererHTML).not.toContain('background: #000000');
    expect(rendererCss).toContain('--bg: #000000;');
  });

  it('packages terminal fonts as local assets instead of CSP-blocked data URLs', () => {
    const rendererAssets = resolve(OUT, 'renderer/assets');
    const rendererCss = readdirSync(rendererAssets)
      .filter((file) => file.endsWith('.css'))
      .map((file) => readFileSync(resolve(rendererAssets, file), 'utf-8'))
      .join('\n');

    expect(rendererCss).toContain('Google Sans Code');
    expect(rendererCss).toContain('Intel One Mono');
    expect(rendererCss).toContain('.woff2');
    expect(rendererCss).not.toContain('data:font/');
  });

  it('emits only unicode-ranged WOFF2 font faces', () => {
    const rendererAssets = resolve(OUT, 'renderer/assets');
    const assets = readdirSync(rendererAssets);
    const fontAssets = assets.filter((file) => /\.woff2?$/.test(file));
    const rendererCss = assets
      .filter((file) => file.endsWith('.css'))
      .map((file) => readFileSync(resolve(rendererAssets, file), 'utf-8'))
      .join('\n');
    const totalFontBytes = fontAssets.reduce(
      (total, file) => total + statSync(resolve(rendererAssets, file)).size,
      0,
    );

    expect(fontAssets.every((file) => file.endsWith('.woff2'))).toBe(true);
    expect(fontAssets).toHaveLength(24);
    expect(totalFontBytes).toBeLessThanOrEqual(550_000);
    expect(rendererCss).toContain('unicode-range:');
    expect(fontAssets.some((file) => file.includes('inter-latin-300'))).toBe(false);
  });
});
}

if (HAS_BUILD_OUTPUT) {
describe('Main bundle isolation', () => {
  const mainBundle = readFileSync(resolve(OUT, 'main/index.js'), 'utf-8');

  const browserOnlyAPIs = ['document.', 'localStorage', 'sessionStorage'];

  it.each(browserOnlyAPIs)('does not reference browser API "%s"', (api) => {
    const lines = mainBundle.split('\n');
    const matches = lines.filter((line) => {
      if (line.trimStart().startsWith('//') || line.trimStart().startsWith('*')) return false;
      return line.includes(api);
    });
    expect(matches).toEqual([]);
  });

  it('does not reference the browser window global (excludes Electron BrowserWindow)', () => {
    const lines = mainBundle.split('\n');
    const matches = lines.filter((line) => {
      if (line.trimStart().startsWith('//') || line.trimStart().startsWith('*')) return false;
      if (!line.includes('window.')) return false;
      // Electron main process legitimately uses this.window (BrowserWindow reference)
      if (line.includes('this.window')) return false;
      return true;
    });
    expect(matches).toEqual([]);
  });
});
}

if (HAS_BUILD_OUTPUT) {
describe('Renderer bundle isolation', () => {
  const rendererHTML = readFileSync(resolve(OUT, 'renderer/index.html'), 'utf-8');
  const scriptMatch = rendererHTML.match(/src="([^"]+\.js)"/);

  it('renderer HTML references a JS bundle', () => {
    expect(scriptMatch).not.toBeNull();
  });

  const nodeOnlyModules = ['child_process', 'fs', 'path', 'os', 'net', 'cluster', 'dgram', 'dns', 'tls'];

  if (scriptMatch) {
    const jsPath = resolve(OUT, 'renderer', scriptMatch[1]);
    if (existsSync(jsPath)) {
      const rendererBundle = readFileSync(jsPath, 'utf-8');

      it.each(nodeOnlyModules)('does not require Node.js module "%s"', (mod) => {
        const requirePattern = new RegExp(`require\\s*\\(\\s*['"]${mod}['"]\\s*\\)`);
        expect(rendererBundle).not.toMatch(requirePattern);
      });

      // Asserted on the theme source rather than bundle text: the renderer bundle
      // is minified, so identifier names do not survive. The palette value does.
      it('packages the canonical terminal palettes in the renderer bundle', () => {
        const dark = createTerminalTheme('dark');
        const light = createTerminalTheme('light');

        expect(TERMINAL_BACKGROUND_COLORS.dark).toBe('#000000');
        expect(dark.background).toBe(TERMINAL_BACKGROUND_COLORS.dark);
        expect(dark.cursorAccent).toBe(TERMINAL_BACKGROUND_COLORS.dark);
        expect(dark.black).toBe(TERMINAL_BACKGROUND_COLORS.dark);
        expect(light.background).toBe(TERMINAL_BACKGROUND_COLORS.light);
        expect(rendererBundle).toContain(TERMINAL_BACKGROUND_COLORS.dark);
        expect(rendererBundle).toContain(TERMINAL_BACKGROUND_COLORS.light);
      });
    }
  }
});
}

if (HAS_BUILD_OUTPUT) {
describe('Renderer performance budgets', () => {
  const rendererRoot = resolve(OUT, 'renderer');
  const rendererAssets = resolve(rendererRoot, 'assets');
  const rendererHTML = readFileSync(resolve(rendererRoot, 'index.html'), 'utf-8');
  const scriptMatch = rendererHTML.match(/src="([^"]+\.js)"/);

  it('keeps the shared CodeMirror language runtime out of lazy grammar imports', () => {
    const editorSupport = readFileSync(
      resolve(ROOT, 'src/renderer/components/file-browser/fileEditorSupport.ts'),
      'utf-8',
    );

    expect(editorSupport).not.toContain("import('@codemirror/language')");
    expect(editorSupport).toContain("import('@codemirror/legacy-modes/mode/python')");
  });

  it('keeps the initial renderer entry below 1.95 MB', () => {
    expect(scriptMatch).not.toBeNull();
    const entryPath = resolve(rendererRoot, scriptMatch![1]);
    expect(statSync(entryPath).size).toBeLessThanOrEqual(1_950_000);
  });

  it('keeps every lazy renderer chunk below 1.05 MB', () => {
    expect(scriptMatch).not.toBeNull();
    const entryFile = basename(scriptMatch![1]);
    const oversizedLazyChunks = readdirSync(rendererAssets)
      .filter((file) => file.endsWith('.js') && file !== entryFile)
      .filter((file) => statSync(resolve(rendererAssets, file)).size > 1_050_000);

    expect(oversizedLazyChunks).toEqual([]);
  });

  it('moves all-language diff highlighting outside the initial entry', () => {
    expect(scriptMatch).not.toBeNull();
    const entry = readFileSync(resolve(rendererRoot, scriptMatch![1]), 'utf-8');

    expect(entry).not.toContain('zephir');
    expect(entry).not.toContain('smali');
    expect(entry).not.toContain('Unknown language:');
    expect(entry).not.toContain('Highlight.js');
    expect(entry).not.toContain('hljs-');
  });

  it('emits feature chunks instead of one monolithic renderer bundle', () => {
    const javascriptAssets = readdirSync(rendererAssets)
      .filter((file) => file.endsWith('.js'));

    expect(javascriptAssets.length).toBeGreaterThan(1);
  });

  it('keeps syntax highlighting and the optional board outside the initial entry', () => {
    const javascriptAssets = readdirSync(rendererAssets)
      .filter((file) => file.endsWith('.js'));

    expect(javascriptAssets.some((file) => file.startsWith('common-'))).toBe(true);
    expect(javascriptAssets.some((file) => file.startsWith('KanbanBoard-'))).toBe(true);
  });

  it('keeps the lazy Git diff feature below 1.05 MB', () => {
    const gitDiffChunk = readdirSync(rendererAssets)
      .find((file) => file.startsWith('GitDiffView-') && file.endsWith('.js'));

    expect(gitDiffChunk).toBeDefined();
    expect(statSync(resolve(rendererAssets, gitDiffChunk!)).size).toBeLessThanOrEqual(1_050_000);
  });
});
}

describe('IPC channel uniqueness', () => {
  const allIPCValues = Object.values(IPC);
  const allEventValues = Object.values(IPC_EVENT);
  const allChannels = [...allIPCValues, ...allEventValues];

  it('IPC channels have no duplicates', () => {
    const seen = new Set<string>();
    const duplicates: string[] = [];
    for (const ch of allIPCValues) {
      if (seen.has(ch)) duplicates.push(ch);
      seen.add(ch);
    }
    expect(duplicates).toEqual([]);
  });

  it('IPC_EVENT channels have no duplicates', () => {
    const seen = new Set<string>();
    const duplicates: string[] = [];
    for (const ch of allEventValues) {
      if (seen.has(ch)) duplicates.push(ch);
      seen.add(ch);
    }
    expect(duplicates).toEqual([]);
  });

  it('no overlap between IPC and IPC_EVENT channels', () => {
    const overlap = allIPCValues.filter((ch) =>
      allEventValues.includes(ch as (typeof allEventValues)[number]),
    );
    expect(overlap).toEqual([]);
  });

  it('combined channels have no duplicates', () => {
    const unique = new Set(allChannels);
    expect(unique.size).toBe(allChannels.length);
  });
});

describe('IPC_EVENT naming convention', () => {
  it.each(Object.entries(IPC_EVENT))('%s channel starts with "event:"', (_key, value) => {
    expect(value).toMatch(/^event:/);
  });
});

describe('IPC channel format (domain:action)', () => {
  it.each(Object.entries(IPC))('%s channel follows domain:action format', (_key, value) => {
    expect(value).toMatch(/^[a-z][-a-z]*:[a-z][-a-z]*$/);
  });

  it.each(Object.entries(IPC_EVENT))('%s channel follows event:domain-action format', (_key, value) => {
    expect(value).toMatch(/^event:[a-z][-a-z]*$/);
  });
});
