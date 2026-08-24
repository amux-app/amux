import { createHash } from 'node:crypto';
import type { FileEol, FileReadResponse } from '../../shared/ipc-types.js';

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });

export function hashFileContent(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function decodeUtf8(bytes: Uint8Array, allowTruncatedTail: boolean): string | null {
  const maxTrimmedBytes = allowTruncatedTail ? Math.min(3, bytes.length) : 0;
  for (let trimmedBytes = 0; trimmedBytes <= maxTrimmedBytes; trimmedBytes += 1) {
    try {
      return UTF8_DECODER.decode(bytes.subarray(0, bytes.length - trimmedBytes));
    } catch {
      // A truncated UTF-8 code point can occupy at most four bytes. Only trim
      // the incomplete tail; malformed bytes elsewhere remain unsupported.
    }
  }
  return null;
}

function detectEol(content: string): FileEol | 'mixed' {
  let sawCr = false;
  let sawCrLf = false;
  let sawLf = false;

  for (let index = 0; index < content.length; index += 1) {
    const character = content.charCodeAt(index);
    if (character === 0x0d) {
      if (content.charCodeAt(index + 1) === 0x0a) {
        sawCrLf = true;
        index += 1;
      } else {
        sawCr = true;
      }
    } else if (character === 0x0a) {
      sawLf = true;
    }
  }

  const kinds = Number(sawCr) + Number(sawCrLf) + Number(sawLf);
  if (kinds > 1) return 'mixed';
  if (sawCrLf) return 'crlf';
  if (sawCr) return 'cr';
  return 'lf';
}

export function decodeFileContent(
  bytesRead: Buffer,
  sizeBytes: number,
  truncated: boolean,
): FileReadResponse {
  if (bytesRead.includes(0)) {
    return { kind: 'unsupported', reason: 'binary', sizeBytes };
  }

  const hasBom = bytesRead.subarray(0, UTF8_BOM.length).equals(UTF8_BOM);
  const contentBytes = hasBom ? bytesRead.subarray(UTF8_BOM.length) : bytesRead;
  const content = decodeUtf8(contentBytes, truncated);
  if (content === null) {
    return { kind: 'unsupported', reason: 'invalid-utf8', sizeBytes };
  }

  if (truncated) {
    return {
      kind: 'readonly-text',
      reason: 'truncated',
      content,
      encoding: 'utf8',
      hasBom,
      sizeBytes,
    };
  }

  const eol = detectEol(content);
  if (eol === 'mixed') {
    return {
      kind: 'readonly-text',
      reason: 'mixed-eol',
      content,
      encoding: 'utf8',
      hasBom,
      sizeBytes,
    };
  }

  return {
    kind: 'editable-text',
    content,
    contentVersion: hashFileContent(bytesRead),
    encoding: 'utf8',
    hasBom,
    eol,
  };
}

function hasMismatchedLineEndings(content: string, eol: FileEol): boolean {
  switch (eol) {
    case 'lf':
      return content.includes('\r');
    case 'cr':
      return content.includes('\n');
    case 'crlf':
      return content.replaceAll('\r\n', '').includes('\r')
        || content.replaceAll('\r\n', '').includes('\n');
  }
}

export function encodeFileContent(content: string, hasBom: boolean, eol: FileEol): Buffer {
  if (hasMismatchedLineEndings(content, eol)) {
    throw new Error(`Document line endings do not match ${eol}`);
  }

  const contentBytes = Buffer.from(content, 'utf8');
  return hasBom ? Buffer.concat([UTF8_BOM, contentBytes]) : contentBytes;
}
