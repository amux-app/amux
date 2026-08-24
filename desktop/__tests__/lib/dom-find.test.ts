// @vitest-environment happy-dom
import { describe, expect, it, beforeEach } from 'vitest';
import { findMatches, scrollRangeIntoView } from '../../src/renderer/lib/dom-find';

function setBody(html: string): HTMLElement {
  document.body.innerHTML = `<div id="root">${html}</div>`;
  return document.getElementById('root') as HTMLElement;
}

describe('findMatches', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('returns no matches for an empty query', () => {
    const root = setBody('<p>hello world</p>');
    expect(findMatches(root, '', false)).toEqual([]);
  });

  it('finds a single substring match in plain text', () => {
    const root = setBody('<p>hello world</p>');
    const ranges = findMatches(root, 'world', false);
    expect(ranges).toHaveLength(1);
    expect(ranges[0].toString()).toBe('world');
  });

  it('finds multiple matches inside the same text node', () => {
    const root = setBody('<p>foo bar foo baz foo</p>');
    const ranges = findMatches(root, 'foo', false);
    expect(ranges).toHaveLength(3);
    for (const r of ranges) expect(r.toString()).toBe('foo');
  });

  it('walks across nested elements and reports document-order ranges', () => {
    const root = setBody('<p>alpha <em>beta</em> gamma <strong>beta</strong></p>');
    const ranges = findMatches(root, 'beta', false);
    expect(ranges).toHaveLength(2);
  });

  it('respects case sensitivity when enabled', () => {
    const root = setBody('<p>Foo foo FOO</p>');
    expect(findMatches(root, 'foo', false)).toHaveLength(3);
    expect(findMatches(root, 'foo', true)).toHaveLength(1);
  });

  it('skips text inside <script>, <style>, and data-find-skip subtrees', () => {
    const root = setBody(
      '<p>visible</p>' +
        '<script>visible should not match here</script>' +
        '<style>visible {}</style>' +
        '<div data-find-skip="true">visible inside skip zone</div>',
    );
    const ranges = findMatches(root, 'visible', false);
    expect(ranges).toHaveLength(1);
  });

  it('does not match across text-node boundaries (matches Chrome find behaviour)', () => {
    // "hello" split across <em> boundaries should not be found as a single match.
    const root = setBody('<p>he<em>l</em>lo</p>');
    const ranges = findMatches(root, 'hello', false);
    expect(ranges).toHaveLength(0);
  });

  it('escapes regex special characters in the query', () => {
    const root = setBody('<p>a.b a.b axb</p>');
    const ranges = findMatches(root, 'a.b', false);
    expect(ranges).toHaveLength(2);
    for (const r of ranges) expect(r.toString()).toBe('a.b');
  });
});

describe('scrollRangeIntoView', () => {
  it('does not throw when the range is already visible', () => {
    const root = setBody('<p style="height: 200px">hello world</p>');
    Object.defineProperty(root, 'scrollBy', { value: () => undefined, configurable: true });
    const ranges = findMatches(root, 'hello', false);
    expect(() => scrollRangeIntoView(ranges[0], root)).not.toThrow();
  });
});
