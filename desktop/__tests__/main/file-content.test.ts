import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  decodeFileContent,
  encodeFileContent,
} from '../../src/main/services/fileContent';

function sha256(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

describe('file content fidelity', () => {
  it.each([
    ['lf', 'alpha\nbeta\n'],
    ['crlf', 'alpha\r\nbeta\r\n'],
    ['cr', 'alpha\rbeta\r'],
  ] as const)('round-trips uniform %s files byte-for-byte', (eol, content) => {
    const bytes = Buffer.from(content, 'utf8');

    const decoded = decodeFileContent(bytes, bytes.length, false);

    expect(decoded).toEqual({
      kind: 'editable-text',
      content,
      contentVersion: sha256(bytes),
      encoding: 'utf8',
      eol,
      hasBom: false,
    });
    if (decoded.kind !== 'editable-text') throw new Error('Expected editable text');
    expect(encodeFileContent(decoded.content, decoded.hasBom, decoded.eol)).toEqual(bytes);
  });

  it('preserves a UTF-8 BOM while keeping it out of the editor document', () => {
    const bytes = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from('export const value = 1;\r\n', 'utf8'),
    ]);

    const decoded = decodeFileContent(bytes, bytes.length, false);

    expect(decoded).toMatchObject({
      kind: 'editable-text',
      content: 'export const value = 1;\r\n',
      contentVersion: sha256(bytes),
      eol: 'crlf',
      hasBom: true,
    });
    if (decoded.kind !== 'editable-text') throw new Error('Expected editable text');
    expect(encodeFileContent(decoded.content, decoded.hasBom, decoded.eol)).toEqual(bytes);
  });

  it.each(['', 'no trailing newline'])('defaults %j to LF', (content) => {
    const bytes = Buffer.from(content, 'utf8');

    expect(decodeFileContent(bytes, bytes.length, false)).toMatchObject({
      kind: 'editable-text',
      eol: 'lf',
    });
  });

  it('makes mixed line endings read-only instead of normalizing them', () => {
    const bytes = Buffer.from('alpha\r\nbeta\ngamma\r', 'utf8');

    expect(decodeFileContent(bytes, bytes.length, false)).toEqual({
      kind: 'readonly-text',
      content: 'alpha\r\nbeta\ngamma\r',
      encoding: 'utf8',
      hasBom: false,
      reason: 'mixed-eol',
      sizeBytes: bytes.length,
    });
  });

  it('returns a valid UTF-8 read-only prefix when truncation cuts a multibyte character', () => {
    const complete = Buffer.from('hello €', 'utf8');
    const partial = complete.subarray(0, complete.length - 1);

    expect(decodeFileContent(partial, complete.length, true)).toEqual({
      kind: 'readonly-text',
      content: 'hello ',
      encoding: 'utf8',
      hasBom: false,
      reason: 'truncated',
      sizeBytes: complete.length,
    });
  });

  it('classifies any NUL byte as binary', () => {
    const bytes = Buffer.from([0x61, 0x00, 0x62]);

    expect(decodeFileContent(bytes, bytes.length, false)).toEqual({
      kind: 'unsupported',
      reason: 'binary',
      sizeBytes: bytes.length,
    });
  });

  it('classifies invalid UTF-8 without replacement characters', () => {
    const bytes = Buffer.from([0x61, 0xc3, 0x28]);

    expect(decodeFileContent(bytes, bytes.length, false)).toEqual({
      kind: 'unsupported',
      reason: 'invalid-utf8',
      sizeBytes: bytes.length,
    });
  });

  it('rejects content whose line endings violate the editor session contract', () => {
    expect(() => encodeFileContent('alpha\nbeta', false, 'crlf'))
      .toThrow('Document line endings do not match crlf');
  });
});
