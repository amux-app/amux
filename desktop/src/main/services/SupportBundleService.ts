import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import type { MuxBasePane } from 'muxbase/core';
import type {
  AppInfoResult,
  SupportBundlePreview,
  SupportBundlePreviewFile,
  SupportBundleResult,
  SystemCheckResult,
} from '../../shared/ipc-types.js';
import { buildPathTokenizer, mergeHits, redactSecrets, stripAnsi } from './supportBundleRedaction.js';

const MAX_ROTATED_LOG_FILES = 3;
const MAX_LOG_FALLBACK_FILES = 8;
const MAX_TRANSCRIPT_FILES = 8;
const MAX_TRANSCRIPT_BYTES = 5 * 1024 * 1024;
const SUPPORT_LOG_FILE_PATTERN = /^muxbase-desktop-\d{4}-\d{2}-\d{2}\.log(?:\.\d+)?$/;
const METADATA_ENTRY_NAME = 'metadata/session.json';
const MANIFEST_ENTRY_NAME = 'redaction-manifest.json';
const README_ENTRY_NAME = 'README.txt';
const REDACTION_NOTE =
  'Best-effort automated redaction. REVIEW THIS ARCHIVE BEFORE SHARING — it may still contain sensitive paths, code, or secrets.';

interface SupportBundleOptions {
  appInfo: AppInfoResult;
  includeTranscripts: boolean;
  logDir?: string | null;
  logFile?: string | null;
  now?: Date;
  outputDir: string;
  panes: MuxBasePane[];
  projectName: string;
  projectRoot: string;
  sessionName: string;
  systemCheck?: SystemCheckResult | { error: string };
}

type Tokenizer = (text: string) => string;

interface BundleFileEntry {
  data: Buffer;
  mtime?: Date;
  name: string;
  sourcePath?: string;
}

interface SourceFile {
  entryName: string;
  maxBytes?: number;
  path: string;
}

/** Matches the file name produced below; callers use it to authorize a bundle path. */
export const SUPPORT_BUNDLE_FILE_PATTERN = /^muxbase-support-\d{4}-\d{2}-\d{2}-\d{6}\.zip$/;

export async function createSupportBundle(options: SupportBundleOptions): Promise<SupportBundleResult> {
  const now = options.now ?? new Date();
  const outputPath = join(options.outputDir, `muxbase-support-${formatTimestampForFile(now)}.zip`);
  mkdirSync(dirname(outputPath), { recursive: true });

  const tokenize = buildTokenizer(options);
  const manifestHits: Record<string, number> = {};
  const sourceFiles = collectSourceFiles(options);
  const metadataJson = JSON.stringify(buildMetadata(options, now, sourceFiles), null, 2);

  const entries: BundleFileEntry[] = [
    {
      data: Buffer.from(applyRedaction(metadataJson, tokenize, manifestHits), 'utf8'),
      mtime: now,
      name: METADATA_ENTRY_NAME,
    },
  ];
  const includedFiles: string[] = [];
  const usedEntryNames = new Set(entries.map((entry) => entry.name));

  for (const sourceFile of sourceFiles) {
    const loaded = readBundleFile(sourceFile);
    if (!loaded) continue;

    const content = prepareContent(loaded.data.toString('utf8'), sourceFile);
    entries.push({
      data: Buffer.from(applyRedaction(content, tokenize, manifestHits), 'utf8'),
      mtime: loaded.mtime,
      name: makeUniqueEntryName(sourceFile.entryName, usedEntryNames, loaded.tail),
      sourcePath: sourceFile.path,
    });
    includedFiles.push(sourceFile.path);
  }

  entries.push(
    { data: Buffer.from(buildManifest(options, now, manifestHits), 'utf8'), mtime: now, name: MANIFEST_ENTRY_NAME },
    { data: Buffer.from(`${REDACTION_NOTE}\n`, 'utf8'), mtime: now, name: README_ENTRY_NAME },
  );

  writeFileSync(outputPath, createStoreZip(entries));
  return { includedFiles, path: outputPath };
}

export function previewSupportBundle(options: SupportBundleOptions): SupportBundlePreview {
  const now = options.now ?? new Date();
  const sourceFiles = collectSourceFiles(options);
  const metadataBytes = Buffer.byteLength(JSON.stringify(buildMetadata(options, now, sourceFiles), null, 2), 'utf8');

  const files: SupportBundlePreviewFile[] = [
    { category: 'metadata', name: METADATA_ENTRY_NAME, sizeBytes: metadataBytes },
  ];
  for (const sourceFile of sourceFiles) {
    files.push({
      category: sourceFile.entryName.startsWith('terminal/') ? 'transcript' : 'log',
      name: sourceFile.entryName,
      sizeBytes: previewSize(sourceFile),
    });
  }

  return {
    files,
    includeTranscripts: options.includeTranscripts,
    redactionNote: REDACTION_NOTE,
    totalBytes: files.reduce((sum, file) => sum + file.sizeBytes, 0),
  };
}

function collectSourceFiles(options: SupportBundleOptions): SourceFile[] {
  const logFiles = collectLogFiles(options.logDir, options.logFile);
  if (!options.includeTranscripts) return logFiles;
  return [...logFiles, ...collectTranscriptFiles(options.logDir, options.panes)];
}

function buildTokenizer(options: SupportBundleOptions): Tokenizer {
  const worktrees = options.panes
    .filter((pane): pane is MuxBasePane & { worktreePath: string } => Boolean(pane.worktreePath))
    .map((pane) => ({ path: pane.worktreePath, slug: pane.slug }));
  return buildPathTokenizer({ homeDir: homedir(), projectRoot: options.projectRoot, worktrees });
}

const TRANSCRIPT_ENTRY_PREFIX = 'terminal/';

function isTranscriptEntry(sourceFile: SourceFile): boolean {
  return sourceFile.entryName.startsWith(TRANSCRIPT_ENTRY_PREFIX);
}

function prepareContent(text: string, sourceFile: SourceFile): string {
  return isTranscriptEntry(sourceFile) ? stripAnsi(text) : text;
}

function applyRedaction(text: string, tokenize: Tokenizer, manifestHits: Record<string, number>): string {
  const { text: redacted, hits } = redactSecrets(tokenize(text));
  mergeHits(manifestHits, hits);
  return redacted;
}

function buildManifest(options: SupportBundleOptions, now: Date, redactionHitsByKind: Record<string, number>): string {
  const worktreeCount = options.panes.filter((pane) => Boolean(pane.worktreePath)).length;
  return JSON.stringify(
    {
      generatedAt: now.toISOString(),
      note: REDACTION_NOTE,
      redactionHitsByKind,
      tokenizedPrefixes: { home: '<HOME>', project: '<PROJECT>', worktrees: worktreeCount },
    },
    null,
    2,
  );
}

function previewSize(sourceFile: SourceFile): number {
  try {
    const size = statSync(sourceFile.path).size;
    return sourceFile.maxBytes ? Math.min(size, sourceFile.maxBytes) : size;
  } catch {
    return 0;
  }
}

function buildMetadata(
  options: SupportBundleOptions,
  now: Date,
  sourceFiles: SourceFile[],
): Record<string, unknown> {
  return {
    app: options.appInfo,
    generatedAt: now.toISOString(),
    includedFileCount: sourceFiles.length,
    panes: options.panes.map((pane) => ({
      agent: pane.agent,
      // Support bundles preserve the legacy diagnostic value when present; it is evidence only,
      // never a live activity source for application behavior.
      agentStatus: pane.agentStatus,
      id: pane.id,
      paneId: pane.paneId,
      slug: pane.slug,
      terminalTranscriptPath: pane.terminalTranscriptPath,
      title: pane.title,
      type: pane.type,
      worktreePath: pane.worktreePath,
    })),
    projectName: options.projectName,
    projectRoot: options.projectRoot,
    sessionName: options.sessionName,
    systemCheck: options.systemCheck,
  };
}

function collectLogFiles(logDir: string | null | undefined, logFile: string | null | undefined): SourceFile[] {
  const paths = new Set<string>();
  if (logFile) {
    paths.add(logFile);
    for (let index = 1; index <= MAX_ROTATED_LOG_FILES; index += 1) {
      paths.add(`${logFile}.${index}`);
    }
  } else if (logDir && existsSync(logDir)) {
    for (const fileName of newestFiles(logDir, SUPPORT_LOG_FILE_PATTERN, MAX_LOG_FALLBACK_FILES)) {
      paths.add(join(logDir, fileName));
    }
  }

  return [...paths]
    .filter(isReadableFile)
    .map((path) => ({
      entryName: `logs/${basename(path)}`,
      path,
    }));
}

function collectTranscriptFiles(logDir: string | null | undefined, panes: MuxBasePane[]): SourceFile[] {
  const paths = new Set<string>();
  for (const pane of panes) {
    if (pane.terminalTranscriptPath) paths.add(pane.terminalTranscriptPath);
  }

  const terminalDir = logDir ? join(logDir, 'terminal') : null;
  if (terminalDir && existsSync(terminalDir)) {
    for (const fileName of newestFiles(terminalDir, /\.ansi$/, MAX_TRANSCRIPT_FILES)) {
      paths.add(join(terminalDir, fileName));
    }
  }

  return [...paths]
    .filter(isReadableFile)
    .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs)
    .slice(0, MAX_TRANSCRIPT_FILES)
    .map((path) => ({
      entryName: `terminal/${basename(path)}`,
      maxBytes: MAX_TRANSCRIPT_BYTES,
      path,
    }));
}

function newestFiles(dir: string, pattern: RegExp, limit: number): string[] {
  try {
    return readdirSync(dir)
      .filter((fileName) => pattern.test(fileName))
      .map((fileName) => ({ fileName, mtimeMs: statSync(join(dir, fileName)).mtimeMs }))
      .sort((left, right) => right.mtimeMs - left.mtimeMs)
      .slice(0, limit)
      .map(({ fileName }) => fileName);
  } catch {
    return [];
  }
}

function isReadableFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function readBundleFile(sourceFile: SourceFile): { data: Buffer; mtime: Date; tail: boolean } | null {
  try {
    const stat = statSync(sourceFile.path);
    if (!sourceFile.maxBytes || stat.size <= sourceFile.maxBytes) {
      return { data: readFileSync(sourceFile.path), mtime: stat.mtime, tail: false };
    }

    const fd = openSync(sourceFile.path, 'r');
    try {
      const size = sourceFile.maxBytes;
      const buffer = Buffer.allocUnsafe(size);
      readSync(fd, buffer, 0, size, stat.size - size);
      return { data: buffer, mtime: stat.mtime, tail: true };
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
}

function makeUniqueEntryName(entryName: string, usedEntryNames: Set<string>, tail: boolean): string {
  const normalized = normalizeZipEntryName(tail ? `${entryName}.tail` : entryName);
  let candidate = normalized;
  let suffix = 2;
  while (usedEntryNames.has(candidate)) {
    candidate = normalized.replace(/(\.[^/.]+)?$/, `-${suffix}$1`);
    suffix += 1;
  }
  usedEntryNames.add(candidate);
  return candidate;
}

function formatTimestampForFile(date: Date): string {
  const iso = date.toISOString();
  return `${iso.slice(0, 10)}-${iso.slice(11, 19).replace(/:/g, '')}`;
}

function createStoreZip(entries: BundleFileEntry[]): Buffer {
  const fileParts: Buffer[] = [];
  const centralDirectoryParts: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(normalizeZipEntryName(entry.name), 'utf8');
    const data = entry.data;
    const crc = crc32(data);
    const { dosDate, dosTime } = toDosDateTime(entry.mtime ?? new Date());
    const localHeader = Buffer.alloc(30);

    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0, 6);
    localHeader.writeUInt16LE(0, 8);
    localHeader.writeUInt16LE(dosTime, 10);
    localHeader.writeUInt16LE(dosDate, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(data.length, 18);
    localHeader.writeUInt32LE(data.length, 22);
    localHeader.writeUInt16LE(name.length, 26);
    localHeader.writeUInt16LE(0, 28);

    fileParts.push(localHeader, name, data);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt16LE(dosTime, 12);
    centralHeader.writeUInt16LE(dosDate, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(data.length, 20);
    centralHeader.writeUInt32LE(data.length, 24);
    centralHeader.writeUInt16LE(name.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);
    centralDirectoryParts.push(centralHeader, name);

    offset += localHeader.length + name.length + data.length;
  }

  const centralDirectory = Buffer.concat(centralDirectoryParts);
  const endRecord = Buffer.alloc(22);
  endRecord.writeUInt32LE(0x06054b50, 0);
  endRecord.writeUInt16LE(0, 4);
  endRecord.writeUInt16LE(0, 6);
  endRecord.writeUInt16LE(entries.length, 8);
  endRecord.writeUInt16LE(entries.length, 10);
  endRecord.writeUInt32LE(centralDirectory.length, 12);
  endRecord.writeUInt32LE(offset, 16);
  endRecord.writeUInt16LE(0, 20);

  return Buffer.concat([...fileParts, centralDirectory, endRecord]);
}

function normalizeZipEntryName(name: string): string {
  return name
    .replace(/\\/g, '/')
    .split('/')
    .filter((part) => part && part !== '.' && part !== '..')
    .join('/');
}

function toDosDateTime(date: Date): { dosDate: number; dosTime: number } {
  const year = Math.max(1980, date.getFullYear());
  return {
    dosDate: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
    dosTime: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
  };
}

let crcTable: Uint32Array | null = null;

function crc32(data: Buffer): number {
  const table = getCrcTable();
  let crc = 0xffffffff;
  for (const byte of data) {
    crc = (crc >>> 8) ^ table[(crc ^ byte) & 0xff];
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function getCrcTable(): Uint32Array {
  if (crcTable) return crcTable;

  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  crcTable = table;
  return table;
}
