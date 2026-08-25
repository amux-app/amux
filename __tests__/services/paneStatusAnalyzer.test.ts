import { describe, expect, it } from 'vitest';
import { FIRST_IDLE_STABLE_CAPTURES, STATUS_REASSERT_CAPTURES } from '../../src/constants/timing.js';
import { PaneStatusAnalyzer } from '../../src/services/PaneStatusAnalyzer.js';

const WORKING_FRAME = '· Germinating… (esc to interrupt · 42s)';
const CODEX_WORKING_FRAME = 'Esc to interrupt';
const OPENCODE_WORKING_FRAME = '■⬝⬝⬝⬝⬝⬝⬝  esc interrupt';
const PI_WORKING_FRAME = '⠋ Working...\nescape interrupt · ctrl+c/ctrl+d clear/exit';
const OPENCODE_IDLE_FRAME = '┃  Ask anything... "Fix broken tests"\n~/projects/muxbase:main  1.18.15';
const PI_IDLE_FRAME = '~/projects/muxbase (main)\n0.0%/1.0M (auto)  anthropic--claude-4.8-opus • high';
const IDLE_FRAME = [
  '⏺ Done.',
  '│ > ',
  '  Opus 4.6 · 32% context left',
  '⏵⏵ bypass permissions on (shift+tab to cycle)',
].join('\n');
const STATIC_SHELL_ERROR_FRAME = 'bash: claude: command not found';

describe('PaneStatusAnalyzer', () => {
  it('emits a working edge as a first-ever established status (no real previous status exists yet), and no edge for a repeated working capture', () => {
    const analyzer = new PaneStatusAnalyzer('claude');

    const firstIdle = analyzer.analyzeCapture(IDLE_FRAME, IDLE_FRAME);
    const working = analyzer.analyzeCapture(WORKING_FRAME, WORKING_FRAME);
    const duplicateWorking = analyzer.analyzeCapture(WORKING_FRAME, WORKING_FRAME);

    expect(firstIdle.statusChange).toBeUndefined();
    expect(working.statusChange).toEqual({
      previousStatus: 'working',
      status: 'working',
    });
    expect(duplicateWorking.statusChange).toBeUndefined();
  });

  it('never mints an idle edge before FIRST_IDLE_STABLE_CAPTURES stable captures', () => {
    const analyzer = new PaneStatusAnalyzer('claude');

    const results = Array.from(
      { length: FIRST_IDLE_STABLE_CAPTURES },
      () => analyzer.analyzeCapture(STATIC_SHELL_ERROR_FRAME, STATIC_SHELL_ERROR_FRAME),
    );

    expect(results.slice(0, FIRST_IDLE_STABLE_CAPTURES - 1).map((r) => r.statusChange)).toEqual(
      Array(FIRST_IDLE_STABLE_CAPTURES - 1).fill(undefined),
    );
    expect(results[FIRST_IDLE_STABLE_CAPTURES - 1].statusChange).toEqual({
      previousStatus: 'idle',
      status: 'idle',
    });
  });

  it('reaches working from a launch sequence (shell -> changing banner frames -> esc-to-interrupt footer) and never mints a premature first-idle', () => {
    const analyzer = new PaneStatusAnalyzer('claude');
    const captures = [
      '$ claude',
      'Loading models...',
      'Initializing session...',
      WORKING_FRAME,
    ];

    const statuses = captures.flatMap(
      (capture) => analyzer.analyzeCapture(capture, capture).statusChange?.status ?? [],
    );

    expect(statuses).not.toContain('idle');
    expect(statuses).toContain('working');
  });

  it('does not report working from changing launch chrome before an explicit working signal appears', () => {
    const analyzer = new PaneStatusAnalyzer('claude');
    const launchFrames = [
      '$ claude',
      'Loading models...',
      'Initializing session...',
      'Rendering composer...',
    ];

    const statuses = launchFrames.flatMap(
      (capture) => analyzer.analyzeCapture(capture, capture).statusChange?.status ?? [],
    );

    expect(statuses).not.toContain('working');
  });

  it.each([
    ['claude', WORKING_FRAME],
    ['codex', CODEX_WORKING_FRAME],
    ['opencode', OPENCODE_WORKING_FRAME],
    ['pi', PI_WORKING_FRAME],
  ] as const)('keeps a stable %s busy footer working without settling it to idle', (agent, frame) => {
    const analyzer = new PaneStatusAnalyzer(agent);

    const results = Array.from(
      { length: FIRST_IDLE_STABLE_CAPTURES * 2 },
      () => analyzer.analyzeCapture(frame, frame),
    );

    expect(results.flatMap((result) => result.statusChange?.status ?? [])).toEqual(['working', 'working']);
    expect(results.every((result) => result.active)).toBe(true);
  });

  it('reasserts a still-working status on a bounded cadence so its evidence stays fresh', () => {
    // Arrange
    const analyzer = new PaneStatusAnalyzer('claude');

    // Act
    const results = Array.from(
      { length: STATUS_REASSERT_CAPTURES * 2 },
      () => analyzer.analyzeCapture(WORKING_FRAME, WORKING_FRAME),
    );

    // Assert
    const emitOffsets = results
      .map((result, index) => (result.statusChange ? index + 1 : null))
      .filter((offset): offset is number => offset !== null);
    expect(emitOffsets).toEqual([1, 1 + STATUS_REASSERT_CAPTURES]);
    expect(results[0].statusChange?.reasserted).toBeUndefined();
    expect(results[STATUS_REASSERT_CAPTURES].statusChange?.reasserted).toBe(true);
  });

  it('clears the launch-time busy status on the first ready OpenCode frame', () => {
    const agent = 'opencode';
    const frame = OPENCODE_IDLE_FRAME;
    const analyzer = new PaneStatusAnalyzer(agent);

    const result = analyzer.analyzeCapture(frame, frame);

    expect(result.statusChange).toEqual({ previousStatus: 'idle', status: 'idle' });
  });

  it('requests a redraw-separated confirmation when a visible working marker disappears', () => {
    const analyzer = new PaneStatusAnalyzer('claude');
    analyzer.analyzeCapture(WORKING_FRAME, WORKING_FRAME);
    const readyFrame = '│ > ';

    const firstIdleFrame = analyzer.analyzeCapture(readyFrame, readyFrame);
    const confirmedIdle = analyzer.analyzeCapture(readyFrame, readyFrame);

    expect(firstIdleFrame.requestIdleConfirmation).toBe(true);
    expect(firstIdleFrame.statusChange).toBeUndefined();
    expect(confirmedIdle.statusChange).toEqual({ previousStatus: 'working', status: 'idle' });
  });

  it('requires stable evidence before classifying Pi persistent chrome as idle', () => {
    const analyzer = new PaneStatusAnalyzer('pi');
    const result = analyzer.analyzeCapture(PI_IDLE_FRAME, PI_IDLE_FRAME);

    expect(result.statusChange).toBeUndefined();
  });

  it('recognizes a ready Pi composer immediately when fresh-launch handoff is enabled', () => {
    const analyzer = new PaneStatusAnalyzer('pi', true);

    const result = analyzer.analyzeCapture(PI_IDLE_FRAME, PI_IDLE_FRAME);

    expect(result.statusChange).toEqual({ previousStatus: 'idle', status: 'idle' });
  });

  it('keeps active Pi chrome authoritative during fresh-launch handoff', () => {
    const analyzer = new PaneStatusAnalyzer('pi', true);
    const activeFrame = `Working...\n${PI_IDLE_FRAME}`;

    const result = analyzer.analyzeCapture(activeFrame, activeFrame);

    expect(result.statusChange).toEqual({ previousStatus: 'working', status: 'working' });
  });

  it('recognizes Pi readiness after a slow boot already established working', () => {
    const analyzer = new PaneStatusAnalyzer('pi', true);
    analyzer.analyzeCapture(PI_WORKING_FRAME, PI_WORKING_FRAME);

    const result = analyzer.analyzeCapture(PI_IDLE_FRAME, PI_IDLE_FRAME);

    expect(result.statusChange).toEqual({ previousStatus: 'working', status: 'idle' });
  });

  it('marks a periodic idle reassertion so downstream can tell it from a transition', () => {
    // Arrange — settled idle needs restating too: without it a pane whose state
    // has degraded to unknown has no way back while its frame stays quiet.
    const analyzer = new PaneStatusAnalyzer('claude');
    for (let i = 0; i < FIRST_IDLE_STABLE_CAPTURES; i++) {
      analyzer.analyzeCapture(STATIC_SHELL_ERROR_FRAME, STATIC_SHELL_ERROR_FRAME);
    }

    // Act
    const results = Array.from(
      { length: STATUS_REASSERT_CAPTURES + 2 },
      () => analyzer.analyzeCapture(STATIC_SHELL_ERROR_FRAME, STATIC_SHELL_ERROR_FRAME),
    );

    // Assert
    const reasserts = results.flatMap((result) => result.statusChange ?? []);
    expect(reasserts).toEqual([{ previousStatus: 'idle', reasserted: true, status: 'idle' }]);
  });

  it('uses the visible frame rather than growing scrollback to establish fallback idle', () => {
    const analyzer = new PaneStatusAnalyzer('claude');
    const visibleFrame = '│ > ';

    const results = Array.from({ length: FIRST_IDLE_STABLE_CAPTURES }, (_, index) => analyzer.analyzeCapture(
      `scrollback line ${index}\n${visibleFrame}`,
      visibleFrame,
    ));

    expect(results.at(-1)?.statusChange).toEqual({ previousStatus: 'idle', status: 'idle' });
  });

  it('restarts the grace window on a typing edit while unknown, instead of leaving stale pre-typing frames in the window (regression: premature idle at ~3 captures)', () => {
    const analyzer = new PaneStatusAnalyzer('claude');
    const typedFrame = `${STATIC_SHELL_ERROR_FRAME}c`;
    const preTyping = [STATIC_SHELL_ERROR_FRAME, STATIC_SHELL_ERROR_FRAME, typedFrame];

    const preTypingStatuses = preTyping.map(
      (capture) => analyzer.analyzeCapture(capture, capture).statusChange,
    );
    expect(preTypingStatuses).toEqual(Array(preTyping.length).fill(undefined));

    // The typed frame itself is already stable capture #1 (its streak was
    // reset to 1 by the typing edit); FIRST_IDLE_STABLE_CAPTURES - 1 more
    // stable repeats reach the full grace window of 8.
    const results = Array.from(
      { length: FIRST_IDLE_STABLE_CAPTURES - 1 },
      () => analyzer.analyzeCapture(typedFrame, typedFrame),
    );

    expect(results.slice(0, results.length - 1).map((r) => r.statusChange)).toEqual(
      Array(results.length - 1).fill(undefined),
    );
    expect(results[results.length - 1].statusChange).toEqual({
      previousStatus: 'idle',
      status: 'idle',
    });
  });

  it('does not infer working from uncorroborated output changes after a typing edit', () => {
    const analyzer = new PaneStatusAnalyzer('claude');
    const typedFrame = `${STATIC_SHELL_ERROR_FRAME}c`;
    const captures = [
      STATIC_SHELL_ERROR_FRAME,
      STATIC_SHELL_ERROR_FRAME,
      typedFrame,
      'Reading files',
      'Editing implementation',
    ];

    const statuses = captures.flatMap(
      (capture) => analyzer.analyzeCapture(capture, capture).statusChange?.status ?? [],
    );

    expect(statuses).toEqual([]);
  });

  it('B: [shell, typed xN] never mints an edge until 8 consecutive stable captures counting the typed frame, then first-idle (reviewer repro: pre-fix working@3/idle@5)', () => {
    const analyzer = new PaneStatusAnalyzer('claude');
    const typedFrame = `${STATIC_SHELL_ERROR_FRAME}c`;

    const shellResult = analyzer.analyzeCapture(STATIC_SHELL_ERROR_FRAME, STATIC_SHELL_ERROR_FRAME);
    expect(shellResult.statusChange).toBeUndefined();

    const results = Array.from(
      { length: FIRST_IDLE_STABLE_CAPTURES },
      () => analyzer.analyzeCapture(typedFrame, typedFrame),
    );

    expect(results.slice(0, results.length - 1).map((r) => r.statusChange)).toEqual(
      Array(results.length - 1).fill(undefined),
    );
    expect(results[results.length - 1].statusChange).toEqual({
      previousStatus: 'idle',
      status: 'idle',
    });
  });

  it('C: [shell x3, typedA, typedB, then typedB stable] restarts the grace window on a SECOND typing edit too (reviewer repro: pre-fix working@6/idle@8)', () => {
    const analyzer = new PaneStatusAnalyzer('claude');
    const typedA = `${STATIC_SHELL_ERROR_FRAME}a`;
    const typedB = `${typedA}b`;
    const preTyping = [
      STATIC_SHELL_ERROR_FRAME,
      STATIC_SHELL_ERROR_FRAME,
      typedA,
      typedB,
    ];

    const preTypingStatuses = preTyping.map(
      (capture) => analyzer.analyzeCapture(capture, capture).statusChange,
    );
    expect(preTypingStatuses).toEqual(Array(preTyping.length).fill(undefined));

    const results = Array.from(
      { length: FIRST_IDLE_STABLE_CAPTURES - 1 },
      () => analyzer.analyzeCapture(typedB, typedB),
    );

    expect(results.slice(0, results.length - 1).map((r) => r.statusChange)).toEqual(
      Array(results.length - 1).fill(undefined),
    );
    expect(results[results.length - 1].statusChange).toEqual({
      previousStatus: 'idle',
      status: 'idle',
    });
  });

  it('D: a second typing edit followed by uncorroborated repainting remains status-silent', () => {
    const analyzer = new PaneStatusAnalyzer('claude');
    const typedA = `${STATIC_SHELL_ERROR_FRAME}a`;
    const typedB = `${typedA}b`;
    const captures = [
      STATIC_SHELL_ERROR_FRAME,
      STATIC_SHELL_ERROR_FRAME,
      typedA,
      typedB,
      'Reading files',
      'Editing implementation',
    ];

    const statuses = captures.flatMap(
      (capture) => analyzer.analyzeCapture(capture, capture).statusChange?.status ?? [],
    );

    expect(statuses).toEqual([]);
  });

  it('E: continuous alternating typing-edit frames stay silent indefinitely (no false working/idle)', () => {
    const analyzer = new PaneStatusAnalyzer('claude');
    const frameA = '> a';
    const frameB = '> ab';

    const results = Array.from(
      { length: 20 },
      (_, index) => analyzer.analyzeCapture(index % 2 === 0 ? frameA : frameB, index % 2 === 0 ? frameA : frameB),
    );

    expect(results.every((r) => r.statusChange === undefined)).toBe(true);
  });
});

describe('PaneStatusAnalyzer reassertion is evidence, not memory', () => {
  it('never restates a remembered status the current frame does not prove', () => {
    // Arrange
    const analyzer = new PaneStatusAnalyzer('claude');
    analyzer.analyzeCapture(WORKING_FRAME, WORKING_FRAME);

    // Act — frames keep changing, so they prove neither working nor stable idle
    const emitted = Array.from({ length: STATUS_REASSERT_CAPTURES * 2 }, (_unused, index) => (
      analyzer.analyzeCapture(`churn-${index}`, `churn-${index}`).statusChange
    )).flatMap((change) => change ?? []);

    // Assert
    expect(emitted).toEqual([]);
  });

  it('restates the status the frame proves rather than the one it remembers', () => {
    // Arrange — analyzer settles idle, then the pane starts working
    const analyzer = new PaneStatusAnalyzer('claude');
    for (let i = 0; i < FIRST_IDLE_STABLE_CAPTURES; i++) analyzer.analyzeCapture(IDLE_FRAME, IDLE_FRAME);

    // Act
    const emitted = Array.from({ length: STATUS_REASSERT_CAPTURES + 1 }, () => (
      analyzer.analyzeCapture(WORKING_FRAME, WORKING_FRAME).statusChange
    )).flatMap((change) => change ?? []);

    // Assert
    expect(emitted).toEqual([
      { previousStatus: 'idle', status: 'working' },
      { previousStatus: 'working', reasserted: true, status: 'working' },
    ]);
  });
});
