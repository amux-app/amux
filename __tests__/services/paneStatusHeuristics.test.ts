import { describe, expect, it } from 'vitest';
import { classifyTailStatus } from '../../src/services/paneStatusHeuristics.js';

const CLAUDE_WORKING_FRAME = '· Thinking… (esc to interrupt · 12s)';
const CODEX_WORKING_FRAME = 'Esc to interrupt';
const OPENCODE_LEGACY_WORKING_FRAME = 'working...';
const OPENCODE_WORKING_FRAME = '■⬝⬝⬝⬝⬝⬝⬝  esc interrupt';
const PI_WORKING_FRAME = '⠋ Working...\nescape interrupt · ctrl+c/ctrl+d clear/exit';
const OPENCODE_IDLE_FRAME = [
  '┃  Ask anything... "Fix broken tests"',
  '┃  Build · GPT-5.5 Fast OpenAI',
  'tab agents  ctrl+p commands',
  ...Array.from({ length: 10 }, () => ''),
  '~/projects/dmux:main  1.18.15',
].join('\n');
const PI_IDLE_FRAME = [
  '────────────────────────────────────',
  '',
  '────────────────────────────────────',
  '~/projects/dmux (main)',
  '0.0%/1.0M (auto)  anthropic--claude-4.8-opus • high',
].join('\n');
const CLAUDE_BYPASS_LINE = '⏵⏵ bypass permissions on (shift+tab to cycle)';
const CLAUDE_PERSISTENT_CHROME_FRAME = [
  '⏺ Done.',
  '│ > ',
  '  Opus 4.6 · 32% context left',
  CLAUDE_BYPASS_LINE,
].join('\n');
const REAL_CLAUDE_WORKING_FRAME = [
  'Reading src/index.ts',
  'Editing implementation',
  CLAUDE_WORKING_FRAME,
  '│ >                                    │',
  CLAUDE_BYPASS_LINE,
].join('\n');

function fillerLines(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `line ${index + 1}`);
}

function blankLines(count: number): string[] {
  return Array.from({ length: count }, () => '');
}

describe('classifyTailStatus basic detection', () => {
  it('detects the Claude working footer with the parenthesized form', () => {
    const result = classifyTailStatus(CLAUDE_WORKING_FRAME, 'claude');

    expect(result).toBe('working');
  });

  it('detects the Codex working footer without a leading paren', () => {
    const result = classifyTailStatus(CODEX_WORKING_FRAME, 'codex');

    expect(result).toBe('working');
  });

  it('detects the current OpenCode working footer', () => {
    const result = classifyTailStatus(OPENCODE_WORKING_FRAME, 'opencode');

    expect(result).toBe('working');
  });

  it('keeps supporting the legacy OpenCode working footer', () => {
    const result = classifyTailStatus(OPENCODE_LEGACY_WORKING_FRAME, 'opencode');

    expect(result).toBe('working');
  });

  it('detects the Pi working footer used during an active turn', () => {
    const result = classifyTailStatus(PI_WORKING_FRAME, 'pi');

    expect(result).toBe('working');
  });

  it('does not treat Pi persistent context chrome as an idle-only signal', () => {
    expect(classifyTailStatus(PI_IDLE_FRAME, 'pi')).toBeNull();
  });

  it('detects the OpenCode prompt as immediately idle despite viewport padding', () => {
    expect(classifyTailStatus(OPENCODE_IDLE_FRAME, 'opencode')).toBe('idle');
  });

  it('keeps agent-specific idle chrome scoped to its agent', () => {
    expect(classifyTailStatus(PI_IDLE_FRAME, 'claude')).toBeNull();
    expect(classifyTailStatus(OPENCODE_IDLE_FRAME, 'pi')).toBeNull();
  });

  it('keeps a working footer authoritative when idle chrome is still visible', () => {
    expect(classifyTailStatus(`${PI_IDLE_FRAME}\n${PI_WORKING_FRAME}`, 'pi')).toBe('working');
    expect(classifyTailStatus(`${OPENCODE_IDLE_FRAME}\n${OPENCODE_WORKING_FRAME}`, 'opencode')).toBe('working');
  });

  it('keeps the OpenCode-only footer scoped to OpenCode', () => {
    expect(classifyTailStatus(OPENCODE_WORKING_FRAME, 'claude')).toBeNull();
    expect(classifyTailStatus(OPENCODE_WORKING_FRAME, 'codex')).toBeNull();
  });

  it('returns null when neither indicator is present', () => {
    const result = classifyTailStatus('Preparing task', 'claude');

    expect(result).toBeNull();
  });

  it('returns null for persistent claude chrome (model/context line and bypass-permissions footer) with no spinner', () => {
    const result = classifyTailStatus(CLAUDE_PERSISTENT_CHROME_FRAME, 'claude');

    expect(result).toBeNull();
  });
});

describe('classifyTailStatus regression: persistent bypass-permissions chrome must not mask real work', () => {
  it('classifies working when the thinking spinner is followed by the input box and the trailing bypass-permissions footer', () => {
    const result = classifyTailStatus(REAL_CLAUDE_WORKING_FRAME, 'claude');

    expect(result).toBe('working');
  });
});

describe('classifyTailStatus tail window restriction', () => {
  it('does not let a mid-frame quote of "working..." outside the tail window register as working', () => {
    const frame = [
      'Tip: the status bar used to read "working..." during a run.',
      ...fillerLines(7),
      'opencode ready',
    ].join('\n');

    const result = classifyTailStatus(frame, 'opencode');

    expect(result).toBeNull();
  });

  it('still detects real bottom-anchored working footers for every agent', () => {
    const claudeFrame = [...fillerLines(6), CLAUDE_WORKING_FRAME].join('\n');
    const codexFrame = [...fillerLines(6), CODEX_WORKING_FRAME].join('\n');
    const opencodeFrame = [...fillerLines(6), OPENCODE_WORKING_FRAME].join('\n');

    expect(classifyTailStatus(claudeFrame, 'claude')).toBe('working');
    expect(classifyTailStatus(codexFrame, 'codex')).toBe('working');
    expect(classifyTailStatus(opencodeFrame, 'opencode')).toBe('working');
  });

  it('detects a real working footer on a frame shorter than the tail window', () => {
    const tinyFrame = ['line 1', 'line 2', CLAUDE_WORKING_FRAME].join('\n');

    const result = classifyTailStatus(tinyFrame, 'claude');

    expect(result).toBe('working');
  });
});

describe('classifyTailStatus sparse frame with trailing blank rows (F2)', () => {
  it('detects a real working footer sitting above trailing blank rows', () => {
    const frame = [
      'content line above the footer',
      CLAUDE_WORKING_FRAME,
      ...blankLines(10),
    ].join('\n');

    const result = classifyTailStatus(frame, 'claude');

    expect(result).toBe('working');
  });

  it('leaves a dense frame (no trailing blanks) unaffected', () => {
    const frame = [...fillerLines(6), CLAUDE_WORKING_FRAME].join('\n');

    const result = classifyTailStatus(frame, 'claude');

    expect(result).toBe('working');
  });
});

describe('classifyTailStatus accepted trade-off: generic idle is not independently detected', () => {
  it('classifies working when a quoted "(esc to interrupt)" phrase sits in the tail of an otherwise static chrome-only frame', () => {
    const frame = [
      'Note: you can press "(esc to interrupt)" anytime.',
      ...fillerLines(3),
      CLAUDE_PERSISTENT_CHROME_FRAME,
    ].join('\n');

    const result = classifyTailStatus(frame, 'claude');

    expect(result).toBe('working');
  });
});
