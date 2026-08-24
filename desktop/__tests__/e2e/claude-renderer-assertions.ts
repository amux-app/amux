import { pollUntil } from './e2e-helpers';

const DEFAULT_STABLE_SAMPLES = 4;

type HeaderPollResult =
  | { kind: 'duplicate'; count: number }
  | { kind: 'stable' };

export async function assertStableSingleClaudeHeader(
  readCount: () => Promise<number | null>,
  options: {
    interval?: number;
    requiredSamples?: number;
    timeout: number;
  },
): Promise<void> {
  const requiredSamples = options.requiredSamples ?? DEFAULT_STABLE_SAMPLES;
  let consecutiveSamples = 0;

  const result = await pollUntil<HeaderPollResult>(
    async () => {
      const count = await readCount();
      if (count === null) {
        consecutiveSamples = 0;
        return false;
      }
      if (count > 1) return { kind: 'duplicate', count };

      consecutiveSamples = count === 1 ? consecutiveSamples + 1 : 0;
      return consecutiveSamples >= requiredSamples ? { kind: 'stable' } : false;
    },
    {
      interval: options.interval,
      label: 'one stable Claude header in the full terminal buffer',
      timeout: options.timeout,
    },
  );

  if (result.kind === 'duplicate') {
    throw new Error(`Claude header duplicated in terminal buffer: expected 1, received ${result.count}`);
  }
}
