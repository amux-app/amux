import { existsSync, readFileSync, statSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { SettingsManager } from 'aumx/core';
import type { AgentDefaultSlice } from '../../../shared/ipc-types.js';

const CLAUDE_SETTINGS_PATH = join(homedir(), '.claude', 'settings.json');
const MAX_SETTINGS_BYTES = 1 * 1024 * 1024;
const SONNET = 'sonnet';
const OPUS = 'opus';
const HAIKU = 'haiku';
const FABLE = 'fable';

const FULL_NAME_TO_ALIAS: Record<string, string> = {
  'claude-sonnet-latest': SONNET,
  'claude-opus-latest': OPUS,
  'claude-haiku-latest': HAIKU,
  'claude-fable-latest': FABLE,
};

function aliasFromModelId(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || raw.length === 0) return undefined;
  if (FULL_NAME_TO_ALIAS[raw]) return FULL_NAME_TO_ALIAS[raw];
  if (raw.startsWith('claude-sonnet')) return SONNET;
  if (raw.startsWith('claude-opus')) return OPUS;
  if (raw.startsWith('claude-haiku')) return HAIKU;
  if (raw.startsWith('claude-fable')) return FABLE;
  return raw;
}

function readClaudeSettingsModel(): string | undefined {
  if (!existsSync(CLAUDE_SETTINGS_PATH)) return undefined;
  try {
    if (statSync(CLAUDE_SETTINGS_PATH).size > MAX_SETTINGS_BYTES) return undefined;
    const json = JSON.parse(readFileSync(CLAUDE_SETTINGS_PATH, 'utf-8'));
    const env = json?.env;
    if (env && typeof env === 'object') {
      return aliasFromModelId(env.ANTHROPIC_MODEL);
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function readSettingsEffort(projectRoot?: string): string | undefined {
  try {
    return SettingsManager.getInstance(projectRoot).getSettings().claudeEffort || undefined;
  } catch {
    return undefined;
  }
}

function readSettingsModel(projectRoot?: string): string | undefined {
  try {
    const value = SettingsManager.getInstance(projectRoot).getSettings().claudeModel;
    return value || undefined;
  } catch {
    return undefined;
  }
}

export function readClaudeDefaults(projectRoot?: string): AgentDefaultSlice {
  const envModel = aliasFromModelId(process.env.ANTHROPIC_MODEL);
  // Priority: (1) amux settings (claudeModel), (2) process.env ANTHROPIC_MODEL,
  // (3) ~/.claude/settings.json ANTHROPIC_MODEL, (4) opus as final fallback.
  // Mirrors the same amux-first priority already used for effort below.
  const model = readSettingsModel(projectRoot) ?? envModel ?? readClaudeSettingsModel() ?? OPUS;
  const effort = readSettingsEffort(projectRoot) ?? 'ultracode';
  return { model, effort };
}
