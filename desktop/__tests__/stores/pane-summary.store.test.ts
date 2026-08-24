import { beforeEach, describe, expect, it, vi } from 'vitest';
import { usePaneSummaryStore } from '../../src/renderer/stores/pane-summary.store';
import * as api from '../../src/renderer/api/pane-summary.api';
import type { PaneSummary } from '../../src/shared/pane-summary-types';

vi.mock('../../src/renderer/api/pane-summary.api', () => ({
  generatePaneSummaryRecap: vi.fn(),
  generatePaneSummaryRecapMany: vi.fn(),
  loadAllPaneSummaries: vi.fn(),
  refreshPaneSummariesMany: vi.fn(),
  refreshPaneSummary: vi.fn(),
}));

function summary(paneId: string, generatedAt = Date.now()): PaneSummary {
  return {
    agent: 'codex',
    branch: 'main',
    generatedAt,
    gitActivity: null,
    paneId,
    paneName: paneId,
    recap: '',
    recapStatus: 'idle',
    startedAt: generatedAt,
    status: 'fresh',
    worktreePath: null,
  };
}

describe('pane summary store workflows', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    usePaneSummaryStore.getState().reset();
  });

  it('marks expired hydrated summaries stale', async () => {
    const old = summary('old', Date.now() - 11 * 60 * 1000);
    vi.mocked(api.loadAllPaneSummaries).mockResolvedValue([old]);
    await usePaneSummaryStore.getState().hydrate();
    expect(usePaneSummaryStore.getState().summaries.old.status).toBe('stale');
    expect(usePaneSummaryStore.getState().hydrated).toBe(true);
  });

  it('suppresses duplicate per-pane refresh and clears the in-flight id after success', async () => {
    let resolve!: (value: { summary: PaneSummary }) => void;
    vi.mocked(api.refreshPaneSummary).mockReturnValue(
      new Promise((r) => {
        resolve = r;
      }),
    );
    const first = usePaneSummaryStore.getState().refreshOne('pane-1', true);
    const second = usePaneSummaryStore.getState().refreshOne('pane-1', true);
    expect(api.refreshPaneSummary).toHaveBeenCalledOnce();
    resolve({ summary: summary('pane-1') });
    await Promise.all([first, second]);
    expect(usePaneSummaryStore.getState().refreshingIds).not.toContain('pane-1');
    expect(usePaneSummaryStore.getState().summaries['pane-1']).toBeDefined();
  });

  it('clears in-flight recap ids after rejection', async () => {
    vi.mocked(api.generatePaneSummaryRecap).mockRejectedValue(new Error('recap unavailable'));
    await expect(usePaneSummaryStore.getState().generateRecapOne('pane-1', true)).rejects.toThrow('recap unavailable');
    expect(usePaneSummaryStore.getState().recapInFlightIds).not.toContain('pane-1');
  });

  it('updates only summaries returned by a batch refresh', async () => {
    vi.mocked(api.refreshPaneSummariesMany).mockResolvedValue({
      summaries: [summary('pane-1')],
    });
    usePaneSummaryStore.getState().applyUpdate(summary('pane-2'));
    await usePaneSummaryStore.getState().refreshAll(['pane-1', 'pane-2'], false);
    expect(Object.keys(usePaneSummaryStore.getState().summaries).sort()).toEqual(['pane-1', 'pane-2']);
    expect(usePaneSummaryStore.getState().lastRefreshAllAt).not.toBeNull();
    expect(usePaneSummaryStore.getState().refreshingIds.size).toBe(0);
  });

  it('isolates apply and remove operations by pane', () => {
    usePaneSummaryStore.getState().applyUpdate(summary('pane-1'));
    usePaneSummaryStore.getState().applyUpdate(summary('pane-2'));
    usePaneSummaryStore.getState().applyRemove('pane-1');
    expect(usePaneSummaryStore.getState().summaries).toEqual({
      'pane-2': expect.any(Object),
    });
  });
});
