import type { LogService } from './LogService.js';

export enum RetryStrategy {
  NONE = 'none',
  FAST = 'fast',
  IDEMPOTENT = 'idempotent',
}

interface RetryConfig {
  strategy: RetryStrategy;
  maxRetries: number;
  baseDelay: number;
  maxDelay: number;
}

const RETRY_CONFIGS: Record<RetryStrategy, RetryConfig> = {
  [RetryStrategy.NONE]: { strategy: RetryStrategy.NONE, maxRetries: 0, baseDelay: 0, maxDelay: 0 },
  [RetryStrategy.FAST]: { strategy: RetryStrategy.FAST, maxRetries: 2, baseDelay: 50, maxDelay: 100 },
  [RetryStrategy.IDEMPOTENT]: { strategy: RetryStrategy.IDEMPOTENT, maxRetries: 3, baseDelay: 100, maxDelay: 500 },
};

const PERMANENT_ERRORS = [
  'tmux not found',
  'command not found',
  'permission denied',
  'no such session',
  'no session found',
  'can\'t find pane',
  'invalid',
];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isPermanentError(error: unknown): boolean {
  const message = String(error).toLowerCase();
  return PERMANENT_ERRORS.some((pattern) => message.includes(pattern));
}

export async function executeWithRetry<T>(
  operation: () => T | Promise<T>,
  logger: LogService,
  strategy: RetryStrategy = RetryStrategy.IDEMPOTENT,
  context?: string,
): Promise<T> {
  const config = RETRY_CONFIGS[strategy];

  if (config.maxRetries === 0) {
    return await operation();
  }

  let lastError: unknown;
  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;

      if (isPermanentError(error)) {
        logger.debug(
          `Permanent error detected${context ? ` (${context})` : ''}, not retrying`,
          'error',
          error instanceof Error ? error.message : String(error),
        );
        throw error;
      }

      if (attempt < config.maxRetries) {
        const delay = Math.min(config.baseDelay * (attempt + 1), config.maxDelay);
        logger.debug(
          `Retry attempt ${attempt + 1}/${config.maxRetries}${context ? ` (${context})` : ''}, waiting ${delay}ms`,
          'debug',
        );
        await sleep(delay);
      }
    }
  }

  throw lastError;
}
