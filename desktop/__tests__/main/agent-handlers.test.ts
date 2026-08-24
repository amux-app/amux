import { beforeEach, describe, expect, it, vi } from 'vitest';
import { registerAgentHandlers } from '../../src/main/ipc/agent.handlers';
import { IPC } from '../../src/shared/ipc-channels';

const secureHandleMock = vi.hoisted(() => vi.fn());

vi.mock('../../src/main/ipc/ipc-security.js', () => ({
  secureHandle: (
    channel: string,
    handler: (...args: unknown[]) => unknown,
    options?: unknown,
  ) => secureHandleMock(channel, handler, options),
}));

function getHandler(channel: string): (...args: unknown[]) => unknown {
  const registration = secureHandleMock.mock.calls.find(([registered]) => registered === channel);
  if (!registration) throw new Error(`missing handler registration for ${channel}`);
  return registration[1] as (...args: unknown[]) => unknown;
}

describe('agent IPC handlers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('keeps list reads cached and exposes an explicit refresh path', async () => {
    const bridge = {
      getAvailableAgents: vi.fn(async () => ['claude']),
      refreshAvailableAgents: vi.fn(async () => ['claude', 'codex']),
    };
    registerAgentHandlers(bridge as never);

    await expect(getHandler(IPC.AGENT_LIST)()).resolves.toEqual(['claude']);
    await expect(getHandler(IPC.AGENT_REFRESH)()).resolves.toEqual(['claude', 'codex']);

    expect(bridge.getAvailableAgents).toHaveBeenCalledOnce();
    expect(bridge.refreshAvailableAgents).toHaveBeenCalledOnce();
  });

  it('passes a requested capability to the bridge', async () => {
    const bridge = {
      getAvailableAgents: vi.fn(async () => ['claude', 'codex']),
      refreshAvailableAgents: vi.fn(async () => ['claude', 'codex']),
    };
    registerAgentHandlers(bridge as never);

    await getHandler(IPC.AGENT_LIST)(undefined, { capability: 'review' });
    await getHandler(IPC.AGENT_REFRESH)(undefined, { capability: 'launch' });

    expect(bridge.getAvailableAgents).toHaveBeenCalledWith('review');
    expect(bridge.refreshAvailableAgents).toHaveBeenCalledWith('launch');
  });
});
