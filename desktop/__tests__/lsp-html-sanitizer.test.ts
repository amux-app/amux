// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';
import { sanitizeLspHtml } from '../src/renderer/components/file-browser/lspHtmlSanitizer';

describe('sanitizeLspHtml', () => {
  it('preserves safe language-server formatting', () => {
    expect(sanitizeLspHtml('<p><strong>Type:</strong> <code>string</code></p>')).toBe(
      '<p><strong>Type:</strong> <code>string</code></p>',
    );
  });

  it('removes executable HTML from untrusted language-server output', () => {
    const sanitized = sanitizeLspHtml(
      '<script>window.pwned = true</script>'
      + '<img src="x" onerror="window.pwned = true">'
      + '<a href="javascript:window.pwned = true">unsafe</a>',
    );

    expect(sanitized).not.toMatch(/script|onerror|javascript:/i);
    expect(sanitized).toContain('<img src="x">');
    expect(sanitized).toContain('<a>unsafe</a>');
  });

  it('removes SVG-based script vectors', () => {
    const sanitized = sanitizeLspHtml(
      '<svg><a xlink:href="javascript:alert(1)"><text>unsafe</text></a></svg>',
    );

    expect(sanitized).not.toMatch(/javascript:|xlink:href/i);
  });
});
