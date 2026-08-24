import { CompletionContext } from '@codemirror/autocomplete';
import { EditorState } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import {
  getFileEditorBaseExtensions,
  createFileKeywordCompletionSource,
  getFileEditorCompletionExtension,
  getFileEditorCompletionSources,
  getFileEditorLanguageKind,
  loadFileEditorLanguageExtension,
  getJsonDiagnostics,
  getFileKeywordCompletions,
  isBinaryFile,
  isMarkdownFile,
} from '../src/renderer/components/file-browser/fileEditorSupport';

describe('fileEditorSupport', () => {
  it('maps common file names to language kinds', () => {
    expect(getFileEditorLanguageKind('index.tsx')).toBe('javascript');
    expect(getFileEditorLanguageKind('README.md')).toBe('markdown');
    expect(getFileEditorLanguageKind('Dockerfile')).toBe('dockerfile');
    expect(getFileEditorLanguageKind('Dockerfile.dev')).toBe('dockerfile');
    expect(getFileEditorLanguageKind('script.mjs')).toBe('javascript');
    expect(getFileEditorLanguageKind('server.py')).toBe('python');
    expect(getFileEditorLanguageKind('migrations/init.sql')).toBe('sql');
    expect(getFileEditorLanguageKind('poetry.lock')).toBe('toml');
    expect(getFileEditorLanguageKind('settings.ini')).toBe('properties');
    expect(getFileEditorLanguageKind('.env.local')).toBe('properties');
    expect(getFileEditorLanguageKind('env.example')).toBe('properties');
    expect(getFileEditorLanguageKind('icon.svg')).toBe('xml');
    expect(getFileEditorLanguageKind('.gitignore')).toBe('gitignore');
    expect(getFileEditorLanguageKind('desktop/.dockerignore')).toBe('gitignore');
    expect(getFileEditorLanguageKind('config.ignore')).toBe('plaintext');
    expect(getFileEditorLanguageKind('config.unknown')).toBe('plaintext');
  });

  it('detects binary previews and markdown files', () => {
    expect(isBinaryFile('image.png')).toBe(true);
    expect(isBinaryFile('module.pyc')).toBe(true);
    expect(isBinaryFile('poetry.lock')).toBe(false);
    expect(isBinaryFile('icon.svg')).toBe(false);
    expect(isBinaryFile('notes.ts')).toBe(false);
    expect(isMarkdownFile('README.md')).toBe(true);
    expect(isMarkdownFile('src/app.ts')).toBe(false);
  });

  it('exposes lightweight keyword completions by file type', () => {
    expect(getFileKeywordCompletions('index.ts').some((completion) => completion.label === 'interface')).toBe(true);
    expect(getFileKeywordCompletions('index.test.ts').some((completion) => completion.label === 'describe')).toBe(true);
    expect(getFileKeywordCompletions('styles.css').some((completion) => completion.label === 'display')).toBe(true);
    expect(getFileKeywordCompletions('server.py').some((completion) => completion.label === 'def')).toBe(true);
    expect(getFileKeywordCompletions('schema.sql').some((completion) => completion.label === 'SELECT')).toBe(true);
    expect(getFileKeywordCompletions('README.md').some((completion) => completion.label === '```')).toBe(true);
  });

  it('offers typescript keyword completions for matching prefixes', () => {
    const source = createFileKeywordCompletionSource('index.ts');
    const context = new CompletionContext(EditorState.create({ doc: 'ret' }), 3, false);
    const result = source(context);

    if (!result || result instanceof Promise) {
      throw new Error('Expected synchronous completion result');
    }

    expect(result.from).toBe(0);
    expect(result.options.some((completion) => completion.label === 'return')).toBe(true);
  });

  it('offers test snippets for matching prefixes in test files', () => {
    const source = createFileKeywordCompletionSource('example.test.ts');
    const context = new CompletionContext(EditorState.create({ doc: 'des' }), 3, false);
    const result = source(context);

    if (!result || result instanceof Promise) {
      throw new Error('Expected synchronous completion result');
    }

    expect(result.from).toBe(0);
    expect(result.options.some((completion) => completion.label === 'describe')).toBe(true);
    expect(result.options.some((completion) => completion.label === 'beforeEach')).toBe(true);
  });

  it('allows explicit markdown completions without an active prefix', () => {
    const source = createFileKeywordCompletionSource('README.md');
    const context = new CompletionContext(EditorState.create({ doc: '' }), 0, true);
    const result = source(context);

    if (!result || result instanceof Promise) {
      throw new Error('Expected synchronous completion result');
    }

    expect(result.options.some((completion) => completion.label === '# ')).toBe(true);
    expect(result.options.some((completion) => completion.label === '> ')).toBe(true);
  });

  it('builds the base editor extensions without throwing', () => {
    expect(() => getFileEditorBaseExtensions(() => {})).not.toThrow();
    expect(getFileEditorBaseExtensions(() => {}).length).toBeGreaterThan(0);
  });

  it('keeps Amux completion sources scoped to file types that need them', () => {
    expect(getFileEditorCompletionSources('index.ts')).toHaveLength(0);
    expect(getFileEditorCompletionSources('styles.css')).toHaveLength(0);
    expect(getFileEditorCompletionSources('component.test.ts')).toHaveLength(1);
    expect(getFileEditorCompletionSources('README.md')).toHaveLength(2);
    expect(getFileEditorCompletionSources('settings.json')).toHaveLength(2);
    expect(getFileEditorCompletionSources('.gitignore', '/project', '.gitignore')).toHaveLength(1);
    expect(getFileEditorCompletionSources('.gitignore')).toHaveLength(0);
    expect(getFileEditorCompletionExtension('index.ts')).toBeDefined();
  });

  it('loads and caches only the requested grammar', async () => {
    const first = loadFileEditorLanguageExtension('index.ts');
    const second = loadFileEditorLanguageExtension('other.ts');

    expect(second).toBe(first);
    await expect(first).resolves.toBeDefined();
  });

  it.each([
    'Dockerfile',
    'settings.properties',
    'server.py',
    'schema.sql',
    'pyproject.toml',
  ])('loads the legacy grammar for %s', async (fileName) => {
    await expect(loadFileEditorLanguageExtension(fileName)).resolves.toBeDefined();
  });

  it('reports JSON syntax diagnostics only after parsing is requested', () => {
    expect(getJsonDiagnostics('{"valid":true}')).toEqual([]);
    expect(getJsonDiagnostics('{"broken": }')).toEqual([
      expect.objectContaining({ severity: 'error' }),
    ]);
  });
});
