import { afterEach, describe, expect, it, vi } from 'vitest';

const execFileAsync = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<string>>());

vi.mock('muxbase/core', () => ({ execFileAsync }));

vi.mock('../../src/main/services/Logger.js', () => ({
  log: { debug: vi.fn() },
}));

import {
  AppMemorySampler,
  fallbackTotalKB,
  parseFootprintTotalKB,
  type ProcessMemoryInput,
} from '../../src/main/services/process-memory.js';

/** Real `footprint --noCategories -f bytes` output for five live MuxBase processes. */
const BYTES_FIXTURE = `======================================================================
MuxBase Helper [14756]: 64-bit    Footprint: 188613808 B (16384 bytes per page)
======================================================================

Auxiliary data:
    phys_footprint: 188646576 B
    phys_footprint_peak: 425788640 B

======================================================================
MuxBase Helper (Renderer) [14768]: 64-bit    Footprint: 96454216 B (16384 bytes per page)
======================================================================

Auxiliary data:
    phys_footprint: 96486984 B
    phys_footprint_peak: 155911776 B

======================================================================
MuxBase [14694]: 64-bit    Footprint: 69273472 B (16384 bytes per page)
======================================================================

Auxiliary data:
    phys_footprint: 69306240 B
    phys_footprint_peak: 82921320 B

======================================================================
MuxBase Helper [17302]: 64-bit    Footprint: 8012736 B (16384 bytes per page)
======================================================================

Auxiliary data:
    phys_footprint: 8045504 B
    phys_footprint_peak: 8537024 B

======================================================================
MuxBase Helper [14757]: 64-bit    Footprint: 6980448 B (16384 bytes per page)
======================================================================

Auxiliary data:
    phys_footprint: 7013216 B
    phys_footprint_peak: 7062368 B

======================================================================
Summary Footprint: 368056728 B
======================================================================`;

/** Real `footprint --noCategories` output, which mixes MB and KB units. */
const FORMATTED_FIXTURE = `======================================================================
MuxBase [14694]: 64-bit    Footprint: 67 MB (16384 bytes per page)
======================================================================

Auxiliary data:
    phys_footprint: 67 MB
    phys_footprint_peak: 79 MB

======================================================================
MuxBase Helper [14757]: 64-bit    Footprint: 6817 KB (16384 bytes per page)
======================================================================

Auxiliary data:
    phys_footprint: 6849 KB
    phys_footprint_peak: 6897 KB

======================================================================
Summary Footprint: 74 MB
======================================================================`;

const BYTES_FIXTURE_TOTAL_KB = 360838;
const FORMATTED_FIXTURE_TOTAL_KB = 75457;
const FALLBACK_TOTAL_KB = 177000;

const INPUT: ProcessMemoryInput = {
  mainPid: 100,
  mainPrivateKB: 65000,
  processes: [
    { pid: 100, memory: { workingSetSize: 180000 } },
    { pid: 200, memory: { workingSetSize: 72000 } },
    { pid: 300, memory: { privateBytes: 40000, workingSetSize: 91000 } },
  ],
};

const ORIGINAL_PLATFORM = process.platform;

function usePlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { configurable: true, value });
}

function flushSample(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

afterEach(() => {
  vi.useRealTimers();
  usePlatform(ORIGINAL_PLATFORM);
  execFileAsync.mockReset();
});

describe('parseFootprintTotalKB', () => {
  it('sums phys_footprint across processes from real byte output', () => {
    // Arrange / Act
    const totalKB = parseFootprintTotalKB(BYTES_FIXTURE);

    // Assert: peaks are ignored, so only the five phys_footprint lines count.
    expect(totalKB).toBe(BYTES_FIXTURE_TOTAL_KB);
  });

  it('converts MB and KB units from the default formatted output', () => {
    // Arrange / Act
    const totalKB = parseFootprintTotalKB(FORMATTED_FIXTURE);

    // Assert
    expect(totalKB).toBe(FORMATTED_FIXTURE_TOTAL_KB);
  });

  it('returns null when no footprint lines are present', () => {
    // Arrange / Act / Assert
    expect(parseFootprintTotalKB('')).toBeNull();
    expect(parseFootprintTotalKB('footprint: Unable to find pid for process')).toBeNull();
  });
});

describe('fallbackTotalKB', () => {
  it('prefers private memory and only falls back to working set size', () => {
    // Arrange / Act
    const totalKB = fallbackTotalKB(INPUT);

    // Assert: main private (65000) + RSS-only child (72000) + private child (40000).
    expect(totalKB).toBe(FALLBACK_TOTAL_KB);
  });
});

describe('AppMemorySampler', () => {
  it('falls back on the first tick and reports footprint once the sample lands', async () => {
    // Arrange
    usePlatform('darwin');
    execFileAsync.mockResolvedValue(BYTES_FIXTURE);
    const sampler = new AppMemorySampler();

    // Act
    const firstTick = sampler.sampleKB(INPUT);
    await flushSample();
    const laterTick = sampler.sampleKB(INPUT);

    // Assert
    expect(firstTick).toBe(FALLBACK_TOTAL_KB);
    expect(laterTick).toBe(BYTES_FIXTURE_TOTAL_KB);
    expect(execFileAsync).toHaveBeenCalledWith(
      '/usr/bin/footprint',
      ['--noCategories', '-f', 'bytes', '-p', '100', '-p', '200', '-p', '300'],
      { silent: true, timeout: 3000 },
    );
  });

  it('keeps using the fallback when the footprint spawn fails', async () => {
    // Arrange: silent execFileAsync resolves empty on missing binary, non-zero exit or timeout.
    usePlatform('darwin');
    execFileAsync.mockResolvedValue('');
    const sampler = new AppMemorySampler();

    // Act
    sampler.sampleKB(INPUT);
    await flushSample();

    // Assert
    expect(sampler.sampleKB(INPUT)).toBe(FALLBACK_TOTAL_KB);
  });

  it('never spawns footprint off darwin', async () => {
    // Arrange
    usePlatform('linux');
    const sampler = new AppMemorySampler();

    // Act
    const totalKB = sampler.sampleKB(INPUT);
    await flushSample();

    // Assert
    expect(totalKB).toBe(FALLBACK_TOTAL_KB);
    expect(execFileAsync).not.toHaveBeenCalled();
  });

  it('spawns at most once per 10s window across 2s monitor ticks', async () => {
    // Arrange
    usePlatform('darwin');
    execFileAsync.mockResolvedValue(BYTES_FIXTURE);
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const sampler = new AppMemorySampler();

    // Act: five ticks covering a single 10s window.
    for (let tick = 0; tick < 5; tick += 1) {
      sampler.sampleKB(INPUT);
      await vi.advanceTimersByTimeAsync(0);
      vi.advanceTimersByTime(2000);
    }

    // Assert
    expect(execFileAsync).toHaveBeenCalledTimes(1);

    // Act: the next window refreshes again.
    sampler.sampleKB(INPUT);

    // Assert
    expect(execFileAsync).toHaveBeenCalledTimes(2);
  });

  it('does not start a second spawn while one is still in flight', async () => {
    // Arrange: a sample that stays pending well past the refresh interval.
    usePlatform('darwin');
    let release: (output: string) => void = () => {};
    execFileAsync.mockReturnValue(new Promise<string>((resolve) => { release = resolve; }));
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const sampler = new AppMemorySampler();

    // Act
    sampler.sampleKB(INPUT);
    vi.advanceTimersByTime(30000);
    sampler.sampleKB(INPUT);
    sampler.sampleKB(INPUT);

    // Assert
    expect(execFileAsync).toHaveBeenCalledTimes(1);
    release(BYTES_FIXTURE);
  });
});
