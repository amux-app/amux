export interface SubmissionGate {
  isRunning: () => boolean;
  run: <T>(task: () => Promise<T>) => Promise<T | undefined>;
}

export function createSubmissionGate(): SubmissionGate {
  let running = false;

  return {
    isRunning: () => running,
    run: async <T>(task: () => Promise<T>): Promise<T | undefined> => {
      if (running) {
        return undefined;
      }

      running = true;
      try {
        return await task();
      } finally {
        running = false;
      }
    },
  };
}
