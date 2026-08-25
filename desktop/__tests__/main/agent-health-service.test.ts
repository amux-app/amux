import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentHealthSnapshot } from '../../src/shared/ipc-types';
import { AgentHealthService } from '../../src/main/services/AgentHealthService';

const logWarn = vi.hoisted(() => vi.fn());

vi.mock('../../src/main/services/Logger.js', () => ({
  log: {
    info: vi.fn(),
    warn: logWarn,
  },
}));

const staleClaudeSnapshot: AgentHealthSnapshot = {
  agent: 'claude',
  trackedModel: 'claude-opus-4-x',
  passRate: 70,
  ciLower: 55,
  ciUpper: 80,
  passed: 35,
  displayRunsCount: 50,
  date: '2026-06-01',
  measuredAt: 1_000,
  trackerUrl: 'https://marginlab.ai/trackers/claude-code/',
};

describe('AgentHealthService', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('short-circuits without fetching when disabled via setDisabled', async () => {
    // Arrange
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const service = new AgentHealthService();
    service.setDisabled(true);

    // Act
    const result = await service.getHealth();

    // Assert
    expect(result.snapshots).toEqual({});
    expect(result.fetchedAt).toBeGreaterThan(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('short-circuits without fetching when MUXBASE_DISABLE_EXTERNAL_STATUS is set', async () => {
    // Arrange
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    vi.stubEnv('MUXBASE_DISABLE_EXTERNAL_STATUS', '1');
    const service = new AgentHealthService();

    // Act
    const result = await service.getHealth();

    // Assert
    expect(result.snapshots).toEqual({});
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('drops stale snapshots and logs a warning when a fetched tracker page cannot be parsed', async () => {
    // Arrange
    const service = new AgentHealthService();
    Reflect.set(service, 'cache', {
      fetchedAt: Date.now() - 2 * 60 * 60 * 1000,
      snapshots: { claude: staleClaudeSnapshot },
    });
    Reflect.set(service, 'cacheComplete', true);
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({
      ok: true,
      text: () => Promise.resolve('<html><body>markup changed</body></html>'),
    } as Response)));

    // Act
    const result = await service.getHealth();

    // Assert
    expect(result.snapshots.claude).toBeUndefined();
    expect(logWarn).toHaveBeenCalledWith(
      'agent-health',
      'parse failed',
      expect.objectContaining({ agent: 'claude' }),
    );
  });
});
