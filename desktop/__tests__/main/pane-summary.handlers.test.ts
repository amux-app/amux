import { beforeEach, describe, expect, it, vi } from 'vitest';
import { registerPaneSummaryHandlers } from '../../src/main/ipc/pane-summary.handlers.js';
import { IPC } from '../../src/shared/ipc-channels.js';

const secureHandleMock = vi.hoisted(() => vi.fn());
vi.mock('../../src/main/ipc/ipc-security.js', () => ({
  secureHandle: (channel: string, handler: unknown) => secureHandleMock(channel, handler),
}));
vi.mock('../../src/main/services/Logger.js', () => ({
  log: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

function handler(channel: string): (...args: unknown[]) => Promise<unknown> {
  const registration = secureHandleMock.mock.calls.find(([name]) => name === channel);
  if (!registration) throw new Error(`No handler for ${channel}`);
  return registration[1] as (...args: unknown[]) => Promise<unknown>;
}

const summary = { paneId: 'pane-1', status: 'fresh' };

describe('pane summary IPC handlers', () => {
  beforeEach(() => secureHandleMock.mockClear());

  it('returns safe no-project responses without touching a service', async () => {
    registerPaneSummaryHandlers({
      getPaneSummaryService: () => undefined,
    } as never);
    await expect(handler(IPC.PANE_SUMMARY_LOAD_ALL)()).resolves.toEqual({
      summaries: [],
    });
    await expect(
      handler(IPC.PANE_SUMMARY_REFRESH_ONE)(undefined, {
        force: false,
        paneId: 'pane-1',
      }),
    ).resolves.toEqual({ error: 'No active project' });
    await expect(handler(IPC.PANE_SUMMARY_REMOVE)(undefined, { paneId: 'pane-1' })).resolves.toEqual({ ok: false });
  });

  it('rejects unsafe single-pane IDs before service access', async () => {
    const service = {
      refreshOne: vi.fn(),
      generateRecapOne: vi.fn(),
      removeForPane: vi.fn(),
    };
    registerPaneSummaryHandlers({
      getPaneSummaryService: () => service,
    } as never);
    for (const paneId of ['', '../secret', 'x'.repeat(129), 'pane id']) {
      await expect(
        handler(IPC.PANE_SUMMARY_REFRESH_ONE)(undefined, {
          force: true,
          paneId,
        }),
      ).resolves.toEqual({ error: 'Invalid pane id' });
      await expect(
        handler(IPC.PANE_SUMMARY_GENERATE_RECAP_ONE)(undefined, {
          force: true,
          paneId,
        }),
      ).resolves.toEqual({ error: 'Invalid pane id' });
    }
    expect(service.refreshOne).not.toHaveBeenCalled();
    expect(service.generateRecapOne).not.toHaveBeenCalled();
  });

  it('filters unsafe IDs from batch operations and preserves safe IDs', async () => {
    const service = {
      generateRecapMany: vi.fn().mockResolvedValue([summary]),
      refreshMany: vi.fn().mockResolvedValue([summary]),
    };
    registerPaneSummaryHandlers({
      getPaneSummaryService: () => service,
    } as never);

    await expect(
      handler(IPC.PANE_SUMMARY_REFRESH_MANY)(undefined, {
        force: true,
        paneIds: ['pane-1', '../bad', 'pane_2'],
      }),
    ).resolves.toEqual({ summaries: [summary] });
    await expect(
      handler(IPC.PANE_SUMMARY_GENERATE_RECAP_MANY)(undefined, {
        force: false,
        paneIds: ['pane-1', 'bad id'],
      }),
    ).resolves.toEqual({ summaries: [summary] });
    expect(service.refreshMany).toHaveBeenCalledWith(['pane-1', 'pane_2'], true);
    expect(service.generateRecapMany).toHaveBeenCalledWith(['pane-1'], false);
  });

  it('maps missing panes and successful removal to stable result shapes', async () => {
    const service = {
      generateRecapOne: vi.fn().mockResolvedValue(null),
      refreshOne: vi.fn().mockResolvedValue(null),
      removeForPane: vi.fn().mockResolvedValue(undefined),
    };
    registerPaneSummaryHandlers({
      getPaneSummaryService: () => service,
    } as never);
    await expect(
      handler(IPC.PANE_SUMMARY_REFRESH_ONE)(undefined, {
        force: false,
        paneId: 'pane-1',
      }),
    ).resolves.toEqual({ error: 'Pane not found' });
    await expect(
      handler(IPC.PANE_SUMMARY_GENERATE_RECAP_ONE)(undefined, {
        force: false,
        paneId: 'pane-1',
      }),
    ).resolves.toEqual({ error: 'Pane not found' });
    await expect(handler(IPC.PANE_SUMMARY_REMOVE)(undefined, { paneId: 'pane-1' })).resolves.toEqual({ ok: true });
    expect(service.removeForPane).toHaveBeenCalledWith('pane-1');
  });
});
