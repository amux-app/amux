import { beforeEach, describe, expect, it, vi } from 'vitest';
import { registerAgentSessionHandlers } from '../../src/main/ipc/agent-session.handlers';
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

describe('agent session IPC handlers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns search results from the asynchronous bridge path', async () => {
    const result = [{ messageId: 'message-1' }];
    const bridge = {
      searchAgentSessions: vi.fn().mockResolvedValue(result),
    };
    registerAgentSessionHandlers(bridge as never);

    await expect(getHandler(IPC.AGENT_SESSION_SEARCH)(
      undefined,
      { query: 'message' },
    )).resolves.toBe(result);
  });

  it('returns an empty result when asynchronous index construction fails', async () => {
    const bridge = {
      searchAgentSessions: vi.fn().mockRejectedValue(new Error('index failed')),
    };
    registerAgentSessionHandlers(bridge as never);

    await expect(getHandler(IPC.AGENT_SESSION_SEARCH)(
      undefined,
      { query: 'message' },
    )).resolves.toEqual([]);
  });
});
