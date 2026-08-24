import { describe, expect, it, vi, beforeEach } from 'vitest';

const listProcessTable = vi.fn();

vi.mock('../../src/utils/processTree.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/utils/processTree.js')>();
  return { ...actual, listProcessTable };
});

const { getRunningAgentPanes } = await import('../../src/utils/paneAgentProcess.js');

describe('getRunningAgentPanes', () => {
  beforeEach(() => {
    listProcessTable.mockReset();
  });

  it('matches by current command without touching the process table', async () => {
    // Arrange
    const probes = [
      { paneId: '%1', pid: 100, currentCommand: 'claude', agent: 'claude' as const },
      { paneId: '%2', pid: 200, currentCommand: 'node', agent: 'codex' as const },
    ];

    // Act
    const result = await getRunningAgentPanes([probes[0]]);

    // Assert
    expect(result.running.has('%1')).toBe(true);
    expect(result.indeterminate.size).toBe(0);
    expect(listProcessTable).not.toHaveBeenCalled();
  });

  it('falls back to the process tree once for panes not matched by command', async () => {
    // Arrange
    listProcessTable.mockResolvedValue([
      { pid: 100, ppid: 1, command: 'fish', args: 'fish' },
      { pid: 101, ppid: 100, command: 'claude', args: 'claude' },
      { pid: 200, ppid: 1, command: 'fish', args: 'fish' },
    ]);
    const probes = [
      { paneId: '%1', pid: 100, currentCommand: 'fish', agent: 'claude' as const },
      { paneId: '%2', pid: 200, currentCommand: 'fish', agent: 'claude' as const },
    ];

    // Act
    const result = await getRunningAgentPanes(probes);

    // Assert
    expect(result.running.has('%1')).toBe(true);
    expect(result.running.has('%2')).toBe(false);
    expect(result.indeterminate.size).toBe(0);
    expect(listProcessTable).toHaveBeenCalledTimes(1);
  });

  it('excludes panes with no live pid and no command match', async () => {
    // Arrange
    const probes = [
      { paneId: '%1', pid: 0, currentCommand: 'fish', agent: 'claude' as const },
    ];

    // Act
    const result = await getRunningAgentPanes(probes);

    // Assert
    expect(result.running.size).toBe(0);
    expect(result.indeterminate.size).toBe(0);
    expect(listProcessTable).not.toHaveBeenCalled();
  });

  it('marks process-tree probes indeterminate when ps fails instead of declaring them stopped', async () => {
    listProcessTable.mockRejectedValue(new Error('ps unavailable'));

    const result = await getRunningAgentPanes([
      { paneId: '%1', pid: 100, currentCommand: 'fish', agent: 'claude' as const },
    ]);

    expect(result.running.size).toBe(0);
    expect(result.indeterminate).toEqual(new Set(['%1']));
  });
});
