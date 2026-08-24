const EXT_TO_LANG: Record<string, string> = {
  bash: 'bash',
  c: 'c',
  cc: 'cpp',
  cjs: 'javascript',
  cpp: 'cpp',
  cs: 'csharp',
  css: 'css',
  go: 'go',
  h: 'cpp',
  hpp: 'cpp',
  html: 'xml',
  java: 'java',
  js: 'javascript',
  json: 'json',
  jsonc: 'json',
  jsx: 'javascript',
  kt: 'kotlin',
  less: 'less',
  lua: 'lua',
  md: 'markdown',
  mjs: 'javascript',
  php: 'php',
  py: 'python',
  rb: 'ruby',
  rs: 'rust',
  scss: 'scss',
  sh: 'bash',
  sql: 'sql',
  swift: 'swift',
  toml: 'ini',
  ts: 'typescript',
  tsx: 'typescript',
  vue: 'xml',
  xml: 'xml',
  yaml: 'yaml',
  yml: 'yaml',
};

export type CodeHighlighter = typeof import('highlight.js/lib/common')['default'];

let highlighterPromise: Promise<CodeHighlighter> | null = null;

export function loadCodeHighlighter(): Promise<CodeHighlighter> {
  if (!highlighterPromise) {
    const pending = import('highlight.js/lib/common').then((module) => module.default);
    let cached: Promise<CodeHighlighter>;
    cached = pending.catch((error: unknown) => {
      if (highlighterPromise === cached) highlighterPromise = null;
      throw error;
    });
    highlighterPromise = cached;
  }
  return highlighterPromise;
}

export function detectLanguage(fileName?: string): string | undefined {
  const ext = fileName?.split('.').pop()?.toLowerCase();
  if (!ext) return undefined;
  return EXT_TO_LANG[ext];
}

export function highlightToHtml(
  highlighter: CodeHighlighter | null,
  code: string,
  language?: string,
): string | null {
  if (!highlighter || !language || !highlighter.getLanguage(language)) return null;
  return highlighter.highlight(code, { language, ignoreIllegals: true }).value;
}
