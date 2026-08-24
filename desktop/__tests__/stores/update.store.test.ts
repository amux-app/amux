import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppUpdateSnapshot } from '../../src/shared/app-update-types';

const updateApi = vi.hoisted(() => ({
  getUpdateState: vi.fn(),
  subscribeToUpdateState: vi.fn(),
}));

vi.mock('../../src/renderer/api/update.api', () => updateApi);

import {
  selectUpdateControlVisible,
  selectUpdateProgressPercent,
  useUpdateStore,
} from '../../src/renderer/stores/update.store';

const idleSnapshot: AppUpdateSnapshot = {
  currentVersion: '0.1.0',
  phase: 'idle',
  revision: 1,
};

describe('update store', () => {
  beforeEach(() => {
    updateApi.getUpdateState.mockReset();
    updateApi.subscribeToUpdateState.mockReset();
    useUpdateStore.getState().reset();
  });

  afterEach(() => {
    useUpdateStore.getState().reset();
  });

  it('subscribes before hydration and keeps a newer event over an older response', async () => {
    const order: string[] = [];
    let eventListener: ((payload: unknown) => void) | undefined;
    let resolveHydration: ((snapshot: AppUpdateSnapshot) => void) | undefined;
    updateApi.subscribeToUpdateState.mockImplementation((listener: (payload: unknown) => void) => {
      order.push('subscribe');
      eventListener = listener;
      return vi.fn();
    });
    updateApi.getUpdateState.mockImplementation(() => {
      order.push('hydrate');
      return new Promise<AppUpdateSnapshot>((resolve) => { resolveHydration = resolve; });
    });

    const initialization = useUpdateStore.getState().initialize();
    eventListener?.({
      availableVersion: '0.2.0',
      currentVersion: '0.1.0',
      phase: 'ready',
      revision: 2,
    });
    resolveHydration?.(idleSnapshot);
    await initialization;

    expect(order).toEqual(['subscribe', 'hydrate']);
    expect(useUpdateStore.getState().snapshot).toMatchObject({ phase: 'ready', revision: 2 });
  });

  it('ignores invalid, duplicate, and stale snapshots', () => {
    const store = useUpdateStore.getState();

    expect(store.applySnapshot(idleSnapshot)).toBe(true);
    expect(store.applySnapshot({ ...idleSnapshot, revision: 1 })).toBe(false);
    expect(store.applySnapshot({ ...idleSnapshot, revision: 0 })).toBe(false);
    expect(store.applySnapshot({ phase: 'ready', revision: 9, rawError: new Error('secret') }))
      .toBe(false);
    expect(useUpdateStore.getState().snapshot).toEqual(idleSnapshot);
  });

  it('derives control visibility and clamped presentation progress from the snapshot', () => {
    expect(selectUpdateControlVisible({ snapshot: idleSnapshot })).toBe(false);
    expect(selectUpdateControlVisible({
      snapshot: {
        availableVersion: '0.2.0',
        currentVersion: '0.1.0',
        phase: 'ready',
        revision: 2,
      },
    })).toBe(true);
    expect(selectUpdateProgressPercent({
      snapshot: {
        availableVersion: '0.2.0',
        currentVersion: '0.1.0',
        phase: 'downloading',
        progress: { bytesPerSecond: 10, percent: 42.4, total: 100, transferred: 42 },
        revision: 3,
      },
    })).toBe(42.4);
  });

  it('unsubscribes and clears module-level initialization state on reset', async () => {
    const unsubscribe = vi.fn();
    updateApi.subscribeToUpdateState.mockReturnValue(unsubscribe);
    updateApi.getUpdateState.mockResolvedValue(idleSnapshot);

    await useUpdateStore.getState().initialize();
    useUpdateStore.getState().reset();

    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(useUpdateStore.getState().snapshot).toBeNull();
  });
});
