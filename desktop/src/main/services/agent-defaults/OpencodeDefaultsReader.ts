import { existsSync, readFileSync, statSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import type { OpencodeDefaults } from '../../../shared/ipc-types.js';

const OPENCODE_CONFIG_PATH = join(homedir(), '.config', 'opencode', 'opencode.json');
const MAX_CONFIG_BYTES = 5 * 1024 * 1024;
const MAX_AVAILABLE_MODELS = 1000;

interface OpencodeConfig {
  model?: unknown;
  mode?: Record<string, { model?: unknown }>;
  provider?: Record<string, {
    models?: Record<string, { reasoningEffort?: unknown; thinking?: unknown }>;
  }>;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readModeOverrides(modes: OpencodeConfig['mode']): Record<string, string> | undefined {
  if (!modes || typeof modes !== 'object' || Array.isArray(modes)) return undefined;
  const out: Record<string, string> = {};
  for (const [name, entry] of Object.entries(modes)) {
    const m = asString(entry?.model);
    if (m) out[name] = m;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function resolveReasoningEffort(config: OpencodeConfig, model: string | undefined): string | undefined {
  if (!model || !config.provider) return undefined;
  const slash = model.indexOf('/');
  if (slash < 0) return undefined;
  const providerKey = model.slice(0, slash);
  const modelKey = model.slice(slash + 1);
  const modelConfig = config.provider[providerKey]?.models?.[modelKey];
  return asString(modelConfig?.reasoningEffort);
}

function enumerateAvailableModels(providers: OpencodeConfig['provider']): string[] | undefined {
  if (!providers || typeof providers !== 'object' || Array.isArray(providers)) return undefined;
  const ids = new Set<string>();
  for (const [providerKey, providerEntry] of Object.entries(providers)) {
    const models = providerEntry?.models;
    if (!models || typeof models !== 'object' || Array.isArray(models)) continue;
    for (const modelId of Object.keys(models)) {
      ids.add(`${providerKey}/${modelId}`);
      if (ids.size >= MAX_AVAILABLE_MODELS) break;
    }
    if (ids.size >= MAX_AVAILABLE_MODELS) break;
  }
  if (ids.size === 0) return undefined;
  return Array.from(ids).sort();
}

export function readOpencodeDefaults(): OpencodeDefaults {
  if (!existsSync(OPENCODE_CONFIG_PATH)) return {};
  try {
    if (statSync(OPENCODE_CONFIG_PATH).size > MAX_CONFIG_BYTES) return {};
    const config = JSON.parse(readFileSync(OPENCODE_CONFIG_PATH, 'utf-8')) as OpencodeConfig;
    const model = asString(config.model);
    const effort = resolveReasoningEffort(config, model);
    const modelByMode = readModeOverrides(config.mode);
    const availableModels = enumerateAvailableModels(config.provider);
    return { model, effort, modelByMode, availableModels };
  } catch {
    return {};
  }
}
