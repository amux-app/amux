/**
 * AI-Assisted Merge Utilities
 *
 * Uses AI to help resolve merge conflicts intelligently
 */

import { LogService } from '../services/LogService.js';
import { callClaudeCode } from './aiCli.js';
import { callOpenRouter } from './openrouter.js';
import { execFileAsync } from './execAsync.js';

const AI_MERGE_SCOPE = 'aiMerge';

class DiffCollectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DiffCollectionError';
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function runGitDiffCommand(
  repoPath: string,
  args: readonly string[],
  label: string,
): Promise<string> {
  try {
    return await execFileAsync('git', args, { cwd: repoPath });
  } catch (error) {
    const message = `Failed to collect git diff (${label}) in ${repoPath}: ${formatError(error)}`;
    LogService.getInstance().error(message, AI_MERGE_SCOPE, undefined, error);
    throw new DiffCollectionError(message);
  }
}

/**
 * Get comprehensive git diff with context for commit message generation
 */
export async function getComprehensiveDiff(
  repoPath: string,
): Promise<{ diff: string; summary: string }> {
  const logger = LogService.getInstance();
  logger.debug(`getComprehensiveDiff called for: ${repoPath}`, AI_MERGE_SCOPE);

  let diff = await runGitDiffCommand(repoPath, ['diff', '--cached'], 'staged diff');
  let staged = true;
  logger.debug(`git diff --cached length: ${diff.length}`, AI_MERGE_SCOPE);

  if (!diff.trim()) {
    diff = await runGitDiffCommand(repoPath, ['diff'], 'unstaged diff');
    staged = false;
    logger.debug(`git diff length: ${diff.length}`, AI_MERGE_SCOPE);
  }

  const summary = await runGitDiffCommand(
    repoPath,
    staged ? ['diff', '--cached', '--stat'] : ['diff', '--stat'],
    staged ? 'staged diff stat' : 'unstaged diff stat',
  );

  logger.debug(
    `getComprehensiveDiff result - diff: ${diff.length} chars, summary: ${summary.trim().substring(0, 100)}`,
    AI_MERGE_SCOPE,
  );
  return { diff, summary };
}

/**
 * Get AI-generated commit message from git diff
 * Returns null if generation fails, so caller can handle fallback
 */
export async function generateCommitMessage(repoPath: string): Promise<string | null> {
  const { diff, summary } = await getComprehensiveDiff(repoPath);

  if (!diff.trim()) {
    return null;
  }

  try {
    const contextDiff = diff.length > 5000 ? diff.slice(0, 5000) + '\n...(truncated)' : diff;

    const prompt = `Generate a concise conventional commit message (e.g., "feat: add feature", "fix: bug") for these changes. Respond with ONLY the commit message, nothing else:\n\nFile changes:\n${summary}\n\nDiff:\n${contextDiff}`;

    let message = await callOpenRouter(prompt, 50);
    if (message) {
      message = message.replace(/^["']|["']$/g, '').trim();
      if (message && message.length < 100) {
        return message;
      }
    }

    message = await callClaudeCode(prompt);
    if (message) {
      message = message.replace(/^["']|["']$/g, '').trim();
      if (message && message.length < 100) {
        return message;
      }
    }

    return null;
  } catch (error) {
    LogService.getInstance().warn(
      `AI commit message generation failed for ${repoPath}: ${formatError(error)}`,
      AI_MERGE_SCOPE,
    );
    return null;
  }
}
