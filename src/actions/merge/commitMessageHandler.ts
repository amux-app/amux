import type { ActionResult } from '../types.js';
import { LogService } from '../../services/LogService.js';
import { generateCommitMessage, getComprehensiveDiff } from '../../utils/aiMerge.js';
import { commitChanges, stageAllChanges } from '../../utils/mergeValidation.js';

const COMMIT_MESSAGE_SCOPE = 'commitMessageHandler';
const AI_MERGE_SCOPE = 'aiMerge';

const EMPTY_MESSAGE_ERROR = (): ActionResult => ({
  type: 'error',
  message: 'Commit message cannot be empty',
  dismissable: true,
});

function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function generateCommitMessageSafe(
  repoPath: string,
  timeoutMs: number = 15000
): Promise<string | null> {
  try {
    const result = await Promise.race([
      generateCommitMessage(repoPath),
      new Promise<null>((_, reject) =>
        setTimeout(() => reject(new Error('Timeout')), timeoutMs)
      ),
    ]);

    if (!result) {
      LogService.getInstance().warn('AI commit message generation returned null', AI_MERGE_SCOPE);
    }

    return result;
  } catch (error) {
    const errorMsg = `AI commit message generation error: ${error}`;
    LogService.getInstance().error(errorMsg, AI_MERGE_SCOPE, undefined, error instanceof Error ? error : undefined);
    return null;
  }
}

export async function promptForCommitMessage(
  repoPath: string,
  mode: 'ai_automatic' | 'ai_editable' | 'manual',
  onCommit: (message: string) => Promise<ActionResult>
): Promise<ActionResult> {
  LogService.getInstance().info(
    `promptForCommitMessage called - repoPath: ${repoPath}, mode: ${mode}`,
    COMMIT_MESSAGE_SCOPE
  );

  const stageResult = await stageAllChanges(repoPath);
  if (!stageResult.success) {
    LogService.getInstance().error(
      `Failed to stage changes in ${repoPath}: ${stageResult.error}`,
      COMMIT_MESSAGE_SCOPE
    );
    return {
      type: 'error',
      message: `Failed to stage changes: ${stageResult.error}`,
      dismissable: true
    };
  }

  if (mode === 'manual') {
    return {
      type: 'input',
      title: 'Enter Commit Message',
      message: 'Write a commit message for the changes:',
      placeholder: 'feat: add new feature',
      onSubmit: async (message: string) => {
        if (!message || !message.trim()) return EMPTY_MESSAGE_ERROR();
        return onCommit(message.trim());
      },
      dismissable: true,
    };
  }

  let diff = '';
  let summary = '';
  try {
    ({ diff, summary } = await getComprehensiveDiff(repoPath));
  } catch (error) {
    const message = `Unable to inspect changes: ${formatErrorMessage(error)}`;
    LogService.getInstance().error(message, COMMIT_MESSAGE_SCOPE, undefined, error);
    return {
      type: 'error',
      title: 'Commit Message Unavailable',
      message,
      dismissable: true,
    };
  }

  LogService.getInstance().info(
    `getComprehensiveDiff for ${repoPath} - diff length: ${diff.length}, summary: ${summary.substring(0, 100)}`,
    COMMIT_MESSAGE_SCOPE
  );

  const generatedMessage = await generateCommitMessageSafe(repoPath);
  LogService.getInstance().info(
    generatedMessage ? 'Generated commit message successfully' : 'Commit message generation returned no result',
    COMMIT_MESSAGE_SCOPE
  );

  if (!generatedMessage) {
    LogService.getInstance().warn(
      `AI commit message generation failed for ${repoPath}, falling back to ${mode === 'ai_automatic' ? 'default message' : 'manual input'}`,
      COMMIT_MESSAGE_SCOPE
    );
    if (mode === 'ai_automatic') {
      return onCommit('chore: update files');
    }
    return {
      type: 'input',
      title: 'Enter Commit Message',
      message: `Auto-generation failed or timed out. Please write a commit message manually.\n\nFiles changed:\n${summary}`,
      placeholder: 'feat: add new feature',
      onSubmit: async (message: string) => {
        if (!message || !message.trim()) return EMPTY_MESSAGE_ERROR();
        return onCommit(message.trim());
      },
      dismissable: true,
    };
  }

  if (mode === 'ai_automatic') {
    return onCommit(generatedMessage);
  }

  return {
    type: 'input',
    title: 'Review & Edit Commit Message',
    message: `Files changed:\n${summary}\n\nGenerated message (edit as needed):`,
    placeholder: 'feat: add new feature',
    defaultValue: generatedMessage,
    onSubmit: async (message: string) => {
      if (!message || !message.trim()) return EMPTY_MESSAGE_ERROR();
      return onCommit(message.trim());
    },
    dismissable: true,
  };
}

export async function handleCommitWithOptions(
  repoPath: string,
  optionId: 'commit_automatic' | 'commit_ai_editable' | 'commit_manual',
  onSuccess: () => Promise<ActionResult>
): Promise<ActionResult> {
  LogService.getInstance().info(
    `handleCommitWithOptions called with repoPath: ${repoPath}, optionId: ${optionId}`,
    COMMIT_MESSAGE_SCOPE
  );

  const mode =
    optionId === 'commit_automatic' ? 'ai_automatic' :
    optionId === 'commit_ai_editable' ? 'ai_editable' :
    'manual';

  return promptForCommitMessage(repoPath, mode, async (message: string) => {
    LogService.getInstance().info(
      `Executing commit in: ${repoPath} with message: ${message.substring(0, 50)}...`,
      COMMIT_MESSAGE_SCOPE
    );
    const result = await commitChanges(repoPath, message);
    if (!result.success) {
      return { type: 'error', message: `Commit failed: ${result.error}`, dismissable: true };
    }
    return onSuccess();
  });
}
