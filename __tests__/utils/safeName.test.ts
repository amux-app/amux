import { describe, expect, it } from 'vitest';

import { normalizeAsciiName } from '../../src/utils/safeName.js';

describe('normalizeAsciiName', () => {
  it('normalizes arbitrary input in one pass without changing slug semantics', () => {
    expect(normalizeAsciiName("  Don't --- break/a/b  ")).toBe('don-t-break-a-b');
  });

  it('can preserve explicitly allowed filename punctuation', () => {
    expect(normalizeAsciiName(' Feature_Name.v2 ', { allowedPunctuation: '._' }))
      .toBe('feature_name.v2');
  });

  it('honors the output limit without leaving a separator at the edge', () => {
    expect(normalizeAsciiName('abcdefghij---tail', { maxLength: 11 })).toBe('abcdefghij');
  });

  it('handles large hostile separator runs with bounded output', () => {
    const input = `${'!'.repeat(100_000)}safe${'-'.repeat(100_000)}name`;
    expect(normalizeAsciiName(input, { maxLength: 64 })).toBe('safe-name');
  });
});
