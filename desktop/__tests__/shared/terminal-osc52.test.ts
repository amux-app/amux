import { describe, expect, it } from 'vitest';
import {
  MAX_OSC52_CLIPBOARD_CHARS,
  decodeOsc52ClipboardText,
} from '../../src/renderer/lib/terminal-osc52';

function encode(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}

describe('terminal OSC 52 clipboard parsing', () => {
  it('decodes clipboard-selection writes as UTF-8 text', () => {
    expect(decodeOsc52ClipboardText(`c;${encode('hello λ world')}`)).toBe('hello λ world');
  });

  it('accepts the default selection and rejects non-clipboard selections', () => {
    expect(decodeOsc52ClipboardText(`;${encode('default clipboard')}`)).toBe('default clipboard');
    expect(decodeOsc52ClipboardText(`p;${encode('primary selection')}`)).toBeNull();
  });

  it('ignores clipboard read requests and malformed payloads', () => {
    expect(decodeOsc52ClipboardText('c;?')).toBeNull();
    expect(decodeOsc52ClipboardText('c;not valid base64')).toBeNull();
    expect(decodeOsc52ClipboardText('missing-delimiter')).toBeNull();
  });

  it('bounds decoded clipboard text', () => {
    const tooLarge = 'x'.repeat(MAX_OSC52_CLIPBOARD_CHARS + 1);

    expect(decodeOsc52ClipboardText(`c;${encode(tooLarge)}`)).toBeNull();
  });
});
