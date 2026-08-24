import { describe, expect, it } from 'vitest';
import { FIRST_IDLE_STABLE_CAPTURES } from '../../src/constants/timing.js';
import { PaneStatusAnalyzer } from '../../src/services/PaneStatusAnalyzer.js';

const TALL_PANE_HEIGHT = 40;
const SHRUNK_PANE_HEIGHT = 15;
const WORKING_LINE = '· Germinating… (esc to interrupt · 42s)';

function numberedRows(prefix: string, count: number): string[] {
  return Array.from({ length: count }, (_, index) => `${prefix} ${index + 1}`);
}

function composerRows(count: number): string[] {
  return [
    '⏺ Finished the refactor.',
    '│ > ',
    '  Opus 4.6 · 32% context left',
    ...Array.from({ length: count - 3 }, () => ''),
  ];
}

describe('PaneStatusAnalyzer visible frame after a pane resize', () => {
  it('never reports working from scrollback pulled in by a height shrink', () => {
    const analyzer = new PaneStatusAnalyzer('claude');
    const scrollback = numberedRows('scrollback line', 28);
    const tallComposer = composerRows(TALL_PANE_HEIGHT);
    const shortComposer = composerRows(SHRUNK_PANE_HEIGHT);

    const tall = analyzer.analyzeCapture(
      [...scrollback, WORKING_LINE, 'done', ...tallComposer].join('\n'),
      tallComposer.join('\n'),
    );
    const short = analyzer.analyzeCapture(
      [...scrollback, WORKING_LINE, 'done', ...shortComposer].join('\n'),
      shortComposer.join('\n'),
    );

    expect([tall, short].flatMap((result) => result.statusChange?.status ?? []))
      .not.toContain('working');
  });

  it('stays idle across repeated capture changes caused only by pane resizing', () => {
    const analyzer = new PaneStatusAnalyzer('claude');
    const initialFrame = composerRows(TALL_PANE_HEIGHT).join('\n');

    for (let capture = 0; capture < FIRST_IDLE_STABLE_CAPTURES; capture++) {
      analyzer.analyzeCapture(initialFrame, initialFrame);
    }

    const resizeResults = [35, 30, 25, 20, SHRUNK_PANE_HEIGHT].map((height) => {
      const frame = composerRows(height).join('\n');
      return analyzer.analyzeCapture(frame, frame);
    });

    expect(resizeResults.flatMap((result) => result.statusChange?.status ?? []))
      .not.toContain('working');
  });
});
