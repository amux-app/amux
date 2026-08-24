import { describe, expect, it } from 'vitest';
import { WORKER_QUIET_TICKS_BEFORE_IDLE } from '../../src/constants/timing.js';
import {
  PaneStatusAnalyzer,
  type PaneStatusAnalysis,
} from '../../src/services/PaneStatusAnalyzer.js';

const WORKING_LINE = '· Germinating… (esc to interrupt · 42s)';
const IDLE_FRAME = [
  '⏺ Done.',
  '│ > ',
  '  Opus 4.6 · 32% context left',
  '⏵⏵ bypass permissions on (shift+tab to cycle)',
].join('\n');

function analyze(
  analyzer: PaneStatusAnalyzer,
  content: string,
  visibleFrame = content,
): PaneStatusAnalysis {
  return analyzer.analyzeCapture(content, visibleFrame);
}

describe('PaneStatusAnalyzer working detection window', () => {
  it('ignores a stale working indicator that only survives in scrollback', () => {
    const analyzer = new PaneStatusAnalyzer('claude');

    const result = analyze(analyzer, [WORKING_LINE, IDLE_FRAME].join('\n'), IDLE_FRAME);

    expect(result.statusChange?.status).not.toBe('working');
  });

  it('reports working when the indicator is the most recent line in the visible frame', () => {
    const analyzer = new PaneStatusAnalyzer('claude');

    const result = analyze(analyzer, [IDLE_FRAME, WORKING_LINE].join('\n'));

    expect(result.statusChange?.status).toBe('working');
  });

  it('does not let a stale idle banner in scrollback mask genuine work in the visible frame', () => {
    const analyzer = new PaneStatusAnalyzer('claude');
    const visibleWorkFrames = ['Editing implementation', 'Reading files', 'Running tests']
      .map((line) => `${line}\n${WORKING_LINE}`);

    const statuses = visibleWorkFrames.flatMap((visibleFrame) => {
      const staleScrollback = [IDLE_FRAME, visibleFrame].join('\n');
      return analyze(analyzer, staleScrollback, visibleFrame).statusChange?.status ?? [];
    });

    expect(statuses).toEqual(['working']);
  });
});

describe('PaneStatusAnalyzer polling activity classification', () => {
  it('reports changed and working content as active and stable idle content as quiet', () => {
    const analyzer = new PaneStatusAnalyzer('claude');

    const results = [
      analyze(analyzer, IDLE_FRAME),
      analyze(analyzer, IDLE_FRAME),
      analyze(analyzer, WORKING_LINE),
    ];

    expect(results.map((result) => result.active)).toEqual([true, false, true]);
  });

  it('keeps polling unrecognized changing output without promoting it to working', () => {
    const analyzer = new PaneStatusAnalyzer('claude');

    const results = [
      analyze(analyzer, 'Preparing task'),
      analyze(analyzer, 'Reading files'),
      analyze(analyzer, 'Editing implementation'),
    ];

    expect(results.every((result) => result.active)).toBe(true);
    expect(results.flatMap((result) => result.statusChange?.status ?? [])).toEqual([]);
  });

  it('returns marker-detected work to idle after the output settles', () => {
    const analyzer = new PaneStatusAnalyzer('claude');
    const captures = [
      WORKING_LINE,
      'Editing implementation',
      'Editing implementation',
      'Editing implementation',
    ];

    const statuses = captures.flatMap(
      (capture) => analyze(analyzer, capture).statusChange?.status ?? [],
    );

    expect(statuses).toEqual(['working', 'idle']);
  });

  it('settles to idle for a genuine claude idle frame (persistent bypass-permissions chrome, no spinner) after enough stable captures, since idle is no longer positively detected', () => {
    const analyzer = new PaneStatusAnalyzer('claude');
    const captures = [WORKING_LINE, IDLE_FRAME, IDLE_FRAME, IDLE_FRAME, IDLE_FRAME];

    const statuses = captures.flatMap(
      (capture) => analyze(analyzer, capture).statusChange?.status ?? [],
    );

    expect(statuses).toEqual(['working', 'idle']);
  });
});

describe('PaneStatusAnalyzer empty capture handling', () => {
  it('keeps status unchanged and reports the failed capture as quiet', () => {
    const analyzer = new PaneStatusAnalyzer('claude');
    analyze(analyzer, WORKING_LINE);

    const result = analyze(analyzer, '', '');

    expect(result).toEqual({ active: false });
  });

  it('allows repeated empty captures to remain quiet for scheduler backoff', () => {
    const analyzer = new PaneStatusAnalyzer('claude');
    analyze(analyzer, WORKING_LINE);

    const results = Array.from(
      { length: WORKER_QUIET_TICKS_BEFORE_IDLE },
      () => analyze(analyzer, '', ''),
    );

    expect(results.map((result) => result.active))
      .toEqual(Array(WORKER_QUIET_TICKS_BEFORE_IDLE).fill(false));
  });
});
