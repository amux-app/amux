import { describe, expect, it } from 'vitest';
import {
  stripTerminalMouseEnableControls,
  TerminalMouseModeStreamFilter,
} from '../../src/renderer/lib/terminal-mouse-mode';

describe('stripTerminalMouseEnableControls', () => {
  it('removes mouse tracking enable controls', () => {
    expect(stripTerminalMouseEnableControls('\x1b[?1000;1006hOpenCode response'))
      .toBe('OpenCode response');
  });

  it('preserves non-mouse private modes from mixed enable controls', () => {
    expect(stripTerminalMouseEnableControls('\x1b[?1049;1000;1006hOpenCode response'))
      .toBe('\x1b[?1049hOpenCode response');
  });

  it('leaves mouse disable controls untouched so existing mouse mode can still be cleared', () => {
    expect(stripTerminalMouseEnableControls('\x1b[?1000;1006lOpenCode response'))
      .toBe('\x1b[?1000;1006lOpenCode response');
  });

  it('filters a mixed mouse enable sequence at every possible stream split', () => {
    const input = '\x1b[?1049;1000;1006hOpenCode response';
    const expected = '\x1b[?1049hOpenCode response';

    for (let split = 1; split < input.length; split += 1) {
      const filter = new TerminalMouseModeStreamFilter();
      const output = filter.push(input.slice(0, split)) + filter.push(input.slice(split));

      expect(output, `split at byte ${split}`).toBe(expected);
      expect(filter.flush(), `pending data at byte ${split}`).toBe('');
    }
  });

  it('filters a mouse enable sequence delivered one character at a time', () => {
    const filter = new TerminalMouseModeStreamFilter();
    const output = Array.from('\x1b[?1000;1006hOpenCode response')
      .map((character) => filter.push(character))
      .join('');

    expect(output).toBe('OpenCode response');
    expect(filter.flush()).toBe('');
  });

  it('preserves unrelated and incomplete controls exactly', () => {
    const filter = new TerminalMouseModeStreamFilter();

    expect(filter.push('before\x1b')).toBe('before');
    expect(filter.push('[31mred\x1b[?1000;')).toBe('\x1b[31mred');
    expect(filter.flush()).toBe('\x1b[?1000;');
  });

  it('bounds malformed private-mode buffering and resumes after its final byte', () => {
    const filter = new TerminalMouseModeStreamFilter();

    expect(filter.push(`\x1b[?${'9'.repeat(5000)}`)).toBe('');
    expect(filter.push('hOpenCode response')).toBe('OpenCode response');
    expect(filter.flush()).toBe('');
  });
});
