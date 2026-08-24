import { describe, expect, it } from 'vitest';
import { escapeRegex } from '../../src/renderer/lib/dom-find';

// happy-dom is configured by individual tests that need DOM; the pure
// `escapeRegex` tests below run in node. The findMatches tests need a DOM.

describe('escapeRegex', () => {
  it('escapes regex special characters so they match literally', () => {
    const dangerous = '.*+?^${}()|[]\\';
    const re = new RegExp(escapeRegex(dangerous), 'g');
    expect(re.test(dangerous)).toBe(true);
  });

  it('leaves plain alphanumerics untouched', () => {
    expect(escapeRegex('hello world 42')).toBe('hello world 42');
  });

  it('escapes a search-killing dot so .* does not greedily match anything', () => {
    expect(escapeRegex('a.b')).toBe('a\\.b');
    const re = new RegExp(escapeRegex('a.b'));
    expect(re.test('axb')).toBe(false);
    expect(re.test('a.b')).toBe(true);
  });
});
