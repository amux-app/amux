import { TmuxService } from '../services/TmuxService.js';
import { capturePaneContent } from './paneCapture.js';
import { TMUX_SPLIT_DELAY } from '../constants/timing.js';

const TRUST_PROMPT_PATTERNS = [
  /Do you trust the files in this folder\?/i,
  /Trust the files in this workspace\?/i,
  /Do you trust the authors of the files/i,
  /Do you want to trust this workspace\?/i,
  /trust.*files.*folder/i,
  /trust.*workspace/i,
  /Trust this folder/i,
  /trust.*directory/i,
  /workspace.*trust/i,
  /❯\s*1\.\s*Yes,\s*proceed/i,
  /Enter to confirm.*Esc to exit/i,
  /1\.\s*Yes,\s*proceed/i,
  /2\.\s*No,\s*exit/i,
];

const NEW_CLAUDE_FORMAT = [
  /❯\s*1\.\s*Yes,\s*proceed/i,
  /Enter to confirm.*Esc to exit/i,
];

export async function autoApproveTrustPrompt(
  paneInfo: string,
  prompt?: string,
): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 1200));

  const maxChecks = 100;
  const checkInterval = 100;
  let lastContent = '';
  let stableContentCount = 0;
  let promptHandled = false;

  for (let i = 0; i < maxChecks; i++) {
    await new Promise((resolve) => setTimeout(resolve, checkInterval));

    try {
      const paneContent = capturePaneContent(paneInfo, 30);

      if (
        paneContent.includes('Claude') ||
        paneContent.includes('Assistant') ||
        paneContent.includes('claude>')
      ) {
        break;
      }

      if (paneContent === lastContent) {
        stableContentCount++;
      } else {
        stableContentCount = 0;
        lastContent = paneContent;
      }

      const hasTrustPrompt = TRUST_PROMPT_PATTERNS.some((pattern) =>
        pattern.test(paneContent)
      );

      if (hasTrustPrompt && !promptHandled && stableContentCount >= 5) {
        const isNewClaudeFormat = NEW_CLAUDE_FORMAT.some((p) => p.test(paneContent));

        const tmuxService = TmuxService.getInstance();
        if (isNewClaudeFormat) {
          await tmuxService.sendTmuxKeys(paneInfo, 'Enter');
        } else {
          await tmuxService.sendTmuxKeys(paneInfo, 'y');
          await new Promise((resolve) => setTimeout(resolve, 50));
          await tmuxService.sendTmuxKeys(paneInfo, 'Enter');
          await new Promise((resolve) => setTimeout(resolve, TMUX_SPLIT_DELAY));
          await tmuxService.sendTmuxKeys(paneInfo, 'Enter');
        }

        promptHandled = true;
        await new Promise((resolve) => setTimeout(resolve, 500));

        const updatedContent = capturePaneContent(paneInfo, 10);
        const promptGone = !TRUST_PROMPT_PATTERNS.some((p) => p.test(updatedContent));

        if (promptGone) {
          if (prompt) {
            const claudeRunning =
              updatedContent.includes('Claude') ||
              updatedContent.includes('claude') ||
              updatedContent.includes('Assistant') ||
              updatedContent.includes(prompt.substring(0, Math.min(20, prompt.length)));

            if (!claudeRunning && !updatedContent.includes('$')) {
              await new Promise((resolve) => setTimeout(resolve, 300));
            }
          }
          break;
        }
      }
    } catch {
      // Continue checking
    }
  }
}
