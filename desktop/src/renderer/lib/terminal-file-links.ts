import type { IBufferLine, ILink, ILinkProvider, Terminal } from '@xterm/xterm';

export interface TerminalFileLinkTarget {
  lineNumber: number;
  relativePath: string;
}

export interface TerminalFileLinkMatch extends TerminalFileLinkTarget {
  startIndex: number;
  text: string;
}

interface TerminalFileLinkProviderOptions {
  onOpen: (target: TerminalFileLinkTarget, event: MouseEvent) => void;
  rootPath: string;
  terminal: Pick<Terminal, 'buffer'>;
}

const FILE_REF_PATTERN = /(^|[\s([{"'`|<])((?:(?:\.{1,2}\/|\/)?(?:[A-Za-z0-9_@.+-]+\/)+[A-Za-z0-9_@.+-]+)|(?:[A-Za-z0-9_@.+-]+\.[A-Za-z][A-Za-z0-9_+-]*)):([1-9]\d{0,6})(?::\d{1,6})?(?=$|[\s)\]}"'`,;.!?|>])/g;

export function findTerminalFileLinks(line: string, rootPath: string): TerminalFileLinkMatch[] {
  const matches: TerminalFileLinkMatch[] = [];
  FILE_REF_PATTERN.lastIndex = 0;

  let match: RegExpExecArray | null;
  while ((match = FILE_REF_PATTERN.exec(line)) !== null) {
    const [, prefix, rawPath, rawLine] = match;
    if (!rawPath || !rawLine) continue;

    const relativePath = toWorkspaceRelativePath(rawPath, rootPath);
    if (!relativePath) continue;

    const lineNumber = Number.parseInt(rawLine, 10);
    if (!Number.isSafeInteger(lineNumber) || lineNumber < 1) continue;

    const text = match[0].slice(prefix.length);
    matches.push({
      lineNumber,
      relativePath,
      startIndex: match.index + prefix.length,
      text,
    });
  }

  return matches;
}

export function createTerminalFileLinkProvider({
  onOpen,
  rootPath,
  terminal,
}: TerminalFileLinkProviderOptions): ILinkProvider {
  return {
    provideLinks(bufferLineNumber, callback) {
      const bufferLine = terminal.buffer.active.getLine(bufferLineNumber - 1);
      const line = bufferLine?.translateToString(true);
      if (!bufferLine || !line) {
        callback(undefined);
        return;
      }

      const links = findTerminalFileLinks(line, rootPath).map<ILink>((match) => ({
        activate: (event) => onOpen(match, event),
        range: toBufferRange(bufferLine, match, bufferLineNumber),
        text: match.text,
      }));
      callback(links.length > 0 ? links : undefined);
    },
  };
}

function toBufferRange(
  bufferLine: IBufferLine,
  match: TerminalFileLinkMatch,
  bufferLineNumber: number,
): ILink['range'] {
  const startCell = stringIndexToBufferCell(bufferLine, match.startIndex);
  const endCell = stringIndexToBufferCell(bufferLine, match.startIndex + match.text.length - 1);
  return {
    start: { x: startCell + 1, y: bufferLineNumber },
    end: { x: endCell + 1, y: bufferLineNumber },
  };
}

function stringIndexToBufferCell(bufferLine: IBufferLine, stringIndex: number): number {
  let stringOffset = 0;

  for (let cellIndex = 0; cellIndex < bufferLine.length; cellIndex += 1) {
    const chars = bufferLine.getCell(cellIndex)?.getChars() ?? '';
    if (!chars) continue;
    if (stringOffset >= stringIndex) return cellIndex;
    const nextOffset = stringOffset + chars.length;
    if (stringIndex < nextOffset) return cellIndex;
    stringOffset = nextOffset;
  }

  return stringIndex;
}

function toWorkspaceRelativePath(rawPath: string, rootPath: string): string | null {
  const normalizedRoot = normalizeTerminalRootPath(rootPath);
  if (!normalizedRoot) return null;

  let relativePath: string;
  if (rawPath.startsWith('/')) {
    if (normalizedRoot === '/') {
      relativePath = rawPath.slice(1);
    } else if (rawPath.startsWith(`${normalizedRoot}/`)) {
      relativePath = rawPath.slice(normalizedRoot.length + 1);
    } else {
      return null;
    }
  } else {
    relativePath = rawPath;
    while (relativePath.startsWith('./')) {
      relativePath = relativePath.slice(2);
    }
  }

  if (!relativePath) return null;
  const parts = relativePath.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..')) return null;
  return parts.join('/');
}

function normalizeTerminalRootPath(rootPath: string): string | null {
  const trimmed = rootPath.trim();
  if (!trimmed) return null;
  const withoutTrailingSlash = trimmed.replace(/\/+$/g, '');
  return withoutTrailingSlash || '/';
}
