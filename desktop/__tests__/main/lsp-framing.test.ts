import { describe, expect, it, vi } from 'vitest';
import {
  encodeLspFrame,
  LspFrameParser,
  LspFramingError,
} from '../../src/main/lsp/LspFrameParser';

describe('LspFrameParser', () => {
  it('parses split headers, split bodies, and coalesced frames', () => {
    const parser = new LspFrameParser();
    const first = encodeLspFrame({ jsonrpc: '2.0', method: 'one' });
    const second = encodeLspFrame({ id: 2, jsonrpc: '2.0', result: null });

    expect(parser.push(first.subarray(0, 9))).toEqual([]);
    expect(parser.push(Buffer.concat([first.subarray(9), second.subarray(0, 5)]))).toEqual([
      { jsonrpc: '2.0', method: 'one' },
    ]);
    expect(parser.push(second.subarray(5))).toEqual([
      { id: 2, jsonrpc: '2.0', result: null },
    ]);
  });

  it('makes malformed and oversized framing fatal instead of resynchronizing', () => {
    const malformed = new LspFrameParser();
    expect(() => malformed.push(Buffer.from('Other: 1\r\n\r\n{}'))).toThrow(LspFramingError);
    expect(() => malformed.push(encodeLspFrame({ jsonrpc: '2.0', method: 'later' }))).toThrow(LspFramingError);

    const oversizedHeader = new LspFrameParser({ maxHeaderBytes: 8 });
    expect(() => oversizedHeader.push(Buffer.from('Content-Length: 2\r\n\r\n{}'))).toThrow('header exceeds');

    const oversizedBody = new LspFrameParser({ maxFrameBytes: 1 });
    expect(() => oversizedBody.push(Buffer.from('Content-Length: 2\r\n\r\n{}'))).toThrow('frame exceeds');
  });

  it('rejects invalid JSON and invalid JSON-RPC envelopes', () => {
    const invalidJson = new LspFrameParser();
    expect(() => invalidJson.push(Buffer.from('Content-Length: 1\r\n\r\n{'))).toThrow('invalid JSON');

    const invalidEnvelope = new LspFrameParser();
    expect(() => invalidEnvelope.push(encodeLspFrame({ hello: 'world' }))).toThrow('JSON-RPC');
  });

  it('buffers a split large body without repeatedly concatenating accumulated bytes', () => {
    const parser = new LspFrameParser();
    const frame = encodeLspFrame({
      id: 1,
      jsonrpc: '2.0',
      result: 'x'.repeat(256 * 1_024),
    });
    const concat = vi.spyOn(Buffer, 'concat');

    try {
      let messages: ReturnType<LspFrameParser['push']> = [];
      for (let offset = 0; offset < frame.length; offset += 1_024) {
        messages = parser.push(frame.subarray(offset, offset + 1_024));
      }

      expect(messages).toEqual([{
        id: 1,
        jsonrpc: '2.0',
        result: 'x'.repeat(256 * 1_024),
      }]);
      expect(concat).not.toHaveBeenCalled();
    } finally {
      concat.mockRestore();
    }
  });
});
