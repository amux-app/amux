import { describe, expect, it } from 'vitest';
import {
  accumulateScrolledTerminalSelection,
  expandScrolledTerminalSelection,
} from '../../src/shared/terminal-selection';

describe('expandScrolledTerminalSelection', () => {
  const capture = Array.from(
    { length: 12 },
    (_, index) => `line-${String(index + 1).padStart(2, '0')}`,
  ).join('\n');

  it('expands a downward-scrolled selection between its original and current viewport fragments', () => {
    expect(expandScrolledTerminalSelection(
      capture,
      'ne-01\nline-02\nline-03',
      'line-10\nline-11\nlin',
      'down',
    )).toBe([
      'ne-01',
      'line-02',
      'line-03',
      'line-04',
      'line-05',
      'line-06',
      'line-07',
      'line-08',
      'line-09',
      'line-10',
      'line-11',
      'lin',
    ].join('\n'));
  });

  it('expands an upward-scrolled selection without reversing copied text', () => {
    expect(expandScrolledTerminalSelection(
      capture,
      'line-10\nline-11\nlin',
      'ne-01\nline-02\nline-03',
      'up',
    )).toBe([
      'ne-01',
      'line-02',
      'line-03',
      'line-04',
      'line-05',
      'line-06',
      'line-07',
      'line-08',
      'line-09',
      'line-10',
      'line-11',
      'lin',
    ].join('\n'));
  });

  it('returns null when either viewport fragment is absent from authoritative history', () => {
    expect(expandScrolledTerminalSelection(capture, 'missing', 'line-12', 'down')).toBeNull();
  });

  it('terminates when the current viewport starts at capture offset zero without a preceding anchor', () => {
    expect(expandScrolledTerminalSelection(
      capture,
      'missing anchor',
      'line-01\nline-02',
      'down',
    )).toBeNull();
  });

  it('returns null when the same text appears twice in capture so anchor/current are ambiguous (down)', () => {
    // "dup" appears at positions 0 and in the middle — two valid (anchor,current) intervals exist
    const duplicateCapture = 'dup\nline-A\ndup\nline-B';
    expect(expandScrolledTerminalSelection(
      duplicateCapture,
      'dup',
      'line-B',
      'down',
    )).toBeNull();
  });

  it('returns null when the same text appears twice in capture so anchor/current are ambiguous (up)', () => {
    const duplicateCapture = 'line-A\ndup\nline-B\ndup';
    expect(expandScrolledTerminalSelection(
      duplicateCapture,
      'dup',
      'line-A',
      'up',
    )).toBeNull();
  });

  it('requires the downward interval to contain both complete fragments', () => {
    expect(expandScrolledTerminalSelection('abcde', 'abcde', 'b', 'down')).toBeNull();
    expect(expandScrolledTerminalSelection('abcde--b', 'abcde', 'b', 'down'))
      .toBe('abcde--b');
  });

  it('requires the upward interval to contain both complete fragments', () => {
    expect(expandScrolledTerminalSelection('abcde', 'b', 'abcde', 'up')).toBeNull();
    expect(expandScrolledTerminalSelection('abcde--b', 'b', 'abcde', 'up'))
      .toBe('abcde--b');
  });

  it('returns the slice for a single unambiguous downward interval (regression guard)', () => {
    // anchor appears once, current appears once — exactly one interval
    expect(expandScrolledTerminalSelection(
      capture,
      'line-02\nline-03',
      'line-10\nline-11',
      'down',
    )).toBe([
      'line-02',
      'line-03',
      'line-04',
      'line-05',
      'line-06',
      'line-07',
      'line-08',
      'line-09',
      'line-10',
      'line-11',
    ].join('\n'));
  });

  it('terminates and returns the slice when the anchor sits at the capture start (down)', () => {
    // Regression: lastIndexOf(anchor, -1) re-returns 0, so the inner loop must break at index 0
    expect(expandScrolledTerminalSelection(
      capture,
      'line-01',
      'line-11',
      'down',
    )).toBe([
      'line-01',
      'line-02',
      'line-03',
      'line-04',
      'line-05',
      'line-06',
      'line-07',
      'line-08',
      'line-09',
      'line-10',
      'line-11',
    ].join('\n'));
  });

  it('bounds repeated-current scans when the anchor is absent', () => {
    expect(expandScrolledTerminalSelection(
      'x'.repeat(100_000),
      'missing-anchor',
      'x',
      'down',
    )).toBeNull();
  }, 500);

  it('normalizes legal newline-dense capture inputs within the main-process budget', () => {
    const newlineDenseCapture = '\n'.repeat(5 * 1024 * 1024);

    expect(expandScrolledTerminalSelection(
      newlineDenseCapture,
      newlineDenseCapture,
      newlineDenseCapture,
      'down',
    )).toBe(newlineDenseCapture);
  }, 250);

  it('returns the slice for a single unambiguous upward interval (regression guard)', () => {
    expect(expandScrolledTerminalSelection(
      capture,
      'line-10\nline-11',
      'line-02\nline-03',
      'up',
    )).toBe([
      'line-02',
      'line-03',
      'line-04',
      'line-05',
      'line-06',
      'line-07',
      'line-08',
      'line-09',
      'line-10',
      'line-11',
    ].join('\n'));
  });
});

describe('accumulateScrolledTerminalSelection', () => {
  it('captures a downward selection expanding to the viewport edge before the first repaint', () => {
    expect(accumulateScrolledTerminalSelection(
      'header\nmessage-01\nmessage-02',
      'header\nmessage-01\nmessage-02\nmessage-03\nfooter',
      'down',
    )).toBe('header\nmessage-01\nmessage-02\nmessage-03\nfooter');
  });

  it('captures an upward selection expanding to the viewport edge before the first repaint', () => {
    expect(accumulateScrolledTerminalSelection(
      'message-03\nmessage-04\nfooter',
      'header\nmessage-01\nmessage-02\nmessage-03\nmessage-04\nfooter',
      'up',
    )).toBe('header\nmessage-01\nmessage-02\nmessage-03\nmessage-04\nfooter');
  });

  it('merges downward OpenCode repaints while ignoring stable terminal chrome', () => {
    const firstViewport = [
      'OpenCode',
      'message-01',
      'message-02',
      'message-03',
      '',
      '/repo  ctrl+p commands',
    ].join('\n');
    const secondViewport = [
      'OpenCode',
      'message-02',
      'message-03',
      'message-04',
      '',
      '/repo  ctrl+p commands',
    ].join('\n');

    expect(accumulateScrolledTerminalSelection(
      firstViewport,
      secondViewport,
      'down',
    )).toBe([
      'OpenCode',
      'message-01',
      'message-02',
      'message-03',
      'message-04',
      '',
      '/repo  ctrl+p commands',
    ].join('\n'));
  });

  it('merges upward OpenCode repaints in document order', () => {
    const laterViewport = [
      'OpenCode',
      'message-02',
      'message-03',
      'message-04',
      '',
      '/repo  ctrl+p commands',
    ].join('\n');
    const earlierViewport = [
      'OpenCode',
      'message-01',
      'message-02',
      'message-03',
      '',
      '/repo  ctrl+p commands',
    ].join('\n');

    expect(accumulateScrolledTerminalSelection(
      laterViewport,
      earlierViewport,
      'up',
    )).toBe([
      'OpenCode',
      'message-01',
      'message-02',
      'message-03',
      'message-04',
      '',
      '/repo  ctrl+p commands',
    ].join('\n'));
  });

  it('does not duplicate an adjacent identical-row run when merging downward', () => {
    expect(accumulateScrolledTerminalSelection(
      'start\nX\nX\nX\nX',
      'X\nX\nX\nX\nend',
      'down',
    )).toBe('start\nX\nX\nX\nX\nend');
  });

  it('does not duplicate an adjacent identical-row run when merging upward', () => {
    expect(accumulateScrolledTerminalSelection(
      'X\nX\nX\nX\nend',
      'start\nX\nX\nX\nX',
      'up',
    )).toBe('start\nX\nX\nX\nX\nend');
  });

  it('keeps an upward range when the incoming viewport has not advanced yet', () => {
    expect(accumulateScrolledTerminalSelection(
      'message-01\nmessage-02\nmessage-03\nmessage-04',
      'message-01\nmessage-02\nmessage-03',
      'up',
    )).toBe('message-01\nmessage-02\nmessage-03\nmessage-04');
  });

  it('keeps a downward range when the incoming viewport has not advanced yet', () => {
    expect(accumulateScrolledTerminalSelection(
      'message-01\nmessage-02\nmessage-03\nmessage-04',
      'message-02\nmessage-03\nmessage-04',
      'down',
    )).toBe('message-01\nmessage-02\nmessage-03\nmessage-04');
  });

  it('keeps a completed downward range when fixed chrome wraps its final viewport', () => {
    expect(accumulateScrolledTerminalSelection(
      'header\nmessage-01\nmessage-02\nmessage-03\nmessage-04\nfooter',
      'header\nmessage-03\nmessage-04\nfooter',
      'down',
    )).toBe('header\nmessage-01\nmessage-02\nmessage-03\nmessage-04\nfooter');
  });

  it('prefers moving message rows over a larger fixed OpenCode footer', () => {
    const firstViewport = [
      'OpenCode',
      'message-01',
      'message-02',
      'message-03',
      'Ask anything',
      'BUILD',
      '/repo',
      'ctrl+p commands',
    ].join('\n');
    const secondViewport = [
      'OpenCode',
      'message-02',
      'message-03',
      'message-04',
      'Ask anything',
      'BUILD',
      '/repo',
      'ctrl+p commands',
    ].join('\n');

    expect(accumulateScrolledTerminalSelection(
      firstViewport,
      secondViewport,
      'down',
    )).toBe([
      'OpenCode',
      'message-01',
      'message-02',
      'message-03',
      'message-04',
      'Ask anything',
      'BUILD',
      '/repo',
      'ctrl+p commands',
    ].join('\n'));
  });

  it('keeps extending across three OpenCode repaints without matching accumulated chrome', () => {
    const firstViewport = [
      'OpenCode',
      'message-01',
      'message-02',
      'message-03',
      'Ask anything',
      'BUILD',
      '/repo',
      'ctrl+p commands',
    ].join('\n');
    const secondViewport = [
      'OpenCode',
      'message-02',
      'message-03',
      'message-04',
      'Ask anything',
      'BUILD',
      '/repo',
      'ctrl+p commands',
    ].join('\n');
    const thirdViewport = [
      'OpenCode',
      'message-03',
      'message-04',
      'message-05',
      'Ask anything',
      'BUILD',
      '/repo',
      'ctrl+p commands',
    ].join('\n');

    const firstMerge = accumulateScrolledTerminalSelection(
      firstViewport,
      secondViewport,
      'down',
    );
    expect(firstMerge).not.toBeNull();
    expect(accumulateScrolledTerminalSelection(
      firstMerge!,
      thirdViewport,
      'down',
    )).toBe([
      'OpenCode',
      'message-01',
      'message-02',
      'message-03',
      'message-04',
      'message-05',
      'Ask anything',
      'BUILD',
      '/repo',
      'ctrl+p commands',
    ].join('\n'));
  });

  it('fails closed after a valid merge when a later repaint shares only fixed chrome', () => {
    const firstViewport = [
      'OpenCode',
      'message-01',
      'message-02',
      'message-03',
      'Ask anything',
      'BUILD',
      '/repo',
      'ctrl+p commands',
    ].join('\n');
    const secondViewport = [
      'OpenCode',
      'message-02',
      'message-03',
      'message-04',
      'Ask anything',
      'BUILD',
      '/repo',
      'ctrl+p commands',
    ].join('\n');
    const unrelatedViewport = [
      'OpenCode',
      'unrelated-01',
      'unrelated-02',
      'unrelated-03',
      'Ask anything',
      'BUILD',
      '/repo',
      'ctrl+p commands',
    ].join('\n');

    const firstMerge = accumulateScrolledTerminalSelection(
      firstViewport,
      secondViewport,
      'down',
    );
    expect(firstMerge).not.toBeNull();
    expect(accumulateScrolledTerminalSelection(
      firstMerge!,
      unrelatedViewport,
      'down',
    )).toBeNull();
  });

  it('fails closed when only fixed OpenCode chrome has a meaningful overlap', () => {
    const firstViewport = [
      'OpenCode',
      'message-01',
      'message-02',
      'Ask anything',
      'BUILD',
      '/repo',
      'ctrl+p commands',
    ].join('\n');
    const secondViewport = [
      'OpenCode',
      'message-02',
      'message-03',
      'Ask anything',
      'BUILD',
      '/repo',
      'ctrl+p commands',
    ].join('\n');

    expect(accumulateScrolledTerminalSelection(
      firstViewport,
      secondViewport,
      'down',
    )).toBeNull();
  });

  it('fails closed when separated downward repeats create multiple plausible joins', () => {
    const firstViewport = [
      'message-01',
      'repeat-01',
      'repeat-02',
      'repeat-03',
      'message-middle',
      'repeat-01',
      'repeat-02',
      'repeat-03',
    ].join('\n');
    const secondViewport = [
      'repeat-01',
      'repeat-02',
      'repeat-03',
      'message-new',
    ].join('\n');

    expect(accumulateScrolledTerminalSelection(
      firstViewport,
      secondViewport,
      'down',
    )).toBeNull();
  });

  it('fails closed when downward repeat candidates have different lengths', () => {
    const firstViewport = [
      'message-00',
      'repeat-01',
      'repeat-02',
      'repeat-03',
      'repeat-tail',
      'message-middle',
      'repeat-01',
      'repeat-02',
      'repeat-03',
    ].join('\n');
    const secondViewport = [
      'repeat-01',
      'repeat-02',
      'repeat-03',
      'repeat-tail',
      'message-new',
    ].join('\n');

    expect(accumulateScrolledTerminalSelection(
      firstViewport,
      secondViewport,
      'down',
    )).toBeNull();
  });

  it('fails closed when separated upward repeats create multiple plausible joins', () => {
    const laterViewport = [
      'repeat-01',
      'repeat-02',
      'repeat-03',
      'message-later',
    ].join('\n');
    const earlierViewport = [
      'message-new',
      'repeat-01',
      'repeat-02',
      'repeat-03',
      'message-middle',
      'repeat-01',
      'repeat-02',
      'repeat-03',
    ].join('\n');

    expect(accumulateScrolledTerminalSelection(
      laterViewport,
      earlierViewport,
      'up',
    )).toBeNull();
  });

  it('fails closed when upward repeat candidates have different lengths', () => {
    const laterViewport = [
      'repeat-01',
      'repeat-02',
      'repeat-03',
      'repeat-tail',
      'message-later',
    ].join('\n');
    const earlierViewport = [
      'message-new',
      'repeat-01',
      'repeat-02',
      'repeat-03',
      'repeat-tail',
      'message-middle',
      'repeat-01',
      'repeat-02',
      'repeat-03',
    ].join('\n');

    expect(accumulateScrolledTerminalSelection(
      laterViewport,
      earlierViewport,
      'up',
    )).toBeNull();
  });

  it('fails closed when repaints have no meaningful content overlap', () => {
    expect(accumulateScrolledTerminalSelection(
      'OpenCode\nmessage-01\n/repo  ctrl+p commands',
      'OpenCode\nmessage-99\n/repo  ctrl+p commands',
      'down',
    )).toBeNull();
  });
});
