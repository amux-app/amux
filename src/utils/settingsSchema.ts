import { isAgentName } from '../agents/agent-contract.js';
import type { MuxBaseSettings } from '../types.js';

export const CLAUDE_FULLSCREEN_DEFAULT_RESET_KEY = 'claudeFullscreenDefaultResetVersion';

type SettingKey = keyof MuxBaseSettings;

const validators: Readonly<Record<string, (value: unknown) => boolean>> = {
  baseBranch: (value) => typeof value === 'string',
  branchPrefix: (value) => typeof value === 'string',
  claudeEffort: oneOf('', 'low', 'medium', 'high', 'xhigh', 'max', 'ultracode'),
  claudeFullscreenRendering: (value) => typeof value === 'boolean',
  claudeModel: oneOf('', 'opus', 'sonnet', 'haiku', 'fable'),
  codexEffort: oneOf('', 'minimal', 'low', 'medium', 'high', 'xhigh'),
  codexModel: oneOf('', 'gpt-5-codex', 'gpt-5', 'o4-mini', 'o3', 'gpt-4.1'),
  defaultAgent: (value) => value === '' || isAgentName(value),
  initGitIfMissing: (value) => typeof value === 'boolean',
  opencodeScrollbackMode: (value) => typeof value === 'boolean',
  opencodeVariant: oneOf('', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'),
  permissionMode: oneOf('', 'auto', 'acceptEdits', 'plan', 'bypassPermissions'),
  piModel: (value) => typeof value === 'string',
  piThinking: oneOf('', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'),
  useTmuxHooks: (value) => typeof value === 'boolean',
  useWorktree: (value) => typeof value === 'boolean',
  [CLAUDE_FULLSCREEN_DEFAULT_RESET_KEY]: (value) => typeof value === 'number' && Number.isInteger(value) && value >= 0,
};

export function isSettingKey(key: string): key is SettingKey {
  return Object.hasOwn(validators, key) && key !== CLAUDE_FULLSCREEN_DEFAULT_RESET_KEY;
}

export function validateSettingValue(key: string, value: unknown): boolean {
  return validators[key]?.(value) ?? false;
}

export function validateSettingsPatch(settings: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(settings)) {
    if (!isSettingKey(key) || !validateSettingValue(key, value)) {
      throw new Error(`Invalid ${key}`);
    }
  }
}

function oneOf(...allowed: readonly string[]): (value: unknown) => boolean {
  const values = new Set(allowed);
  return (value: unknown) => typeof value === 'string' && values.has(value);
}
