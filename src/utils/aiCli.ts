import { spawn } from 'child_process';
import { getEnhancedPathAsync } from './execAsync.js';

const DEFAULT_CLAUDE_TIMEOUT_MS = 15000;
const MAX_CLAUDE_OUTPUT_BYTES = 1024 * 1024;

export async function callClaudeCode(
  prompt: string,
  timeoutMs: number = DEFAULT_CLAUDE_TIMEOUT_MS,
): Promise<string | null> {
  const enhancedPath = await getEnhancedPathAsync();
  return new Promise((resolve) => {
    const child = spawn('claude', ['-p', '--max-turns', '1', '--no-session-persistence'], {
      env: { ...process.env, PATH: enhancedPath },
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    const output: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;
    const finish = (value: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(value);
    };
    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      finish(null);
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      if (settled) return;
      outputBytes += chunk.length;
      if (outputBytes > MAX_CLAUDE_OUTPUT_BYTES) {
        child.kill('SIGTERM');
        finish(null);
        return;
      }
      output.push(chunk);
    });
    child.on('error', () => finish(null));
    child.stdin.on('error', () => finish(null));
    child.on('close', (code) => {
      const stdout = Buffer.concat(output).toString('utf-8').trim();
      finish(code === 0 && stdout ? stdout : null);
    });
    child.stdin.end(prompt);
  });
}
