import { describe, expect, it } from 'vitest';

import {
  condenseTitleLocally,
  normalizeAutomaticPaneTitle,
} from '../src/utils/paneDisplayTitle.js';

describe('condenseTitleLocally', () => {
  const cases: Array<[input: string, expected: string]> = [
    ['Please fix the authentication timeout', 'Fix the authentication timeout'],
    ['Can you review the payment retry logic?', 'Review the payment retry logic'],
    ['Please, can you update the deployment guide?', 'Update the deployment guide'],
    ['Check auth flow', 'Check auth flow'],
    ['Export to reports', 'Export to reports'],
    ['Make sure cache invalidation works', 'Ensure cache invalidation works'],
    ['See the following plan, implement pagination', 'Implement pagination'],
    ['See the following code and add tests', 'Add tests'],
    ['Look at the following feedback, investigate retries', 'Investigate retries'],
    ['We need to add OAuth support', 'Add OAuth support'],
    ['I need to debug the memory leak in workerPool', 'Debug the memory leak in workerPool'],
    ['I want to refactor parse_session_data', 'Refactor parse_session_data'],
    ['Fix AUTH-142 in auth-middleware.ts', 'Fix AUTH-142 in auth-middleware.ts'],
    ['Review export to reports for enterprise users', 'Review export to reports for enterprise users'],
    ['Investigate the slow query in reports', 'Investigate the slow query in reports'],
    ['实现登录超时修复', '实现登录超时修复'],
    ['إصلاح مهلة تسجيل الدخول', 'إصلاح مهلة تسجيل الدخول'],
    ['/goal please implement pane titles', 'Implement pane titles'],
    ['<system-reminder>internal context</system-reminder> Fix login', 'Fix login'],
    ['```md\nPlease update README.md\n```', 'Update README.md'],
    ['fix it, then run the whole integration suite for me', 'Fix it, then run the whole integration suite'],
    ['add a retry to the upload path. it keeps failing on slow links', 'Add a retry to the upload path'],
    ['', ''],
    ['   ---   ', ''],
  ];

  it.each(cases)('condenses %j to %j', (input, expected) => {
    expect(condenseTitleLocally(input)).toBe(expected);
  });

  it('does not strip wrapper-shaped prefixes inside real words', () => {
    expect(condenseTitleLocally('Pleased users can export reports')).toBe('Pleased users can export reports');
  });

  it('preserves joined emoji and combining marks at the display limit', () => {
    const family = '👨‍👩‍👧‍👦';
    const combining = 'e\u0301';
    const title = condenseTitleLocally(`${family.repeat(30)}${combining.repeat(30)}`);

    expect(title).not.toContain('\uFFFD');
    expect(title.endsWith('\u200D')).toBe(false);
    expect(title.endsWith('\u0301')).toBe(true);
    expect([...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(title)]).toHaveLength(48);
  });
});

describe('normalizeAutomaticPaneTitle', () => {
  it('removes controls and collapses all lines into one line', () => {
    expect(normalizeAutomaticPaneTitle('  Fix\u0000 auth\r\n  retry\tlogic  ')).toBe('Fix auth retry logic');
  });

  it('removes bidi controls without breaking joined emoji', () => {
    expect(normalizeAutomaticPaneTitle('Fix \u202Eauth 👨‍👩‍👧‍👦')).toBe('Fix auth 👨‍👩‍👧‍👦');
  });

  it('strips surrounding quotes and known provider decoration', () => {
    expect(normalizeAutomaticPaneTitle('  ✳ "Fix terminal scrollback." ✳  ')).toBe('Fix terminal scrollback');
  });

  it.each([
    'Untitled',
    'Title',
    'New session',
    'New session - 2026-08-03T10:15:00.000Z',
    'Child session - 2026-08-03T10:15:00.000Z',
    'Generating title...',
    'Loading...',
  ])('rejects placeholder %j', (placeholder) => {
    expect(normalizeAutomaticPaneTitle(placeholder)).toBeNull();
  });

  it('accepts a meaningful one-word identifier', () => {
    expect(normalizeAutomaticPaneTitle('workerPool')).toBe('workerPool');
  });

  it('cuts long titles at a word boundary when possible', () => {
    const title = normalizeAutomaticPaneTitle('Rewrite the terminal streaming layer so hidden panes stop polling tmux');

    expect(title).toBe('Rewrite the terminal streaming layer so hidden');
    expect([...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(title ?? '')].length)
      .toBeLessThanOrEqual(48);
  });

  it('returns null for empty and decoration-only values', () => {
    expect(normalizeAutomaticPaneTitle(' \u0000 ✳ --- "" ')).toBeNull();
  });
});
