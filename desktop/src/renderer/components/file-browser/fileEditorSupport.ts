import {
  acceptCompletion,
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  closeCompletion,
  completeAnyWord,
  moveCompletionSelection,
  pickedCompletion,
  snippetCompletion,
  startCompletion,
  type Completion,
  type CompletionResult,
  type CompletionSource,
} from '@codemirror/autocomplete';
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from '@codemirror/commands';
import {
  bracketMatching,
  foldGutter,
  foldKeymap,
  HighlightStyle,
  indentOnInput,
  indentUnit,
  StreamLanguage,
  syntaxHighlighting,
} from '@codemirror/language';
import {
  highlightSelectionMatches,
  search,
  searchKeymap,
} from '@codemirror/search';
import { EditorState, Prec, Transaction, type Extension } from '@codemirror/state';
import { tags } from '@lezer/highlight';
import { indentationMarkers } from '@replit/codemirror-indentation-markers';
import type { Diagnostic } from '@codemirror/lint';
import {
  Decoration,
  drawSelection,
  dropCursor,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
  MatchDecorator,
  rectangularSelection,
  ViewPlugin,
  type Command,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view';
import { isBinaryFileName } from '../../../shared/filePolicy';
import { createPathCompletionSource } from './pathCompletion';

const MIN_SEARCH_QUERY_LENGTH = 2;
const MAX_DOCUMENT_COMPLETION_SIZE = 150_000;

const BASE_COMPLETION_RE = /[\w-]*/;
const MARKDOWN_COMPLETION_RE = /[>#*`~\w-]*/;
const TEST_FILE_PATTERN = /(^|[/\\])__tests__([/\\]|$)|\.(spec|test)\.[^.]+$/;
const IGNORE_FILE_NAMES = new Set([
  '.dockerignore',
  '.eslintignore',
  '.gitignore',
  '.npmignore',
  '.prettierignore',
  '.stylelintignore',
]);

const SEARCH_MATCH_MARK = Decoration.mark({ class: 'aumx-file-editor-search-match' });

const acceptCompletionIfDocumentChanges: Command = (view) => {
  const before = view.state.doc;
  if (!acceptCompletion(view)) return false;
  return !view.state.doc.eq(before);
};

const acceptCompletionOrIndent: Command = (view) => (
  acceptCompletion(view) || indentWithTab.run?.(view) || false
);

const FILE_EDITOR_COMPLETION_KEYMAP = Prec.high(keymap.of([
  { key: 'Ctrl-Space', run: startCompletion },
  { mac: 'Alt-`', run: startCompletion },
  { mac: 'Alt-i', run: startCompletion },
  { key: 'Escape', run: closeCompletion },
  { key: 'ArrowDown', run: moveCompletionSelection(true) },
  { key: 'ArrowUp', run: moveCompletionSelection(false) },
  { key: 'PageDown', run: moveCompletionSelection(true, 'page') },
  { key: 'PageUp', run: moveCompletionSelection(false, 'page') },
  { key: 'Enter', run: acceptCompletionIfDocumentChanges },
  { key: 'Tab', run: acceptCompletionOrIndent },
]));

const suppressNoopCompletionHistory = EditorState.transactionExtender.of((transaction) => {
  if (
    !transaction.annotation(pickedCompletion)
    || !transaction.newDoc.eq(transaction.startState.doc)
  ) return null;

  return { annotations: Transaction.addToHistory.of(false) };
});

export type FileEditorLanguageKind =
  | 'css'
  | 'dockerfile'
  | 'gitignore'
  | 'html'
  | 'javascript'
  | 'json'
  | 'markdown'
  | 'plaintext'
  | 'properties'
  | 'python'
  | 'shell'
  | 'sql'
  | 'toml'
  | 'xml'
  | 'yaml';

type GrammarKey = FileEditorLanguageKind | 'jsx' | 'typescript' | 'typescript-jsx';

const grammarPromises = new Map<GrammarKey, Promise<Extension>>();
let jsonLintPromise: Promise<Extension> | null = null;

function createCompletion(label: string, type: Completion['type'], detail: string, apply?: string): Completion {
  return { apply, detail, label, type };
}

const JAVASCRIPT_KEYWORDS = [
  'as',
  'async',
  'await',
  'break',
  'case',
  'catch',
  'class',
  'const',
  'continue',
  'default',
  'enum',
  'export',
  'extends',
  'false',
  'finally',
  'for',
  'from',
  'function',
  'if',
  'implements',
  'import',
  'interface',
  'let',
  'new',
  'null',
  'private',
  'protected',
  'public',
  'readonly',
  'return',
  'switch',
  'throw',
  'true',
  'try',
  'type',
  'undefined',
  'unknown',
  'void',
  'while',
  'yield',
].map((label) => createCompletion(label, 'keyword', 'language'));

const JAVASCRIPT_TEST_KEYWORDS = [
  snippetCompletion("describe('${1:name}', () => {\n  $0\n});", {
    detail: 'test suite',
    label: 'describe',
    type: 'function',
  }),
  snippetCompletion("it('${1:name}', () => {\n  $0\n});", {
    detail: 'test case',
    label: 'it',
    type: 'function',
  }),
  snippetCompletion("test('${1:name}', () => {\n  $0\n});", {
    detail: 'test case',
    label: 'test',
    type: 'function',
  }),
  snippetCompletion('expect(${1:actual}).toEqual(${2:expected})', {
    detail: 'assertion',
    label: 'expect',
    type: 'function',
  }),
  snippetCompletion('beforeEach(() => {\n  $0\n});', {
    detail: 'setup hook',
    label: 'beforeEach',
    type: 'function',
  }),
  snippetCompletion('afterEach(() => {\n  $0\n});', {
    detail: 'teardown hook',
    label: 'afterEach',
    type: 'function',
  }),
  snippetCompletion('beforeAll(() => {\n  $0\n});', {
    detail: 'suite setup hook',
    label: 'beforeAll',
    type: 'function',
  }),
  snippetCompletion('afterAll(() => {\n  $0\n});', {
    detail: 'suite teardown hook',
    label: 'afterAll',
    type: 'function',
  }),
  createCompletion('vi', 'variable', 'vitest namespace'),
];

const JSON_LIKE_KEYWORDS = ['false', 'null', 'true'].map((label) => createCompletion(label, 'constant', 'value'));

const HTML_TAG_KEYWORDS = [
  'article',
  'aside',
  'button',
  'div',
  'footer',
  'form',
  'header',
  'img',
  'input',
  'label',
  'li',
  'main',
  'nav',
  'p',
  'section',
  'span',
  'ul',
].map((label) => createCompletion(label, 'type', 'tag'));

const CSS_PROPERTY_KEYWORDS = [
  'align-items',
  'background',
  'background-color',
  'border',
  'border-radius',
  'color',
  'display',
  'font-size',
  'font-weight',
  'gap',
  'grid-template-columns',
  'height',
  'justify-content',
  'line-height',
  'margin',
  'max-width',
  'min-height',
  'padding',
  'position',
  'width',
].map((label) => createCompletion(label, 'property', 'property'));

const MARKDOWN_KEYWORDS = [
  createCompletion('# ', 'keyword', 'heading'),
  createCompletion('## ', 'keyword', 'heading'),
  createCompletion('### ', 'keyword', 'heading'),
  createCompletion('- ', 'text', 'list'),
  createCompletion('* ', 'text', 'list'),
  createCompletion('1. ', 'text', 'list'),
  createCompletion('```', 'text', 'code fence'),
  createCompletion('> ', 'text', 'quote'),
];

const SHELL_KEYWORDS = [
  'cat',
  'cd',
  'find',
  'git',
  'grep',
  'ls',
  'mkdir',
  'npm',
  'pnpm',
  'rm',
].map((label) => createCompletion(label, 'function', 'command'));

const DOCKERFILE_KEYWORDS = [
  'ADD',
  'ARG',
  'CMD',
  'COPY',
  'ENTRYPOINT',
  'ENV',
  'EXPOSE',
  'FROM',
  'RUN',
  'USER',
  'VOLUME',
  'WORKDIR',
].map((label) => createCompletion(label, 'keyword', 'dockerfile'));

const PROPERTIES_KEYWORDS = ['false', 'true'].map((label) => createCompletion(label, 'constant', 'value'));

const PYTHON_KEYWORDS = [
  'as',
  'async',
  'await',
  'break',
  'class',
  'continue',
  'def',
  'elif',
  'else',
  'except',
  'False',
  'finally',
  'for',
  'from',
  'if',
  'import',
  'in',
  'is',
  'None',
  'pass',
  'return',
  'True',
  'try',
  'while',
  'with',
  'yield',
].map((label) => createCompletion(label, 'keyword', 'language'));

const SQL_KEYWORDS = [
  'ALTER',
  'CREATE',
  'DELETE',
  'FROM',
  'GROUP BY',
  'INSERT',
  'JOIN',
  'ORDER BY',
  'SELECT',
  'UPDATE',
  'VALUES',
  'WHERE',
].map((label) => createCompletion(label, 'keyword', 'sql'));

const TOML_KEYWORDS = ['false', 'true'].map((label) => createCompletion(label, 'constant', 'value'));

const KEYWORD_COMPLETIONS: Record<FileEditorLanguageKind, readonly Completion[]> = {
  css: CSS_PROPERTY_KEYWORDS,
  dockerfile: DOCKERFILE_KEYWORDS,
  gitignore: [],
  html: HTML_TAG_KEYWORDS,
  javascript: JAVASCRIPT_KEYWORDS,
  json: JSON_LIKE_KEYWORDS,
  markdown: MARKDOWN_KEYWORDS,
  plaintext: [],
  properties: PROPERTIES_KEYWORDS,
  python: PYTHON_KEYWORDS,
  shell: SHELL_KEYWORDS,
  sql: SQL_KEYWORDS,
  toml: TOML_KEYWORDS,
  xml: HTML_TAG_KEYWORDS,
  yaml: JSON_LIKE_KEYWORDS,
};

const FILE_EDITOR_HIGHLIGHT_STYLE = HighlightStyle.define([
  { tag: [tags.keyword, tags.modifier], color: 'color-mix(in srgb, var(--accent) 78%, var(--text) 22%)' },
  { tag: [tags.atom, tags.bool, tags.null, tags.number], color: 'color-mix(in srgb, var(--warning) 84%, var(--text) 16%)' },
  { tag: [tags.comment], color: 'var(--text-muted)', fontStyle: 'italic' },
  { tag: [tags.attributeName, tags.propertyName], color: 'color-mix(in srgb, var(--text) 88%, var(--accent) 12%)' },
  { tag: [tags.className, tags.definition(tags.variableName), tags.function(tags.variableName), tags.typeName], color: 'color-mix(in srgb, var(--accent) 66%, white 34%)' },
  { tag: [tags.link, tags.url], color: 'var(--accent)', textDecoration: 'underline' },
  { tag: [tags.operator, tags.punctuation, tags.separator], color: 'var(--text-secondary)' },
  { tag: [tags.quote], color: 'var(--text-secondary)', fontStyle: 'italic' },
  { tag: [tags.regexp, tags.special(tags.string), tags.string], color: 'color-mix(in srgb, var(--success) 80%, var(--text) 20%)' },
  { tag: [tags.variableName], color: 'var(--text-secondary)' },
  { tag: tags.heading, color: 'var(--text)', fontWeight: '700' },
  { tag: tags.invalid, color: 'var(--error)' },
]);

function escapeRegularExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isTestFile(fileName: string): boolean {
  return TEST_FILE_PATTERN.test(fileName.toLowerCase());
}

function getBaseFileName(fileName: string): string {
  return fileName.replace(/\\/g, '/').split('/').pop()?.toLowerCase() ?? '';
}

function isEnvFile(baseFileName: string): boolean {
  return baseFileName === '.env' || baseFileName.startsWith('.env.') || baseFileName === 'env.example';
}

function getLanguageKeywordCompletions(fileName: string, languageKind: FileEditorLanguageKind): readonly Completion[] {
  if (languageKind !== 'javascript' || !isTestFile(fileName)) {
    return KEYWORD_COMPLETIONS[languageKind];
  }

  return [...JAVASCRIPT_TEST_KEYWORDS, ...KEYWORD_COMPLETIONS.javascript];
}

function createKeywordCompletionSource(options: readonly Completion[], matchExpression: RegExp): CompletionSource {
  return (context) => {
    if (options.length === 0) {
      return null;
    }

    const match = context.matchBefore(matchExpression);
    if (!match) {
      if (!context.explicit) {
        return null;
      }

      return {
        from: context.pos,
        options,
        validFor: matchExpression,
      } satisfies CompletionResult;
    }

    if (match.from === match.to && !context.explicit) {
      return null;
    }

    return {
      from: match.from,
      options,
      validFor: matchExpression,
    } satisfies CompletionResult;
  };
}

const documentWordCompletionSource: CompletionSource = (context) => {
  if (context.state.doc.length > MAX_DOCUMENT_COMPLETION_SIZE && !context.explicit) {
    return null;
  }

  const match = context.matchBefore(BASE_COMPLETION_RE);
  if (!match || (match.from === match.to && !context.explicit)) {
    return null;
  }

  return completeAnyWord(context);
};

function createSearchHighlightPlugin(query: string): Extension {
  const decorator = new MatchDecorator({
    decoration: SEARCH_MATCH_MARK,
    maxLength: 5_000,
    regexp: new RegExp(escapeRegularExpression(query), 'gi'),
  });

  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;

      constructor(view: EditorView) {
        this.decorations = decorator.createDeco(view);
      }

      update(update: ViewUpdate): void {
        this.decorations = decorator.updateDeco(update, this.decorations);
      }
    },
    {
      decorations: (value) => value.decorations,
    },
  );
}

function getFileExtension(fileName: string): string {
  return getBaseFileName(fileName).split('.').pop()?.toLowerCase() ?? '';
}

export function isBinaryFile(fileName: string): boolean {
  return isBinaryFileName(fileName);
}

export function getFileEditorLanguageKind(fileName: string): FileEditorLanguageKind {
  const normalizedFileName = getBaseFileName(fileName);
  if (IGNORE_FILE_NAMES.has(normalizedFileName)) {
    return 'gitignore';
  }
  if (normalizedFileName === 'dockerfile' || normalizedFileName.startsWith('dockerfile.')) {
    return 'dockerfile';
  }
  if (normalizedFileName === 'makefile') {
    return 'plaintext';
  }
  if (normalizedFileName === 'poetry.lock') {
    return 'toml';
  }
  if (isEnvFile(normalizedFileName)) {
    return 'properties';
  }

  switch (getFileExtension(fileName)) {
    case 'css':
      return 'css';
    case 'htm':
    case 'html':
      return 'html';
    case 'cjs':
    case 'js':
    case 'jsx':
    case 'mjs':
    case 'ts':
    case 'tsx':
      return 'javascript';
    case 'json':
      return 'json';
    case 'md':
    case 'mdx':
      return 'markdown';
    case 'ini':
    case 'properties':
      return 'properties';
    case 'py':
    case 'pyw':
      return 'python';
    case 'sh':
    case 'bash':
    case 'zsh':
      return 'shell';
    case 'sql':
      return 'sql';
    case 'svg':
      return 'xml';
    case 'toml':
      return 'toml';
    case 'xml':
      return 'xml';
    case 'yaml':
    case 'yml':
      return 'yaml';
    default:
      return 'plaintext';
  }
}

export function isMarkdownFile(fileName: string): boolean {
  return getFileEditorLanguageKind(fileName) === 'markdown';
}

export function getFileKeywordCompletions(fileName: string): readonly Completion[] {
  const languageKind = getFileEditorLanguageKind(fileName);
  return getLanguageKeywordCompletions(fileName, languageKind);
}

export function createFileKeywordCompletionSource(fileName: string): CompletionSource {
  const languageKind = getFileEditorLanguageKind(fileName);
  const matchExpression = languageKind === 'markdown' ? MARKDOWN_COMPLETION_RE : BASE_COMPLETION_RE;
  return createKeywordCompletionSource(getLanguageKeywordCompletions(fileName, languageKind), matchExpression);
}

export function getFileEditorCompletionSources(
  fileName: string,
  rootPath?: string,
  relativePath?: string,
): CompletionSource[] {
  const languageKind = getFileEditorLanguageKind(fileName);
  if (languageKind === 'gitignore') {
    return rootPath && relativePath ? [createPathCompletionSource(rootPath, relativePath)] : [];
  }
  if (languageKind === 'javascript') {
    return isTestFile(fileName)
      ? [createKeywordCompletionSource(JAVASCRIPT_TEST_KEYWORDS, BASE_COMPLETION_RE)]
      : [];
  }
  if (languageKind === 'css' || languageKind === 'html') {
    return [];
  }
  if (languageKind === 'markdown') {
    return [createFileKeywordCompletionSource(fileName), documentWordCompletionSource];
  }
  return languageKind === 'plaintext'
    ? [documentWordCompletionSource]
    : [createFileKeywordCompletionSource(fileName), documentWordCompletionSource];
}

export function getFileEditorBaseExtensions(
  onDocumentChange: () => void,
  lineSeparator = '\n',
): Extension[] {
  return [
    EditorState.lineSeparator.of(lineSeparator),
    lineNumbers(),
    foldGutter(),
    history(),
    indentUnit.of('  '),
    indentOnInput(),
    indentationMarkers(),
    syntaxHighlighting(FILE_EDITOR_HIGHLIGHT_STYLE),
    bracketMatching(),
    closeBrackets(),
    search(),
    highlightSelectionMatches(),
    rectangularSelection(),
    drawSelection(),
    dropCursor(),
    EditorState.allowMultipleSelections.of(true),
    highlightActiveLine(),
    highlightActiveLineGutter(),
    EditorView.contentAttributes.of({
      'aria-label': 'File editor',
      autocapitalize: 'off',
      autocomplete: 'off',
      autocorrect: 'off',
      spellcheck: 'false',
    }),
    EditorView.editorAttributes.of({ class: 'aumx-file-editor' }),
    EditorView.updateListener.of((update) => {
      if (update.docChanged) {
        onDocumentChange();
      }
    }),
    FILE_EDITOR_COMPLETION_KEYMAP,
    keymap.of([
      ...foldKeymap,
      ...searchKeymap,
      indentWithTab,
      ...closeBracketsKeymap,
      ...historyKeymap,
      ...defaultKeymap,
    ]),
  ];
}

export function getFileEditorCompletionExtension(
  fileName: string,
  rootPath?: string,
  relativePath?: string,
): Extension {
  const amuxSources = getFileEditorCompletionSources(fileName, rootPath, relativePath);
  return [
    suppressNoopCompletionHistory,
    autocompletion({
      activateOnTyping: true,
      activateOnTypingDelay: 80,
      closeOnBlur: true,
      defaultKeymap: false,
      icons: true,
      maxRenderedOptions: 12,
      activateOnCompletion: (completion) => completion.type === 'folder',
    }),
    EditorState.languageData.of(() => amuxSources.map((autocomplete) => ({ autocomplete }))),
  ];
}

function getGrammarKey(fileName: string): GrammarKey {
  const extension = getFileExtension(fileName);
  if (getFileEditorLanguageKind(fileName) !== 'javascript') {
    return getFileEditorLanguageKind(fileName);
  }
  if (extension === 'tsx') return 'typescript-jsx';
  if (extension === 'ts') return 'typescript';
  if (extension === 'jsx') return 'jsx';
  return 'javascript';
}

function createGrammarPromise(key: GrammarKey): Promise<Extension> {
  switch (key) {
    case 'css':
      return import('@codemirror/lang-css').then(({ css }) => css());
    case 'html':
      return import('@codemirror/lang-html').then(({ html }) => html());
    case 'javascript':
      return import('@codemirror/lang-javascript').then(({ javascript }) => javascript());
    case 'jsx':
      return import('@codemirror/lang-javascript').then(({ javascript }) => javascript({ jsx: true }));
    case 'typescript':
      return import('@codemirror/lang-javascript').then(({ javascript }) => javascript({ typescript: true }));
    case 'typescript-jsx':
      return import('@codemirror/lang-javascript').then(({ javascript }) => javascript({ jsx: true, typescript: true }));
    case 'json':
      return import('@codemirror/lang-json').then(({ json }) => json());
    case 'markdown':
      return import('@codemirror/lang-markdown').then(({ markdown }) => markdown());
    case 'gitignore':
      return Promise.resolve([]);
    case 'dockerfile':
    case 'shell':
      return import('@codemirror/legacy-modes/mode/shell')
        .then(({ shell }) => StreamLanguage.define(shell));
    case 'properties':
      return import('@codemirror/legacy-modes/mode/properties')
        .then(({ properties }) => StreamLanguage.define(properties));
    case 'python':
      return import('@codemirror/legacy-modes/mode/python')
        .then(({ python }) => StreamLanguage.define(python));
    case 'sql':
      return import('@codemirror/legacy-modes/mode/sql')
        .then(({ standardSQL }) => StreamLanguage.define(standardSQL));
    case 'toml':
      return import('@codemirror/legacy-modes/mode/toml')
        .then(({ toml }) => StreamLanguage.define(toml));
    case 'xml':
      return import('@codemirror/lang-xml').then(({ xml }) => xml());
    case 'yaml':
      return import('@codemirror/lang-yaml').then(({ yaml }) => yaml());
    default:
      return Promise.resolve([]);
  }
}

export function loadFileEditorLanguageExtension(fileName: string): Promise<Extension> {
  const key = getGrammarKey(fileName);
  const existing = grammarPromises.get(key);
  if (existing) return existing;
  const grammar = createGrammarPromise(key);
  grammarPromises.set(key, grammar);
  return grammar;
}

export function getJsonDiagnostics(content: string): Diagnostic[] {
  try {
    JSON.parse(content);
    return [];
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid JSON';
    const positionMatch = /position\s+(\d+)/i.exec(message);
    const from = Math.min(Number(positionMatch?.[1] ?? 0), content.length);
    return [{
      from,
      to: Math.min(from + 1, content.length),
      severity: 'error',
      message,
    }];
  }
}

export function loadFileEditorLintExtension(fileName: string): Promise<Extension> {
  if (getFileEditorLanguageKind(fileName) !== 'json') return Promise.resolve([]);
  jsonLintPromise ??= import('@codemirror/lint').then(({ linter, lintGutter }) => [
    lintGutter(),
    linter((view) => getJsonDiagnostics(view.state.sliceDoc()), { delay: 500 }),
  ]);
  return jsonLintPromise;
}

export function getFileEditorReadOnlyExtension(readOnly: boolean): Extension {
  return [EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)];
}

export function getFileEditorSearchExtension(query?: string): Extension {
  if (!query || query.length < MIN_SEARCH_QUERY_LENGTH) {
    return [];
  }

  return createSearchHighlightPlugin(query);
}

export function getFileEditorWordWrapExtension(wordWrap: boolean): Extension {
  return wordWrap ? EditorView.lineWrapping : [];
}
