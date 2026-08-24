import { describe, expect, it } from 'vitest';
import {
  compactAgentScrollbackForReplay,
  formatScrollbackInsert,
  formatScrollbackReplay,
  renderCapturedPaneFrame,
} from '../../src/main/services/terminal-render.js';

describe('terminal-render', () => {
  it('renders without emitting raw newlines (prevents scrollback frame duplication)', () => {
    const content = [
      'line1',
      'line2',
      'line3',
    ].join('\n') + '\n';

    const out = renderCapturedPaneFrame({ content, cols: 80, rows: 3, isFirst: true });
    expect(out).toContain('\x1b[0m\x1b[2J');
    expect(out).toContain('\x1b[1;1H\x1b[0m\x1b[2Kline1');
    expect(out).toContain('\x1b[3;1H\x1b[0m\x1b[2Kline3');
    expect(out).not.toContain('\n');
  });

  it('pads/clears missing rows', () => {
    const content = 'only\n';
    const out = renderCapturedPaneFrame({ content, cols: 80, rows: 3, isFirst: false });
    expect(out).toContain('\x1b[0m');
    expect(out).toContain('\x1b[1;1H\x1b[0m\x1b[2Konly');
    expect(out).toContain('\x1b[2;1H\x1b[0m\x1b[2K');
    expect(out).toContain('\x1b[3;1H\x1b[0m\x1b[2K');
  });

  it('trims leading blank rows for agent-style headers (anchors UI to top)', () => {
    const content = [
      '',
      '\x1b[31m╭─── Claude Code v0.0.0 ─╮\x1b[0m',
      'line2',
    ].join('\n') + '\n';

    const out = renderCapturedPaneFrame({ content, cols: 80, rows: 3, isFirst: true });
    expect(out).toContain('\x1b[0m\x1b[2J');
    // Header should be painted on the first row (not row 2).
    expect(out).toContain('\x1b[1;1H\x1b[0m\x1b[2K\x1b[31m╭─── Claude Code v0.0.0 ─╮\x1b[0m');
  });

  it('restores the tmux cursor position instead of parking at the last row', () => {
    const content = [
      'prompt> hello',
      '',
      '',
    ].join('\n') + '\n';

    const out = renderCapturedPaneFrame({
      content,
      cols: 80,
      rows: 3,
      cursor: { x: 7, y: 0, visible: true },
      isFirst: false,
    });

    expect(out).toContain('\x1b[?25h\x1b[1;8H');
  });

  it('restores autowrap before live terminal bytes resume', () => {
    const out = renderCapturedPaneFrame({
      content: 'warning that may wrap after replay\n',
      cols: 20,
      rows: 2,
      cursor: { x: 3, y: 0, visible: true },
      isFirst: false,
    });

    const disableWrap = out.indexOf('\x1b[?7l');
    const enableWrap = out.indexOf('\x1b[?7h');
    const cursorRestore = out.indexOf('\x1b[?25h\x1b[1;4H');
    expect(disableWrap).toBeGreaterThanOrEqual(0);
    expect(enableWrap).toBeGreaterThan(disableWrap);
    expect(cursorRestore).toBeGreaterThan(enableWrap);
  });

  it('clips over-wide captured frame rows to the current terminal columns', () => {
    const out = renderCapturedPaneFrame({
      content: '123456789\n',
      cols: 5,
      rows: 1,
      isFirst: false,
    });

    expect(out).toContain('\x1b[1;1H\x1b[0m\x1b[2K12345');
    expect(out).not.toContain('123456');
  });

  it('resets SGR before erasing each row so a trailing background does not smear into the next line', () => {
    // Arrange
    const content = [
      '\x1b[41mline with background\x1b[0m',
      'plain line',
    ].join('\n') + '\n';

    // Act
    const out = renderCapturedPaneFrame({ content, cols: 80, rows: 2, isFirst: false });

    // Assert
    expect(out).toContain('\x1b[1;1H\x1b[0m\x1b[2K\x1b[41mline with background\x1b[0m');
    expect(out).toContain('\x1b[2;1H\x1b[0m\x1b[2Kplain line');
  });

  it('adjusts the cursor row when trimmed leading rows shift the frame upward', () => {
    const content = [
      '',
      '╭─── Claude Code v0.0.0 ─╮',
      '│ prompt                  │',
    ].join('\n') + '\n';

    const out = renderCapturedPaneFrame({
      content,
      cols: 80,
      rows: 3,
      cursor: { x: 2, y: 1, visible: false },
      isFirst: false,
    });

    expect(out).toContain('\x1b[?25l\x1b[1;3H');
  });

  it('primes the DEC special graphics charset before replaying tmux ACS cells', () => {
    const content = '\x0elClaudeqCodeqv2.1.139k\x0f\n';

    const out = renderCapturedPaneFrame({ content, cols: 80, rows: 1, isFirst: false });

    expect(out.indexOf('\x1b)0')).toBeGreaterThanOrEqual(0);
    expect(out.indexOf('\x1b)0')).toBeLessThan(out.indexOf(content.trimEnd()));
    expect(out.endsWith('\x0f\x1b[?7h\x1b[1;1H')).toBe(true);
  });

  it('selects the alternate screen before painting alternate-screen captures', () => {
    const content = 'OpenCode\n';

    const out = renderCapturedPaneFrame({
      alternateOn: true,
      content,
      cols: 80,
      rows: 1,
      isFirst: true,
    });

    expect(out.startsWith('\x1b[?1049h')).toBe(true);
    expect(out.indexOf('\x1b[?1049h')).toBeLessThan(out.indexOf('OpenCode'));
  });

  it('returns to the primary screen before painting primary-screen captures', () => {
    const content = 'shell prompt\n';

    const out = renderCapturedPaneFrame({
      alternateOn: false,
      content,
      cols: 80,
      rows: 1,
      isFirst: true,
    });

    expect(out.startsWith('\x1b[?1049l')).toBe(true);
    expect(out.indexOf('\x1b[?1049l')).toBeLessThan(out.indexOf('shell prompt'));
  });

  it('primes the DEC special graphics charset before inserting tmux ACS scrollback', () => {
    const content = '\x0elqqk\x0f\n';

    const out = formatScrollbackInsert(content, 2);

    expect(out.indexOf('\x1b)0')).toBeGreaterThanOrEqual(0);
    expect(out.indexOf('\x1b)0')).toBeLessThan(out.indexOf(content.trimEnd()));
    expect(out).toContain('\x0f\x1b[?7h\x1b[2;1H');
  });

  it('restores autowrap after fixed-position scrollback pages', () => {
    const out = formatScrollbackReplay('history-line-1\nhistory-line-2', 5);

    const disableWrap = out.indexOf('\x1b[?7l');
    const enableWrap = out.indexOf('\x1b[?7h');
    const cursorPark = out.indexOf('\x1b[5;1H');
    expect(disableWrap).toBeGreaterThanOrEqual(0);
    expect(enableWrap).toBeGreaterThan(disableWrap);
    expect(cursorPark).toBeGreaterThan(enableWrap);
  });

  it('clips over-wide scrollback rows to the current terminal columns', () => {
    const out = (formatScrollbackReplay as (content: string, viewportRows: number, viewportCols: number) => string)(
      '123456789',
      2,
      5,
    );

    expect(out).toContain('\x1b[1;1H\x1b[2K\x1b[0m12345');
    expect(out).not.toContain('123456');
  });

  it('preserves ANSI controls while clipping scrollback rows by visible columns', () => {
    const out = (formatScrollbackReplay as (content: string, viewportRows: number, viewportCols: number) => string)(
      '\x1b[31mabc\x1b[0mdef',
      2,
      4,
    );

    expect(out).toContain('\x1b[31mabc\x1b[0md');
    expect(out).not.toContain('de');
  });

  it('forces short initial history into xterm scrollback', () => {
    const out = formatScrollbackReplay('history-line-1\nhistory-line-2', 5);

    expect(out).toContain('\x1b[1;1H\x1b[2K\x1b[0mhistory-line-1');
    expect(out).toContain('\x1b[2;1H\x1b[2K\x1b[0mhistory-line-2');
    expect(out.endsWith('\x0f\x1b[?7h\x1b[5;1H\n\n')).toBe(true);
  });

  it('preserves initial history longer than the viewport', () => {
    const out = formatScrollbackReplay('one\ntwo\nthree\nfour\nfive', 2);

    expect(out).toContain('one');
    expect(out).toContain('two');
    expect(out).toContain('three');
    expect(out).toContain('four');
    expect(out).toContain('five');
    expect(out.match(/\n/g)?.length).toBe(5);
  });

  it('preserves live scrollback deltas longer than the viewport', () => {
    // Arrange
    const content = ['one', 'two', 'three', 'four', 'five'].join('\n');

    // Act
    const out = formatScrollbackInsert(content, 2);

    // Assert
    expect(out).toContain('one');
    expect(out).toContain('two');
    expect(out).toContain('three');
    expect(out).toContain('four');
    expect(out).toContain('five');
    expect(out.match(/\n/g)?.length).toBe(5);
  });

  it('compacts duplicated Claude startup redraws before the first prompt', () => {
    const content = [
      '╭─── Claude Code v2.1.195 first-size',
      '│ Welcome back! │',
      '│ claude-opus-latest with xhigh effort · API Usage Billing │',
      '',
      '╭─── Claude Code v2.1.195 stable-size',
      '│ Tips for getting started │',
      '│ claude-opus-latest with xhigh effort · API Usage Billing │',
      '❯ first user prompt',
      'assistant answer',
    ].join('\n');

    const compacted = compactAgentScrollbackForReplay(content);

    expect(compacted).toEqual(expect.objectContaining({
      droppedLines: 4,
      duplicateStartupFrames: 2,
    }));
    expect(compacted.content).not.toContain('first-size');
    expect(compacted.content).toContain('stable-size');
    expect(compacted.content).toContain('❯ first user prompt');
    expect(compacted.content).toContain('assistant answer');
  });

  it('does not compact a single Claude startup frame', () => {
    const content = [
      '╭─── Claude Code v2.1.195 stable-size',
      '│ Tips for getting started │',
      '❯ first user prompt',
      'assistant answer',
    ].join('\n');

    const compacted = compactAgentScrollbackForReplay(content);

    expect(compacted).toEqual({
      content,
      droppedLines: 0,
      duplicateNumberedLines: 0,
      duplicateStartupFrames: 1,
    });
  });

  it('does not compact startup-like prose or later explicit restarts', () => {
    const prose = [
      'user pasted ╭─── Claude Code v2.1.195 example with Welcome back text',
      'more prose before another ╭─── Claude Code v2.1.195 example',
      '❯ first user prompt',
    ].join('\n');
    const restartAfterPrompt = [
      '╭─── Claude Code v2.1.195 first session',
      'Welcome back',
      '❯ first user prompt',
      'assistant answer',
      '╭─── Claude Code v2.1.195 restarted session',
      'Tips for getting started',
    ].join('\n');

    expect(compactAgentScrollbackForReplay(prose)).toEqual({
      content: prose,
      droppedLines: 0,
      duplicateNumberedLines: 0,
      duplicateStartupFrames: 0,
    });
    expect(compactAgentScrollbackForReplay(restartAfterPrompt)).toEqual({
      content: restartAfterPrompt,
      droppedLines: 0,
      duplicateNumberedLines: 0,
      duplicateStartupFrames: 1,
    });
  });

  it('drops startup frames before the prompt for live agent scrollback deltas', () => {
    const content = [
      '╭─── Claude Code v2.1.195 resized-startup',
      '│ Tips for getting started │',
      '│ Welcome back! │',
      '❯ first user prompt',
      'assistant answer line 1',
    ].join('\n');

    const compacted = compactAgentScrollbackForReplay(content, { dropStartupBeforePrompt: true });

    expect(compacted).toEqual(expect.objectContaining({
      droppedLines: 3,
      duplicateStartupFrames: 1,
    }));
    expect(compacted.content).not.toContain('resized-startup');
    expect(compacted.content).toContain('❯ first user prompt');
    expect(compacted.content).toContain('assistant answer line 1');
  });

  it('drops startup-only live agent deltas until a prompt exists', () => {
    const content = [
      '╭─── Claude Code v2.1.195 resized-startup',
      '│ Tips for getting started │',
      '│ Welcome back! │',
    ].join('\n');

    const compacted = compactAgentScrollbackForReplay(content, { dropStartupBeforePrompt: true });

    expect(compacted).toEqual({
      content: '',
      droppedLines: 3,
      duplicateNumberedLines: 0,
      duplicateStartupFrames: 1,
    });
  });

  it('compacts exact duplicate numbered assistant redraw lines for agent panes', () => {
    const content = [
      '89. The token form is AUMX-OVERPRINT-A1 with prefix.',
      '90. The exact required string is preserved.',
      '91. Streaming continues line by line.',
      '92. Each line is its own atomic statement.',
      '91. Streaming continues line by line.',
      '92. Each line is its own atomic statement.',
      '93. Brevity is preserved per the request.',
    ].join('\n');

    const compacted = compactAgentScrollbackForReplay(content);

    expect(compacted).toEqual(expect.objectContaining({
      droppedLines: 2,
      duplicateNumberedLines: 2,
      duplicateStartupFrames: 0,
    }));
    expect((compacted.content.match(/91\. Streaming continues line by line\./g) ?? [])).toHaveLength(1);
    expect((compacted.content.match(/92\. Each line is its own atomic statement\./g) ?? [])).toHaveLength(1);
    expect(compacted.content).toContain('93. Brevity is preserved per the request.');
  });

  it('keeps repeated numbered assistant lines across separate Claude prompts', () => {
    const content = [
      '❯ first prompt',
      '1. Keep this intentionally repeated line.',
      '❯ second prompt',
      '1. Keep this intentionally repeated line.',
    ].join('\n');

    const compacted = compactAgentScrollbackForReplay(content);

    expect(compacted).toEqual(expect.objectContaining({
      droppedLines: 0,
      duplicateNumberedLines: 0,
    }));
    expect((compacted.content.match(/1\. Keep this intentionally repeated line\./g) ?? [])).toHaveLength(2);
  });

});
