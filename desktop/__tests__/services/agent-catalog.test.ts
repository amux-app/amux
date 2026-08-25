import type { AgentName } from 'muxbase/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const getAvailableAgentsMock = vi.hoisted(() => vi.fn());

vi.mock('muxbase/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('muxbase/core')>();
  return {
    ...actual,
    getAvailableAgents: getAvailableAgentsMock,
  };
});

import { AgentCatalog } from '../../src/main/services/bridge/AgentCatalog';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

describe('AgentCatalog', () => {
  beforeEach(() => {
    getAvailableAgentsMock.mockReset();
  });

  it('serves a replaced cache without probing executables', async () => {
    const catalog = new AgentCatalog();
    catalog.replace(['claude', 'codex']);

    await expect(catalog.getAvailable()).resolves.toEqual(['claude', 'codex']);
    expect(catalog.getCached()).toEqual(['claude', 'codex']);
    expect(getAvailableAgentsMock).not.toHaveBeenCalled();
  });

  it('coalesces concurrent detection and returns defensive copies', async () => {
    const detection = deferred<AgentName[]>();
    getAvailableAgentsMock.mockReturnValue(detection.promise);
    const catalog = new AgentCatalog();

    const first = catalog.getAvailable();
    const second = catalog.refresh();
    detection.resolve(['claude']);

    const [firstAgents, secondAgents] = await Promise.all([first, second]);
    firstAgents.push('codex');
    expect(secondAgents).toEqual(['claude']);
    expect(catalog.getCached()).toEqual(['claude']);
    expect(getAvailableAgentsMock).toHaveBeenCalledTimes(1);
  });

  it('clears the cached identity and detects again on the next read', async () => {
    getAvailableAgentsMock.mockResolvedValueOnce(['claude']).mockResolvedValueOnce(['codex']);
    const catalog = new AgentCatalog();

    await expect(catalog.getAvailable()).resolves.toEqual(['claude']);
    catalog.clear();
    expect(catalog.hasCached()).toBe(false);
    await expect(catalog.getAvailable()).resolves.toEqual(['codex']);
    expect(getAvailableAgentsMock).toHaveBeenCalledTimes(2);
  });

  it('clears a failed in-flight detection so a later request can retry', async () => {
    const failed = new Error('probe failed');
    getAvailableAgentsMock.mockRejectedValueOnce(failed).mockResolvedValueOnce(['pi']);
    const catalog = new AgentCatalog();

    await expect(catalog.getAvailable()).rejects.toBe(failed);
    await expect(catalog.getAvailable()).resolves.toEqual(['pi']);
    expect(getAvailableAgentsMock).toHaveBeenCalledTimes(2);
  });

  it('forwards explicit identity refreshes to executable discovery', async () => {
    getAvailableAgentsMock.mockResolvedValue(['claude']);
    const catalog = new AgentCatalog();

    await catalog.refresh();

    expect(getAvailableAgentsMock).toHaveBeenCalledWith({ refreshIdentity: true });
  });
});
