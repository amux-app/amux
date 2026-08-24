import { execSync } from 'child_process';
import type { LogService } from './LogService.js';
import { execAsync } from '../utils/execAsync.js';

export interface TmuxCommandOptions {
  encoding?: BufferEncoding;
  silent?: boolean;
  stdio?: 'pipe' | 'inherit';
}

export interface TmuxAsyncCommandOptions {
  silent?: boolean;
  timeout?: number;
}

export function executeTmuxCommand(
  command: string,
  logger: LogService,
  options: TmuxCommandOptions = {},
): string {
  const { encoding = 'utf-8', stdio = 'pipe', silent = false } = options;

  try {
    const result = execSync(command, {
      encoding,
      stdio,
    });
    return typeof result === 'string' ? result.trim() : '';
  } catch (error) {
    if (!silent) {
      logger.debug(
        `tmux command failed: ${command}`,
        'error',
        error instanceof Error ? error.message : String(error),
      );
    }
    throw error;
  }
}

export async function executeTmuxCommandAsync(
  command: string,
  logger: LogService,
  options: TmuxAsyncCommandOptions = {},
): Promise<string> {
  const { silent = false, timeout = 5000 } = options;

  try {
    return await execAsync(command, { timeout, silent });
  } catch (error) {
    if (!silent) {
      logger.debug(
        `tmux command failed: ${command}`,
        'error',
        error instanceof Error ? error.message : String(error),
      );
    }
    throw error;
  }
}
