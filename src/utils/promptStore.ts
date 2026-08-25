import * as fs from 'fs/promises';
import type { Dirent } from 'fs';
import path from 'path';
import { LogService } from '../services/LogService.js';
import { normalizeAsciiName } from './safeName.js';
import { shQuote } from './shellEscape.js';
import { getProjectMetadataPath } from './worktreePaths.js';

const log = LogService.getInstance();

const PROMPTS_SUBDIR = 'prompts';
const PROMPT_FILE_EXTENSION = '.txt';
const MAX_SLUG_PREFIX_LENGTH = 64;

function sanitizeSlugForFilename(slug: string): string {
  const normalized = normalizeAsciiName(slug, {
    allowedPunctuation: '._',
    maxLength: MAX_SLUG_PREFIX_LENGTH,
  });

  if (!normalized) {
    return 'pane';
  }

  return normalized;
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 8);
}

export { shQuote as shellQuote } from './shellEscape.js';

function wrapWithPosixShell(command: string): string {
  return `sh -c ${shQuote(command)}`;
}

export function getPromptsDir(projectRoot: string): string {
  return getProjectMetadataPath(projectRoot, PROMPTS_SUBDIR);
}

export async function writePromptFile(
  projectRoot: string,
  slug: string,
  prompt: string
): Promise<string> {
  const promptsDir = getPromptsDir(projectRoot);
  await fs.mkdir(promptsDir, { recursive: true });

  const safeSlug = sanitizeSlugForFilename(slug);
  const filename = `${safeSlug}--${Date.now()}-${randomSuffix()}${PROMPT_FILE_EXTENSION}`;
  const promptPath = path.join(promptsDir, filename);

  await fs.writeFile(promptPath, prompt, {
    encoding: 'utf-8',
    mode: 0o600,
  });

  return promptPath;
}

export async function deletePromptFile(promptPath: string): Promise<void> {
  try {
    await fs.rm(promptPath, { force: true });
  } catch (error) {
    log.warn(`Failed to delete prompt file ${promptPath}: ${error}`, 'promptStore');
  }
}

export async function cleanupPromptFilesForSlug(
  projectRoot: string,
  slug: string
): Promise<number> {
  const promptsDir = getPromptsDir(projectRoot);
  const safeSlug = sanitizeSlugForFilename(slug);
  const filenamePrefix = `${safeSlug}--`;

  let entries: Dirent[];
  try {
    entries = await fs.readdir(promptsDir, { withFileTypes: true, encoding: 'utf-8' });
  } catch (error) {
    log.warn(`Failed to read prompts directory ${promptsDir}: ${error}`, 'promptStore');
    return 0;
  }

  const removals = entries
    .filter((entry) => entry.isFile() && entry.name.startsWith(filenamePrefix))
    .map(async (entry) => {
      try {
        await fs.rm(path.join(promptsDir, entry.name), { force: true });
        return 1;
      } catch (error) {
        log.warn(`Failed to remove prompt file ${entry.name}: ${error}`, 'promptStore');
        return 0;
      }
    });

  const results = await Promise.all(removals);
  return results.reduce((sum, value) => sum + value, 0 as number);
}

export function buildPromptReadAndDeleteSnippet(
  promptPath: string,
  command?: string
): string {
  const quotedPromptPath = shQuote(promptPath);
  const snippet = `MUXBASE_PROMPT_FILE=${quotedPromptPath}; MUXBASE_PROMPT_CONTENT="$(cat "$MUXBASE_PROMPT_FILE" 2>/dev/null || true)"; rm -f "$MUXBASE_PROMPT_FILE"`;
  if (!command) {
    return snippet;
  }
  // Clear the terminal before launching the agent so the echoed shell command
  // (from tmux send-keys) doesn't persist in the visible area or scrollback.
  // printf '\033c' (ANSI RIS) works without ncurses and resets tmux history too.
  return wrapWithPosixShell(`${snippet}; printf '\\033c'; ${command}`);
}
