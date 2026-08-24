import { existsSync, readFileSync, statSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import type { AgentDefaultSlice } from '../../../shared/ipc-types.js';

const CODEX_CONFIG_PATH = join(homedir(), '.codex', 'config.toml');
const MAX_CONFIG_BYTES = 1 * 1024 * 1024;
const SECTION_HEADER = /^\s*\[/;
const MODEL_LINE = /^\s*model\s*=\s*"([^"]+)"\s*$/;
const EFFORT_LINE = /^\s*model_reasoning_effort\s*=\s*"([^"]+)"\s*$/;

function extractTopLevel(toml: string): { model?: string; effort?: string } {
  const result: { model?: string; effort?: string } = {};
  for (const line of toml.split(/\r?\n/)) {
    if (SECTION_HEADER.test(line)) break;
    if (!result.model) {
      const m = MODEL_LINE.exec(line);
      if (m) result.model = m[1];
    }
    if (!result.effort) {
      const m = EFFORT_LINE.exec(line);
      if (m) result.effort = m[1];
    }
  }
  return result;
}

export function readCodexDefaults(): AgentDefaultSlice {
  if (!existsSync(CODEX_CONFIG_PATH)) return {};
  try {
    if (statSync(CODEX_CONFIG_PATH).size > MAX_CONFIG_BYTES) return {};
    const toml = readFileSync(CODEX_CONFIG_PATH, 'utf-8');
    return extractTopLevel(toml);
  } catch {
    return {};
  }
}
