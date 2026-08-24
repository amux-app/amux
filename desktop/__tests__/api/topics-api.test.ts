import { beforeEach, describe, expect, it, vi } from 'vitest';
import { listTopics } from '../../src/renderer/api/topics.api';
import { IPC } from '../../src/shared/ipc-channels';

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock('../../src/renderer/api/ipc.js', () => ({ invoke: invokeMock }));

const topic = {
  agent: 'claude',
  paneId: 'pane-1',
  sessionId: 'session-1',
  topics: [
    {
      endTime: 2,
      id: 'topic-1',
      label: 'Fix parser',
      messageCount: 1,
      messageEndIndex: 0,
      messageStartIndex: 0,
      refined: true,
      startTime: 1,
    },
  ],
  updatedAt: 3,
};

describe('topics API response validation', () => {
  beforeEach(() => invokeMock.mockReset());

  it('extracts and filters topic payloads', async () => {
    invokeMock.mockResolvedValue({ topics: [topic, { ...topic, paneId: 42 }] });
    await expect(listTopics()).resolves.toEqual([topic]);
    expect(invokeMock).toHaveBeenCalledWith(IPC.TOPICS_LIST);
  });

  it('returns an empty list for malformed envelopes or topic arrays', async () => {
    invokeMock.mockResolvedValueOnce({ topics: 'not-an-array' });
    await expect(listTopics()).resolves.toEqual([]);
    invokeMock.mockResolvedValueOnce(null);
    await expect(listTopics()).resolves.toEqual([]);
  });
});
