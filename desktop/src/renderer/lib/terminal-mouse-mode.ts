const MOUSE_MODE_PARAMS = new Set([
  '9',
  '1000',
  '1002',
  '1003',
  '1005',
  '1006',
  '1015',
  '1016',
]);

const PRIVATE_MODE_ENABLE_PATTERN = /\x1b\[\?([0-9;]+)h/g;
const MAX_PENDING_PRIVATE_MODE_CHARS = 256;

function findCsiFinalByte(data: string): number {
  for (let index = 0; index < data.length; index += 1) {
    const code = data.charCodeAt(index);
    if (code >= 0x40 && code <= 0x7e) return index;
  }
  return -1;
}

function stripPrivateModeEnable(sequence: string, rawParams: string): string {
  const params = rawParams.split(';').filter(Boolean);
  const kept = params.filter((param) => !MOUSE_MODE_PARAMS.has(param));
  if (kept.length === params.length) return sequence;
  if (kept.length === 0) return '';
  return `\x1b[?${kept.join(';')}h`;
}

export function stripTerminalMouseEnableControls(data: string): string {
  return data.replace(PRIVATE_MODE_ENABLE_PATTERN, stripPrivateModeEnable);
}

/**
 * Filters DEC private-mode mouse enables without assuming PTY event boundaries
 * align with ANSI control-sequence boundaries.
 */
export class TerminalMouseModeStreamFilter {
  private discardingPrivateMode = false;
  private pending = '';

  push(data: string): string {
    let input = data;
    if (this.discardingPrivateMode) {
      const sequenceEnd = findCsiFinalByte(input);
      if (sequenceEnd < 0) return '';
      this.discardingPrivateMode = false;
      input = input.slice(sequenceEnd + 1);
    }

    input = this.pending + input;
    this.pending = '';
    let cursor = 0;
    let output = '';

    while (cursor < input.length) {
      const sequenceStart = input.indexOf('\x1b[?', cursor);
      if (sequenceStart < 0) {
        const trailingPrefixLength = input.endsWith('\x1b[')
          ? 2
          : input.endsWith('\x1b')
            ? 1
            : 0;
        const outputEnd = input.length - trailingPrefixLength;
        output += input.slice(cursor, outputEnd);
        this.pending = input.slice(outputEnd);
        break;
      }

      output += input.slice(cursor, sequenceStart);
      let sequenceEnd = sequenceStart + 3;
      while (sequenceEnd < input.length && /[0-9;]/.test(input[sequenceEnd])) {
        sequenceEnd += 1;
      }

      if (sequenceEnd === input.length) {
        const candidate = input.slice(sequenceStart);
        if (candidate.length > MAX_PENDING_PRIVATE_MODE_CHARS) {
          // A valid DEC private-mode control is tiny. Bound malformed or
          // hostile unterminated sequences, and discard through their eventual
          // CSI final byte so xterm cannot reconstruct a mouse enable later.
          this.discardingPrivateMode = true;
        } else {
          this.pending = candidate;
        }
        break;
      }

      const sequence = input.slice(sequenceStart, sequenceEnd + 1);
      const rawParams = input.slice(sequenceStart + 3, sequenceEnd);
      output += input[sequenceEnd] === 'h' && rawParams.length > 0
        ? stripPrivateModeEnable(sequence, rawParams)
        : sequence;
      cursor = sequenceEnd + 1;
    }

    return output;
  }

  flush(): string {
    const pending = this.pending;
    this.pending = '';
    this.discardingPrivateMode = false;
    return pending;
  }
}
