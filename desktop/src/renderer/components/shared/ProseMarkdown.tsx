import 'github-markdown-css/github-markdown.css';
import { posix } from 'path-browserify';
import { type ComponentPropsWithoutRef, useEffect, useMemo, useState } from 'react';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import type { UrlTransform } from 'react-markdown';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import remarkGfm from 'remark-gfm';
import { readFileBinary } from '../../api/file.api';
import { openExternal } from '../../api/system.api';
import { normalizeMarkdownForTables } from '../../lib/markdown-table-normalize';
import './ProseMarkdown.css';

const REMARK_PLUGINS = [remarkGfm];
const RAW_HTML_ATTRIBUTE_BLOCKLIST = new Set(['class', 'className', 'style']);

function withoutBlockedRawHtmlAttributes(attributes: readonly unknown[] | undefined): unknown[] {
  return (attributes ?? []).filter((attribute) => (
    typeof attribute !== 'string' || !RAW_HTML_ATTRIBUTE_BLOCKLIST.has(attribute)
  ));
}

const SANITIZE_SCHEMA = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    '*': withoutBlockedRawHtmlAttributes(defaultSchema.attributes?.['*']),
    img: [...withoutBlockedRawHtmlAttributes(defaultSchema.attributes?.img), 'align', 'width', 'height'],
    a: [...withoutBlockedRawHtmlAttributes(defaultSchema.attributes?.a), 'target', 'rel'],
  },
  tagNames: [...(defaultSchema.tagNames ?? []), 'picture', 'source', 'details', 'summary'],
};

const RELATIVE_URL_PATTERN = /!\[[^\]]*\]\(([^)\s]+)\)|<img[^>]+src=["']([^"']+)["']/g;

function isAbsoluteUrl(value: string): boolean {
  return /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(value);
}

function resolveRelative(baseDir: string, value: string): string {
  return posix.normalize(posix.join(baseDir, value));
}

function extractRelativeImageUrls(markdown: string, baseDir: string): string[] {
  const out = new Set<string>();
  for (const match of markdown.matchAll(RELATIVE_URL_PATTERN)) {
    const url = match[1] ?? match[2];
    if (url && !isAbsoluteUrl(url)) out.add(resolveRelative(baseDir, url));
  }
  return Array.from(out);
}

function isImageOnlyChild(child: React.ReactNode): boolean {
  if (typeof child === 'string') return child.trim() === '';
  if (!child || typeof child !== 'object') return false;
  const el = child as React.ReactElement;
  if (el.type === 'img') return true;
  if (el.type === 'a') {
    const kids = (el.props as { children?: React.ReactNode }).children;
    const arr = Array.isArray(kids) ? kids : [kids];
    return arr.every(isImageOnlyChild);
  }
  return false;
}

function isImageOnlyParagraph(children: React.ReactNode): boolean {
  const arr = Array.isArray(children) ? children : [children];
  return arr.length > 0 && arr.every(isImageOnlyChild);
}

interface ProseMarkdownProps {
  content: string;
  rootPath?: string;
  relativePath?: string;
  variant?: 'document' | 'chat';
}

function ResponsiveMarkdownTable({
  children,
  node: _node,
  ...rest
}: ComponentPropsWithoutRef<'table'> & { node?: unknown }) {
  return (
    <div
      aria-label="Scrollable markdown table"
      className="prose-markdown-table-scroll"
      role="region"
      tabIndex={0}
    >
      <table
        {...rest}
        className={[
          'prose-markdown-responsive-table',
          rest.className,
        ].filter(Boolean).join(' ')}
      >
        {children}
      </table>
    </div>
  );
}

export function ProseMarkdown({ content, rootPath, relativePath, variant = 'chat' }: ProseMarkdownProps) {
  const [highlightPlugin, setHighlightPlugin] = useState<
    typeof import('rehype-highlight')['default'] | null
  >(null);
  const normalized = useMemo(() => normalizeMarkdownForTables(content), [content]);
  const containsFencedCode = useMemo(
    () => /(?:^|\n)\s*(?:```|~~~)/.test(normalized),
    [normalized],
  );
  const baseDir = useMemo(() => (relativePath ? posix.dirname(relativePath) : '.'), [relativePath]);
  const [imageMap, setImageMap] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!containsFencedCode || highlightPlugin) return;

    let active = true;
    void import('rehype-highlight').then((module) => {
      if (active) setHighlightPlugin(() => module.default);
    }).catch(() => {});
    return () => {
      active = false;
    };
  }, [containsFencedCode, highlightPlugin]);

  useEffect(() => {
    if (!rootPath) {
      setImageMap({});
      return;
    }
    const relatives = extractRelativeImageUrls(normalized, baseDir);
    if (relatives.length === 0) {
      setImageMap({});
      return;
    }
    let cancelled = false;
    void Promise.all(
      relatives.map(async (rel) => {
        const res = await readFileBinary({ rootPath, relativePath: rel });
        if (res.error || !res.data) return null;
        return [rel, `data:${res.mimeType};base64,${res.data}`] as const;
      }),
    ).then((pairs) => {
      if (cancelled) return;
      const next: Record<string, string> = {};
      for (const p of pairs) if (p) next[p[0]] = p[1];
      setImageMap(next);
    });
    return () => {
      cancelled = true;
    };
  }, [baseDir, normalized, rootPath]);

  const rehypePlugins = useMemo(() => (
    highlightPlugin
      ? [rehypeRaw, [rehypeSanitize, SANITIZE_SCHEMA], highlightPlugin]
      : [rehypeRaw, [rehypeSanitize, SANITIZE_SCHEMA]]
  ), [highlightPlugin]);

  const urlTransform: UrlTransform = (url) => {
    if (isAbsoluteUrl(url)) return defaultUrlTransform(url);
    const resolved = resolveRelative(baseDir, url);
    return imageMap[resolved] ?? defaultUrlTransform(url);
  };

  return (
    <article
      className={`markdown-body prose-markdown${variant === 'chat' ? ' prose-markdown-chat' : ''}`}
    >
      <ReactMarkdown
        remarkPlugins={REMARK_PLUGINS}
        rehypePlugins={rehypePlugins as never}
        urlTransform={urlTransform}
        components={{
          a: ({ href, children, ...rest }) => (
            <a
              {...rest}
              href={href}
              onClick={(event) => {
                if (!href || href.startsWith('#')) return;
                event.preventDefault();
                void openExternal(href);
              }}
            >
              {children}
            </a>
          ),
          p: ({ children, node: _node, ...rest }) => {
            if (isImageOnlyParagraph(children)) {
              return <p {...rest} className="prose-markdown-badge-row">{children}</p>;
            }
            return <p {...rest}>{children}</p>;
          },
          table: ResponsiveMarkdownTable,
        }}
      >
        {normalized}
      </ReactMarkdown>
    </article>
  );
}
