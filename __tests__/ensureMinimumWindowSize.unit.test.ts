import { describe, it, expect, vi, beforeEach } from 'vitest';
import { execFileSync } from 'child_process';

vi.mock('child_process', () => ({
  execFile: vi.fn(),
  execFileSync: vi.fn(),
  spawn: vi.fn(),
}));

const mockExecFileSync = vi.mocked(execFileSync);
const HOSTILE_PANE_ID = "%1' -x 1 -y 1 ; touch /tmp/aumx-window-injected ; tmux display-message -t '%1";

describe('ensureMinimumWindowSize (unit)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it('does not resize when window meets minimum dimensions', async () => {
    mockExecFileSync.mockReturnValueOnce('200 40');

    const { ensureMinimumWindowSize } = await import('../src/utils/tmux.js');
    ensureMinimumWindowSize('%1');

    expect(mockExecFileSync).toHaveBeenCalledTimes(1);
    expect(mockExecFileSync).not.toHaveBeenCalledWith(
      'tmux',
      expect.arrayContaining(['resize-window']),
      expect.anything()
    );
  });

  it('resizes window width when below minimum', async () => {
    mockExecFileSync.mockReturnValueOnce('50 40');
    mockExecFileSync.mockReturnValueOnce('');

    const { ensureMinimumWindowSize, SIDEBAR_WIDTH, MIN_COMFORTABLE_WIDTH } = await import('../src/utils/tmux.js');
    ensureMinimumWindowSize('%1');

    const minWidth = SIDEBAR_WIDTH + MIN_COMFORTABLE_WIDTH + 1;
    expect(mockExecFileSync).toHaveBeenCalledTimes(2);
    expect(mockExecFileSync).toHaveBeenLastCalledWith(
      'tmux',
      ['resize-window', '-t', '%1', '-x', String(minWidth), '-y', '40'],
      expect.anything()
    );
  });

  it('resizes window height when below minimum', async () => {
    mockExecFileSync.mockReturnValueOnce('200 5');
    mockExecFileSync.mockReturnValueOnce('');

    const { ensureMinimumWindowSize, MIN_COMFORTABLE_HEIGHT } = await import('../src/utils/tmux.js');
    ensureMinimumWindowSize('%1');

    expect(mockExecFileSync).toHaveBeenCalledTimes(2);
    expect(mockExecFileSync).toHaveBeenLastCalledWith(
      'tmux',
      ['resize-window', '-t', '%1', '-x', '200', '-y', String(MIN_COMFORTABLE_HEIGHT)],
      expect.anything()
    );
  });

  it('does nothing when display-message returns unparseable output', async () => {
    mockExecFileSync.mockReturnValueOnce('');

    const { ensureMinimumWindowSize } = await import('../src/utils/tmux.js');
    ensureMinimumWindowSize('%1');

    expect(mockExecFileSync).toHaveBeenCalledTimes(1);
  });

  it('silently handles command errors', async () => {
    mockExecFileSync.mockImplementationOnce(() => { throw new Error('tmux not running'); });

    const { ensureMinimumWindowSize } = await import('../src/utils/tmux.js');
    expect(() => ensureMinimumWindowSize('%1')).not.toThrow();
  });

  it('passes a hostile pane id as one literal argv entry instead of a shell string', async () => {
    mockExecFileSync.mockReturnValueOnce('50 5');
    mockExecFileSync.mockReturnValueOnce('');

    const { ensureMinimumWindowSize } = await import('../src/utils/tmux.js');
    ensureMinimumWindowSize(HOSTILE_PANE_ID);

    for (const [file, args] of mockExecFileSync.mock.calls) {
      expect(file).toBe('tmux');
      expect(args).toContain(HOSTILE_PANE_ID);
      expect(args?.filter(arg => arg === HOSTILE_PANE_ID)).toHaveLength(1);
    }
  });
});
