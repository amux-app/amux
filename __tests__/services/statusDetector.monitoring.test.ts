import { afterEach, describe, expect, it, vi } from 'vitest';
import { FIRST_IDLE_STABLE_CAPTURES } from '../../src/constants/timing.js';
import type { PaneStatusChange } from '../../src/services/PaneStatusAnalyzer.js';
import { PaneStatusAnalyzer } from '../../src/services/PaneStatusAnalyzer.js';
import { selectStatusMonitoredPanes, StatusDetector } from '../../src/services/StatusDetector.js';
import type { MuxBasePane } from '../../src/types.js';

function handleChange(detector: StatusDetector, paneId: string, change: PaneStatusChange): void {
  Reflect.get(detector, 'handleStatusChange').call(detector, paneId, change);
}

afterEach(() => {
  vi.restoreAllMocks();
});

function makePane(overrides: Partial<MuxBasePane>): MuxBasePane {
  return {
    id: 'pane',
    paneId: '%1',
    prompt: '',
    slug: 'pane',
    ...overrides,
  };
}

describe('status monitoring pane selection', () => {
  it('keeps agent panes and excludes plain shell panes', () => {
    const claudePane = makePane({ agent: 'claude', id: 'claude', type: 'worktree' });
    const codexPane = makePane({ agent: 'codex', id: 'codex' });
    const shellPane = makePane({ id: 'shell', type: 'shell' });
    const inconsistentShellPane = makePane({ agent: 'opencode', id: 'agent-shell', type: 'shell' });

    expect(selectStatusMonitoredPanes([
      shellPane,
      claudePane,
      inconsistentShellPane,
      codexPane,
    ])).toEqual([claudePane, codexPane]);
  });

  it('forwards only agent panes and an empty set when the last agent pane is removed', async () => {
    const detector = new StatusDetector();
    const updateAnalyzers = vi.fn();
    Reflect.set(detector, 'statusManager', { updateAnalyzers });
    const agentPane = makePane({ agent: 'codex', id: 'agent', type: 'worktree' });
    const shellPane = makePane({ id: 'shell', type: 'shell' });

    await detector.monitorPanes([agentPane, shellPane]);
    await detector.monitorPanes([shellPane]);

    expect(updateAnalyzers).toHaveBeenNthCalledWith(1, [agentPane]);
    expect(updateAnalyzers).toHaveBeenNthCalledWith(2, []);
  });
});

describe('StatusDetector status-updated emission', () => {
  it('emits on a content-status edge', () => {
    const detector = new StatusDetector();
    const listener = vi.fn();
    detector.on('status-updated', listener);

    handleChange(detector, 'pane-1', { previousStatus: 'idle', status: 'working' });

    expect(listener).toHaveBeenCalledWith({
      paneId: 'pane-1',
      status: 'working',
      previousStatus: 'idle',
    });
  });

});

describe('StatusDetector integration with a real analyzer (corroborated idle)', () => {
  it('emits nothing while the analyzer produces no edges, then publishes the first idle edge', () => {
    const detector = new StatusDetector();
    const analyzer = new PaneStatusAnalyzer('claude');
    const listener = vi.fn();
    detector.on('status-updated', listener);
    const staticShellErrorFrame = 'bash: claude: command not found';

    for (let i = 0; i < FIRST_IDLE_STABLE_CAPTURES - 1; i++) {
      const result = analyzer.analyzeCapture(staticShellErrorFrame, staticShellErrorFrame);
      if (result.statusChange) handleChange(detector, 'pane-1', result.statusChange);
    }

    expect(listener).not.toHaveBeenCalled();

    const finalResult = analyzer.analyzeCapture(staticShellErrorFrame, staticShellErrorFrame);
    if (finalResult.statusChange) handleChange(detector, 'pane-1', finalResult.statusChange);

    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith({
      paneId: 'pane-1',
      status: 'idle',
      previousStatus: 'idle',
    });
  });
});
