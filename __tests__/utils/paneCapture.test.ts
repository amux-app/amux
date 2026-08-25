import { execFile, execFileSync } from 'child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  capturePaneContent,
  capturePaneVisible,
  capturePaneWindow,
  capturePaneWindows,
} from '../../src/utils/paneCapture.js';
import type { AsyncTmuxRunner } from '../../src/utils/paneCapture.js';

vi.mock('child_process', () => ({
  execFile: vi.fn(),
  execFileSync: vi.fn(),
  spawn: vi.fn(),
}));

const EXEC_OPTIONS = { encoding: 'utf8', stdio: 'pipe' };
const PANE_HEIGHT = 24;
const SHRUNK_PANE_HEIGHT = 8;
const HISTORY_LINES = 30;
const WORKING_LINE = '· Germinating… (esc to interrupt · 42s · ↑ 1.2k tokens)';
const WORKING_INDICATOR = /\(esc\s+to\s+interrupt/i;
const COMPOSER_ROWS = [
  '',
  '╭──────────────────────────────────────────╮',
  '│ >                                        │',
  '╰──────────────────────────────────────────╯',
  '  Opus 4.6 · 32% context left',
];

function windowArgs(paneId: string, historyLines: number): string[] {
  return [
    'capture-pane', '-t', paneId, '-p', '-S', `-${historyLines}`,
    ';',
    'display-message', '-p', '-t', paneId, '#{pane_height}',
  ];
}

function numberedRows(prefix: string, count: number): string[] {
  return Array.from({ length: count }, (_, index) => `${prefix} ${index + 1}`);
}

function blankRows(count: number): string[] {
  return Array.from({ length: count }, () => '');
}

function withHeight(rows: string[], paneHeight: number): string {
  return `${[...rows, String(paneHeight)].join('\n')}\n`;
}

function scrollbackRows(staleWorkingLine: boolean): string[] {
  return [
    ...numberedRows('scrollback line', HISTORY_LINES - 2),
    staleWorkingLine ? WORKING_LINE : 'scrollback line 29',
    '⏺ Updated src/utils/paneCapture.ts',
  ];
}

function visibleRows(paneHeight: number, liveWorkingLine: boolean): string[] {
  const head = liveWorkingLine
    ? [WORKING_LINE]
    : ['⏺ Finished the refactor and ran the tests.'];
  return [
    ...head,
    ...COMPOSER_ROWS,
    ...blankRows(paneHeight - head.length - COMPOSER_ROWS.length),
  ];
}

function paneCapture(
  options: { stale?: boolean; live?: boolean; paneHeight?: number } = {}
): string {
  const paneHeight = options.paneHeight ?? PANE_HEIGHT;
  return withHeight(
    [
      ...scrollbackRows(options.stale === true),
      ...visibleRows(paneHeight, options.live === true),
    ],
    paneHeight,
  );
}

function markersOf(args: string[]): string[] {
  const markers: string[] = [];
  for (let index = 0; index < args.length; index++) {
    if (args[index] !== 'display-message' || args[index + 1] !== '-p') continue;
    const marker = args[index + 4];
    if (marker?.startsWith('__MUXBASE_CAPTURE_')) markers.push(marker);
  }
  return markers;
}

function batchResult(args: string[], captures: string[]): string {
  const markers = markersOf(args);
  expect(markers).toHaveLength(captures.length);
  return markers.map((marker, index) => `${marker}\n${captures[index]}`).join('');
}

/**
 * Output of a command list that aborted part-way: only the leading segments
 * were printed, and the last one may be cut mid-row.
 */
function abortedBatchResult(args: string[], captures: string[]): string {
  return markersOf(args)
    .slice(0, captures.length)
    .map((marker, index) => `${marker}\n${captures[index]}`)
    .join('');
}

describe('paneCapture shell-free tmux invocation', () => {
  afterEach(() => {
    vi.mocked(execFileSync).mockReset();
  });

  it('passes the pane id as a literal argv element without shell quoting', () => {
    // Arrange
    vi.mocked(execFileSync).mockReturnValue('visible frame\n');

    // Act
    const content = capturePaneVisible('%42');

    // Assert
    expect(content).toBe('visible frame\n');
    expect(execFileSync).toHaveBeenCalledWith(
      'tmux',
      ['capture-pane', '-t', '%42', '-p'],
      EXEC_OPTIONS,
    );
  });

  it('splits the history window into separate -S and value elements', () => {
    // Arrange
    vi.mocked(execFileSync).mockReturnValue(paneCapture());

    // Act
    capturePaneContent('%7', HISTORY_LINES);

    // Assert
    expect(execFileSync).toHaveBeenCalledWith('tmux', windowArgs('%7', 30), EXEC_OPTIONS);
  });

  it('returns empty output when tmux exits non-zero', () => {
    // Arrange
    vi.mocked(execFileSync).mockImplementation(() => {
      throw new Error("can't find pane: %99");
    });

    // Act & Assert
    expect(capturePaneVisible('%99')).toBe('');
    expect(capturePaneContent('%99')).toBe('');
  });
});

describe('capturePaneWindow visible frame slicing', () => {
  afterEach(() => {
    vi.mocked(execFileSync).mockReset();
  });

  it('derives both windows and the row count from one tmux invocation', () => {
    // Arrange
    vi.mocked(execFileSync).mockReturnValue(paneCapture());

    // Act
    const { content, visibleFrame } = capturePaneWindow('%42', HISTORY_LINES);

    // Assert
    expect(execFileSync).toHaveBeenCalledTimes(1);
    expect(execFileSync).toHaveBeenCalledWith('tmux', windowArgs('%42', 30), EXEC_OPTIONS);
    expect(visibleFrame.split('\n')).toHaveLength(PANE_HEIGHT);
    expect(visibleFrame.split('\n')[0]).toBe('⏺ Finished the refactor and ran the tests.');
    expect(content.startsWith('scrollback line 1\n')).toBe(true);
    expect(content.endsWith('  Opus 4.6 · 32% context left')).toBe(true);
  });

  it('keeps a stale working indicator out of the visible frame', () => {
    // Arrange
    vi.mocked(execFileSync).mockReturnValue(paneCapture({ stale: true }));

    // Act
    const { content, visibleFrame } = capturePaneWindow('%42', HISTORY_LINES);

    // Assert
    expect(WORKING_INDICATOR.test(content)).toBe(true);
    expect(WORKING_INDICATOR.test(visibleFrame)).toBe(false);
  });

  it('keeps a live working indicator inside the visible frame', () => {
    // Arrange
    vi.mocked(execFileSync).mockReturnValue(paneCapture({ stale: true, live: true }));

    // Act
    const { visibleFrame } = capturePaneWindow('%42', HISTORY_LINES);

    // Assert
    expect(WORKING_INDICATOR.test(visibleFrame)).toBe(true);
  });

  it('follows a pane height shrink so scrollback never leaks into the visible frame', () => {
    // Arrange: the pane was tall and working, then shrank with the indicator
    // scrolled out of view.
    vi.mocked(execFileSync)
      .mockReturnValueOnce(paneCapture({ live: true }))
      .mockReturnValueOnce(withHeight(
        [
          ...scrollbackRows(false),
          WORKING_LINE,
          ...visibleRows(SHRUNK_PANE_HEIGHT, false),
        ],
        SHRUNK_PANE_HEIGHT,
      ));

    // Act
    const tall = capturePaneWindow('%42', HISTORY_LINES);
    const shrunk = capturePaneWindow('%42', HISTORY_LINES);

    // Assert
    expect(WORKING_INDICATOR.test(tall.visibleFrame)).toBe(true);
    expect(shrunk.visibleFrame.split('\n')).toHaveLength(SHRUNK_PANE_HEIGHT);
    expect(WORKING_INDICATOR.test(shrunk.content)).toBe(true);
    expect(WORKING_INDICATOR.test(shrunk.visibleFrame)).toBe(false);
  });

  it('returns an empty visible frame when tmux reports no row count', () => {
    // Arrange
    vi.mocked(execFileSync).mockReturnValue(
      `${[...scrollbackRows(false), ...visibleRows(PANE_HEIGHT, false), ''].join('\n')}\n`,
    );

    // Act
    const { content, visibleFrame } = capturePaneWindow('%42', HISTORY_LINES);

    // Assert
    expect(visibleFrame).toBe('');
    expect(content.length).toBeGreaterThan(0);
  });

});

describe('capturePaneContent retry bound', () => {
  afterEach(() => {
    vi.mocked(execFileSync).mockReset();
  });

  it('widens the window at most once when content is sparse', () => {
    // Arrange
    const sparse = withHeight([...numberedRows('line', 4), ...blankRows(20)], PANE_HEIGHT);
    vi.mocked(execFileSync).mockReturnValue(sparse);

    // Act
    const content = capturePaneContent('%1', HISTORY_LINES);

    // Assert
    expect(execFileSync).toHaveBeenCalledTimes(2);
    expect(vi.mocked(execFileSync).mock.calls[1][1]).toEqual(windowArgs('%1', 70));
    expect(content).toBe(numberedRows('line', 4).join('\n'));
  });

  it('gives up after one widened retry on a blank pane', () => {
    // Arrange
    vi.mocked(execFileSync).mockReturnValue(withHeight(blankRows(24), PANE_HEIGHT));

    // Act
    const content = capturePaneContent('%1', HISTORY_LINES);

    // Assert
    expect(content).toBe('');
    expect(execFileSync).toHaveBeenCalledTimes(2);
    expect(vi.mocked(execFileSync).mock.calls[1][1]).toEqual(windowArgs('%1', 200));
  });

  it('returns on the first invocation when the window already has enough content', () => {
    // Arrange
    vi.mocked(execFileSync).mockReturnValue(paneCapture());

    // Act
    capturePaneContent('%1', HISTORY_LINES);

    // Assert
    expect(execFileSync).toHaveBeenCalledTimes(1);
  });
});

describe('capturePaneWindows batching', () => {
  afterEach(() => {
    vi.mocked(execFile).mockReset();
  });

  it('bounds the default async tmux invocation with the command timeout', async () => {
    const observedOptions: unknown[] = [];
    vi.mocked(execFile).mockImplementation((_file, args, options, callback) => {
      observedOptions.push(options);
      callback(null, batchResult(args as string[], [paneCapture()]), '');
      return {} as ReturnType<typeof execFile>;
    });

    await capturePaneWindows([{ lines: HISTORY_LINES, paneId: '%1' }]);

    expect(execFile).toHaveBeenCalledOnce();
    expect(observedOptions).toEqual([
      expect.objectContaining({ timeout: 1000 }),
    ]);
  });

  it('captures multiple panes through one tmux invocation', async () => {
    const runTmux: AsyncTmuxRunner = vi.fn(async (args) => batchResult(args, [
      paneCapture(),
      paneCapture({ live: true }),
    ]));

    const result = await capturePaneWindows([
      { lines: HISTORY_LINES, paneId: '%1' },
      { lines: HISTORY_LINES, paneId: '%2' },
    ], runTmux);

    expect(runTmux).toHaveBeenCalledTimes(1);
    expect(result.tmuxInvocations).toBe(1);
    expect(result.captures.get('%1')?.content).toContain('scrollback line 1');
    expect(result.captures.get('%2')?.visibleFrame).toContain(WORKING_LINE);
  });

  it('requests pane height in the same chained display-message per pane', async () => {
    const runTmux: AsyncTmuxRunner = vi.fn(async (args) => batchResult(args, [paneCapture()]));

    await capturePaneWindows([{ lines: HISTORY_LINES, paneId: '%1' }], runTmux);

    expect(vi.mocked(runTmux).mock.calls[0][0]).toContain('#{pane_height}');
    expect(vi.mocked(runTmux).mock.calls[0][0]).not.toContain('#{pane_current_command}');
  });

  it('derives the original analysis tail from the larger one-pass capture', async () => {
    const deepCapture = withHeight([
      ...numberedRows('deep history', 200),
      ...visibleRows(PANE_HEIGHT, false),
    ], PANE_HEIGHT);
    const runTmux: AsyncTmuxRunner = vi.fn(async (args: string[]) =>
      batchResult(args, [deepCapture]));

    const result = await capturePaneWindows([
      { lines: HISTORY_LINES, paneId: '%1' },
    ], runTmux);

    const capture = result.captures.get('%1');
    expect(runTmux).toHaveBeenCalledOnce();
    expect(capture?.content.startsWith('deep history 171\n')).toBe(true);
    expect(capture?.content).not.toContain('deep history 170\n');
    expect(capture?.visibleFrame.split('\n')).toHaveLength(PANE_HEIGHT);
  });

  it('captures sparse panes in one bounded batch without a routine retry process', async () => {
    const sparse = withHeight([...numberedRows('line', 4), ...blankRows(20)], PANE_HEIGHT);
    const runTmux: AsyncTmuxRunner = vi.fn(async (args: string[]) =>
      batchResult(args, [sparse, paneCapture()]));

    const result = await capturePaneWindows([
      { lines: HISTORY_LINES, paneId: '%1' },
      { lines: HISTORY_LINES, paneId: '%2' },
    ], runTmux);

    expect(runTmux).toHaveBeenCalledOnce();
    expect(result.tmuxInvocations).toBe(1);
    expect(vi.mocked(runTmux).mock.calls[0][0]).toContain('-200');
    expect(result.captures.get('%1')?.content).toBe(numberedRows('line', 4).join('\n'));
    expect(result.captures.get('%1')?.visibleFrame.split('\n')).toHaveLength(PANE_HEIGHT);
  });

  it('captures blank panes in one bounded batch', async () => {
    const blank = withHeight(blankRows(PANE_HEIGHT), PANE_HEIGHT);
    const runTmux: AsyncTmuxRunner = vi.fn(async (args: string[]) =>
      batchResult(args, [blank]));

    const result = await capturePaneWindows([
      { lines: HISTORY_LINES, paneId: '%1' },
    ], runTmux);

    expect(runTmux).toHaveBeenCalledOnce();
    expect(result.tmuxInvocations).toBe(1);
    expect(result.captures.get('%1')).toEqual({ content: '', visibleFrame: blankRows(PANE_HEIGHT).join('\n') });
  });

  it('recovers live panes concurrently and does not retry a confirmed failed pane', async () => {
    let activeFallbacks = 0;
    let maxActiveFallbacks = 0;
    let invocation = 0;
    const runTmux: AsyncTmuxRunner = vi.fn(async () => {
      const currentInvocation = ++invocation;
      if (currentInvocation === 1) throw new Error("can't find pane: %gone");

      activeFallbacks++;
      maxActiveFallbacks = Math.max(maxActiveFallbacks, activeFallbacks);
      await new Promise((resolve) => setTimeout(resolve, 5));
      activeFallbacks--;
      if (currentInvocation === 2) return paneCapture();
      throw new Error("can't find pane: %gone");
    });

    const result = await capturePaneWindows([
      { lines: HISTORY_LINES, paneId: '%live' },
      { lines: HISTORY_LINES, paneId: '%gone' },
    ], runTmux);

    expect(result.tmuxInvocations).toBe(3);
    expect(maxActiveFallbacks).toBe(2);
    expect(result.captures.get('%live')?.content).toContain('scrollback line 1');
    expect(result.captures.get('%gone')).toEqual({ content: '', visibleFrame: '' });
  });

  it('keeps the panes tmux printed before the command list failed', async () => {
    // Arrange: the list aborts on the second pane, after printing the first.
    let invocation = 0;
    vi.mocked(execFile).mockImplementation((_file, args, _options, callback) => {
      const failure = new Error("can't find pane: %gone");
      const stdout = ++invocation === 1
        ? abortedBatchResult(args as string[], [paneCapture(), ''])
        : '';
      callback(failure, stdout, '');
      return {} as ReturnType<typeof execFile>;
    });

    // Act
    const result = await capturePaneWindows([
      { lines: HISTORY_LINES, paneId: '%1' },
      { lines: HISTORY_LINES, paneId: '%gone' },
    ]);

    // Assert
    expect(result.captures.get('%1')?.content).toContain('scrollback line 1');
    expect(result.captures.get('%1')?.visibleFrame.split('\n')).toHaveLength(PANE_HEIGHT);
    expect(result.captures.get('%gone')).toEqual({ content: '', visibleFrame: '' });
    expect(result.tmuxInvocations).toBe(2);
  });

  it('recaptures the trailing pane when its segment was cut mid-row', async () => {
    // Arrange: the final segment lost its pane height row to the truncation.
    let invocation = 0;
    const runTmux: AsyncTmuxRunner = vi.fn(async (args: string[]) => {
      if (++invocation === 1) {
        return abortedBatchResult(args, [paneCapture(), 'scrollback line 1\nscrollback li']);
      }
      return paneCapture({ live: true });
    });

    // Act
    const result = await capturePaneWindows([
      { lines: HISTORY_LINES, paneId: '%1' },
      { lines: HISTORY_LINES, paneId: '%2' },
    ], runTmux);

    // Assert
    expect(result.tmuxInvocations).toBe(2);
    expect(vi.mocked(runTmux).mock.calls[1][0]).toEqual(windowArgs('%2', 200));
    expect(result.captures.get('%1')?.content).toContain('scrollback line 1');
    expect(result.captures.get('%2')?.visibleFrame).toContain(WORKING_LINE);
  });
});
