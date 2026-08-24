import { useEffect, useState, type ReactNode } from 'react';
import {
  detectLanguage,
  highlightToHtml,
  loadCodeHighlighter,
  type CodeHighlighter,
} from '../../../lib/codeHighlight';

const DEFAULT_MAX_HEIGHT = 300;
const ERROR_MAX_HEIGHT = 300;

const DEL_ROW_BG = 'color-mix(in srgb, var(--error) 12%, transparent)';
const INS_ROW_BG = 'color-mix(in srgb, var(--success) 13%, transparent)';
const DEL_GUTTER_BG = 'color-mix(in srgb, var(--error) 20%, transparent)';
const INS_GUTTER_BG = 'color-mix(in srgb, var(--success) 20%, transparent)';
const DEL_PILL_BG = 'color-mix(in srgb, var(--error) 14%, transparent)';
const INS_PILL_BG = 'color-mix(in srgb, var(--success) 16%, transparent)';
const ERROR_BANNER_BG = 'color-mix(in srgb, var(--error) 8%, transparent)';

const CODE_TEXT = 'font-mono text-[11px] leading-[1.55] whitespace-pre';
const GUTTER_NUM = 'select-none align-top text-right px-2 text-[10px] leading-[1.55] text-[var(--text-muted)]';
const TIGHT_CELL = { width: '1%', whiteSpace: 'nowrap' as const };

interface FileHeaderProps {
  icon?: ReactNode;
  path: string;
  children?: ReactNode;
}

export function FileHeader({ icon, path, children }: FileHeaderProps) {
  return (
    <div className="flex items-center gap-1.5 px-2.5 py-1.5 bg-[var(--surface)] border-b border-[var(--border)]">
      {icon}
      <span className="flex-1 truncate font-mono text-[11px] text-[var(--accent)]">{path}</span>
      {children}
    </div>
  );
}

export function DiffStat({ kind, value }: { kind: 'del' | 'ins'; value: number }) {
  const isDel = kind === 'del';
  return (
    <span
      className="shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px] font-semibold"
      style={{
        backgroundColor: isDel ? DEL_PILL_BG : INS_PILL_BG,
        color: isDel ? 'var(--error)' : 'var(--success)',
      }}
    >
      {isDel ? '-' : '+'}{value}
    </span>
  );
}

export function ErrorBanner({ content, maxHeight = ERROR_MAX_HEIGHT }: { content: string; maxHeight?: number }) {
  return (
    <div
      className="border-t border-[var(--border)] px-3 py-1.5 text-[11px] whitespace-pre-wrap break-words"
      style={{ backgroundColor: ERROR_BANNER_BG, color: 'var(--error)', maxHeight, overflow: 'auto' }}
    >
      {content}
    </div>
  );
}

interface CodeBlockProps {
  code: string;
  fileName?: string;
  language?: string;
  maxHeight?: number;
}

export function CodeBlock({ code, fileName, language, maxHeight = DEFAULT_MAX_HEIGHT }: CodeBlockProps) {
  const resolvedLanguage = language ?? detectLanguage(fileName);
  const highlighter = useCodeHighlighter(Boolean(resolvedLanguage));
  const html = highlightToHtml(highlighter, code, resolvedLanguage);
  return (
    <div className="overflow-auto bg-[var(--bg)]" style={{ maxHeight }}>
      <pre className={`px-3 py-2 ${CODE_TEXT}`} style={{ color: 'var(--prose-body)' }}>
        {html
          ? <code dangerouslySetInnerHTML={{ __html: html }} />
          : <code>{code}</code>}
      </pre>
    </div>
  );
}

function DiffRow({ kind, num, code, language, highlighter }: {
  kind: 'del' | 'ins';
  num: number;
  code: string;
  language?: string;
  highlighter: CodeHighlighter | null;
}) {
  const isDel = kind === 'del';
  const html = highlightToHtml(highlighter, code, language);
  return (
    <tr style={{ backgroundColor: isDel ? DEL_ROW_BG : INS_ROW_BG }}>
      <td className={GUTTER_NUM} style={{ ...TIGHT_CELL, backgroundColor: isDel ? DEL_GUTTER_BG : INS_GUTTER_BG }}>
        {num}
      </td>
      <td
        className="select-none align-top text-center text-[11px] leading-[1.55]"
        style={{ ...TIGHT_CELL, color: isDel ? 'var(--error)' : 'var(--success)' }}
      >
        {isDel ? '-' : '+'}
      </td>
      <td className={`align-top pr-3 ${CODE_TEXT}`} style={{ color: 'var(--prose-body)' }}>
        {html
          ? <span dangerouslySetInnerHTML={{ __html: html }} />
          : (code || ' ')}
      </td>
    </tr>
  );
}

interface DiffBlockProps {
  oldString: string;
  newString: string;
  fileName?: string;
  maxHeight?: number;
}

export function DiffBlock({ oldString, newString, fileName, maxHeight = DEFAULT_MAX_HEIGHT }: DiffBlockProps) {
  const language = detectLanguage(fileName);
  const highlighter = useCodeHighlighter(Boolean(language));
  const oldLines = oldString ? oldString.split('\n') : [];
  const newLines = newString ? newString.split('\n') : [];
  return (
    <div className="overflow-auto bg-[var(--bg)]" style={{ maxHeight }}>
      <table className="w-full border-collapse">
        <tbody>
          {oldLines.map((line, i) => (
            <DiffRow
              key={`del-${i}`}
              code={line}
              highlighter={highlighter}
              kind="del"
              language={language}
              num={i + 1}
            />
          ))}
          {newLines.map((line, i) => (
            <DiffRow
              key={`ins-${i}`}
              code={line}
              highlighter={highlighter}
              kind="ins"
              language={language}
              num={i + 1}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function useCodeHighlighter(enabled: boolean): CodeHighlighter | null {
  const [highlighter, setHighlighter] = useState<CodeHighlighter | null>(null);

  useEffect(() => {
    if (!enabled) return;

    let active = true;
    void loadCodeHighlighter().then((loaded) => {
      if (active) setHighlighter(loaded);
    }).catch(() => {});
    return () => {
      active = false;
    };
  }, [enabled]);

  return highlighter;
}
