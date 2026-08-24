// @vitest-environment happy-dom
import { cleanup, renderHook, act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderStatus, ProviderStatusResponse } from '../../src/shared/ipc-types';
import { useProviderStatus } from '../../src/renderer/hooks/useProviderStatus';
import { useProviderStatusStore } from '../../src/renderer/stores/provider-status.store';

const providerStatusApi = vi.hoisted(() => ({
  getProviderStatus: vi.fn<() => Promise<ProviderStatusResponse>>(),
}));

vi.mock('../../src/renderer/api/llm.api', () => ({
  getProviderStatus: providerStatusApi.getProviderStatus,
}));

vi.mock('../../src/renderer/lib/rendererLog', () => ({
  rendererLog: {
    warn: vi.fn(),
  },
}));

const COMPLETE_INTERVAL_MS = 60 * 60 * 1000;
const INCOMPLETE_INTERVAL_MS = 5 * 60 * 1000;

function makeProviderStatus(provider: ProviderStatus['provider'], score: number | null, operational: ProviderStatus['operational']['level']): ProviderStatus {
  return {
    provider,
    level: score === null || operational === 'unknown' ? 'unknown' : 'ok',
    quality: {
      score,
      level: score === null ? 'unknown' : 'ok',
      trend: score === null ? null : 'stable',
      models: [],
      measuredAt: score === null ? null : Date.now(),
    },
    operational: {
      level: operational,
      description: operational,
    },
    sparkline: [],
    updatedAt: Date.now(),
  };
}

function makeResponse(openAiScore: number | null, openAiOperational: ProviderStatus['operational']['level']): ProviderStatusResponse {
  return {
    statuses: {
      anthropic: makeProviderStatus('anthropic', 70, 'ok'),
      openai: makeProviderStatus('openai', openAiScore, openAiOperational),
    },
    fetchedAt: Date.now(),
  };
}

describe('useProviderStatus', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    providerStatusApi.getProviderStatus.mockReset();
    useProviderStatusStore.setState({ fetchedAt: 0, statuses: {} });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('retries incomplete provider data on the short interval, then uses the full interval after recovery', async () => {
    // Arrange
    providerStatusApi.getProviderStatus
      .mockImplementationOnce(async () => makeResponse(null, 'unknown'))
      .mockImplementationOnce(async () => makeResponse(80, 'ok'))
      .mockImplementationOnce(async () => makeResponse(82, 'ok'));

    // Act
    renderHook(() => useProviderStatus());
    await act(async () => undefined);

    // Assert
    expect(providerStatusApi.getProviderStatus).toHaveBeenCalledTimes(1);

    // Act
    await act(async () => {
      await vi.advanceTimersByTimeAsync(INCOMPLETE_INTERVAL_MS);
    });

    // Assert
    expect(providerStatusApi.getProviderStatus).toHaveBeenCalledTimes(2);

    // Act
    await act(async () => {
      await vi.advanceTimersByTimeAsync(INCOMPLETE_INTERVAL_MS);
    });

    // Assert
    expect(providerStatusApi.getProviderStatus).toHaveBeenCalledTimes(2);

    // Act
    await act(async () => {
      await vi.advanceTimersByTimeAsync(COMPLETE_INTERVAL_MS - INCOMPLETE_INTERVAL_MS);
    });

    // Assert
    expect(providerStatusApi.getProviderStatus).toHaveBeenCalledTimes(3);
  });

  it('uses remaining provider status freshness when cached data is still valid on mount', async () => {
    // Arrange
    const fetchedAt = 1_000;
    const nearlyExpiredAt = fetchedAt + COMPLETE_INTERVAL_MS - 60_000;
    const cached = makeResponse(80, 'ok');
    useProviderStatusStore.setState({ fetchedAt, statuses: cached.statuses });
    vi.setSystemTime(nearlyExpiredAt);
    providerStatusApi.getProviderStatus.mockImplementationOnce(async () => makeResponse(82, 'ok'));

    // Act
    renderHook(() => useProviderStatus());
    await act(async () => undefined);

    // Assert
    expect(providerStatusApi.getProviderStatus).not.toHaveBeenCalled();

    // Act
    await act(async () => {
      await vi.advanceTimersByTimeAsync(59_999);
    });

    // Assert
    expect(providerStatusApi.getProviderStatus).not.toHaveBeenCalled();

    // Act
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });

    // Assert
    expect(providerStatusApi.getProviderStatus).toHaveBeenCalledTimes(1);
  });
});
