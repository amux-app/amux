import type { AgentName } from 'muxbase/core';

export interface AgentOption {
  value: string;
  label: string;
}

export interface AgentTuningCatalog {
  models: AgentOption[];
  efforts: AgentOption[];
  effortLabel?: string;
  effortPlaceholder?: string;
  modelDisabledChip?: { label: string; tooltip: string };
}

const CLAUDE_MODELS: AgentOption[] = [
  { value: 'opus', label: 'Opus (latest)' },
  { value: 'sonnet', label: 'Sonnet (latest)' },
  { value: 'haiku', label: 'Haiku (latest)' },
  { value: 'fable', label: 'Fable (latest)' },
];

const CLAUDE_EFFORTS: AgentOption[] = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'Extra high' },
  { value: 'max', label: 'Max' },
  { value: 'ultracode', label: 'Ultracode' },
];

const CODEX_MODELS: AgentOption[] = [
  { value: 'gpt-5-codex', label: 'GPT-5 Codex' },
  { value: 'gpt-5', label: 'GPT-5' },
  { value: 'o4-mini', label: 'o4-mini' },
  { value: 'o3', label: 'o3' },
  { value: 'gpt-4.1', label: 'GPT-4.1' },
];

const CODEX_EFFORTS: AgentOption[] = [
  { value: 'minimal', label: 'Minimal' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'Extra high' },
];

const OPENCODE_VARIANTS: AgentOption[] = [
  { value: 'minimal', label: 'Minimal' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'Extra high' },
  { value: 'max', label: 'Max' },
];

const PI_THINKING_LEVELS: AgentOption[] = [
  { value: 'off', label: 'Off' },
  { value: 'minimal', label: 'Minimal' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'Extra high' },
  { value: 'max', label: 'Max' },
];

export const AGENT_TUNING: Record<AgentName, AgentTuningCatalog> = {
  claude: {
    models: CLAUDE_MODELS,
    efforts: CLAUDE_EFFORTS,
  },
  codex: {
    models: CODEX_MODELS,
    efforts: CODEX_EFFORTS,
  },
  opencode: {
    models: [],
    efforts: OPENCODE_VARIANTS,
    modelDisabledChip: {
      label: 'Default from opencode.json',
      tooltip: 'OpenCode reads its model from ~/.config/opencode/opencode.json. Add models there to populate this dropdown.',
    },
  },
  pi: {
    models: [],
    efforts: PI_THINKING_LEVELS,
    effortLabel: 'Thinking',
    effortPlaceholder: 'Default from Pi',
    modelDisabledChip: {
      label: 'Use Pi default',
      tooltip: 'Pi uses the model configured by the selected provider. Choose another model inside Pi with /model.',
    },
  },
};

export function isValidOption(options: AgentOption[], value: string | undefined): boolean {
  if (value === undefined) return false;
  return options.some((opt) => opt.value === value);
}
