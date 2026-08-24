export class StartupTimeoutError extends Error {
  constructor(label: string, timeoutMs: number) {
    super(`${label} did not complete within ${Math.round(timeoutMs / 1000)} seconds.`);
    this.name = 'StartupTimeoutError';
  }
}

export function withStartupTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  if (timeoutMs <= 0) return operation;

  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new StartupTimeoutError(label, timeoutMs));
    }, timeoutMs);
    timer.unref?.();

    operation.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export type OperationSettlement = 'settled' | 'timed-out';

/**
 * Wait for in-flight work to finish without allowing an uncooperative
 * dependency to block process shutdown forever.
 */
export function waitForOperationSettlement(
  operation: Promise<unknown> | null,
  timeoutMs: number,
): Promise<OperationSettlement> {
  if (!operation) return Promise.resolve('settled');
  if (timeoutMs <= 0) return Promise.resolve('timed-out');

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      resolve('timed-out');
    }, timeoutMs);
    timer.unref?.();

    operation.then(
      () => {
        clearTimeout(timer);
        resolve('settled');
      },
      () => {
        clearTimeout(timer);
        resolve('settled');
      },
    );
  });
}
