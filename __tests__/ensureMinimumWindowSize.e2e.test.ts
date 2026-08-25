import { describe, it, expect, beforeEach } from 'vitest';
import { execSync } from 'child_process';

describe.runIf(process.env.MUXBASE_TMUX_E2E === '1')('ensureMinimumWindowSize (E2E tmux)', () => {
  const TEST_SESSION = 'muxbase-test-window-size';

  function tmux(cmd: string): string {
    return execSync(`tmux ${cmd}`, { encoding: 'utf-8' }).trim();
  }

  function getWindowSize(paneId: string): { width: number; height: number } {
    const output = tmux(`display-message -t '${paneId}' -p "#{window_width} #{window_height}"`);
    const [w, h] = output.split(' ').map(Number);
    return { width: w, height: h };
  }

  let paneId: string;

  beforeEach(() => {
    try { tmux(`kill-session -t ${TEST_SESSION}`); } catch { /* ignore */ }
    tmux(`new-session -d -s ${TEST_SESSION} -x 40 -y 10`);
    paneId = tmux(`list-panes -t ${TEST_SESSION} -F "#{pane_id}"`).split('\n')[0];
  });

  it('detects a small window and resizes it above minimum', async () => {
    const { ensureMinimumWindowSize, SIDEBAR_WIDTH, MIN_COMFORTABLE_WIDTH, MIN_COMFORTABLE_HEIGHT } = await import('../src/utils/tmux.js');
    const minWidth = SIDEBAR_WIDTH + MIN_COMFORTABLE_WIDTH + 1;

    const before = getWindowSize(paneId);
    expect(before.width).toBe(40);
    expect(before.height).toBe(10);

    ensureMinimumWindowSize(paneId);

    const after = getWindowSize(paneId);
    expect(after.width).toBeGreaterThanOrEqual(minWidth);
    expect(after.height).toBeGreaterThanOrEqual(MIN_COMFORTABLE_HEIGHT);
    try { tmux(`kill-session -t ${TEST_SESSION}`); } catch { /* ignore */ }
  });

  it('does not shrink an already-large-enough window', async () => {
    const { ensureMinimumWindowSize } = await import('../src/utils/tmux.js');
    tmux(`resize-window -t '${paneId}' -x 200 -y 50`);
    const before = getWindowSize(paneId);

    ensureMinimumWindowSize(paneId);

    const after = getWindowSize(paneId);
    expect(after.width).toBe(before.width);
    expect(after.height).toBe(before.height);
    try { tmux(`kill-session -t ${TEST_SESSION}`); } catch { /* ignore */ }
  });
});
