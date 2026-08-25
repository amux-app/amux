import {
  getAgentLabel,
  type AgentName,
} from '../agents/agent-contract.js';
import { shQuote } from './shellEscape.js';
import { normalizeAsciiName } from './safeName.js';

export type { AgentName } from '../agents/agent-contract.js';
export { getAgentLabel, getAgentSlugSuffix } from '../agents/agent-contract.js';

export interface AgentLaunchOption {
  id: string;
  label: string;
  agents: AgentName[];
  isPair: boolean;
}


export function appendSlugSuffix(baseSlug: string, slugSuffix?: string): string {
  if (!slugSuffix) return baseSlug;

  const normalizedSuffix = normalizeAsciiName(slugSuffix);

  if (!normalizedSuffix) return baseSlug;
  if (baseSlug === normalizedSuffix || baseSlug.endsWith(`-${normalizedSuffix}`)) {
    return baseSlug;
  }

  return `${baseSlug}-${normalizedSuffix}`;
}

export function buildAgentLaunchOptions(
  availableAgents: AgentName[]
): AgentLaunchOption[] {
  const uniqueAgents = availableAgents.filter(
    (agent, index) => availableAgents.indexOf(agent) === index
  );

  const singleAgentOptions: AgentLaunchOption[] = uniqueAgents.map((agent) => ({
    id: agent,
    label: getAgentLabel(agent),
    agents: [agent],
    isPair: false,
  }));

  const pairOptions: AgentLaunchOption[] = [];
  for (let i = 0; i < uniqueAgents.length; i++) {
    for (let j = i + 1; j < uniqueAgents.length; j++) {
      const first = uniqueAgents[i];
      const second = uniqueAgents[j];
      pairOptions.push({
        id: `${first}+${second}`,
        label: `A/B: ${getAgentLabel(first)} + ${getAgentLabel(second)}`,
        agents: [first, second],
        isPair: true,
      });
    }
  }

  return [...singleAgentOptions, ...pairOptions];
}

const CLAUDE_AUTO_FLAG = '--permission-mode auto';
const CLAUDE_PLAN_FLAG = '--permission-mode plan';
const CODEX_AUTO_FLAGS = '--sandbox workspace-write --ask-for-approval on-request';
const CODEX_READ_ONLY_FLAGS = '--sandbox read-only --ask-for-approval never';
const OPENCODE_PLAN_AGENT_FLAG = '--agent plan';
const CLAUDE_MODEL_FLAG_PREFIX = '--model';
const CLAUDE_EFFORT_FLAG_PREFIX = '--effort';
const CODEX_MODEL_FLAG_PREFIX = '--model';
const CODEX_EFFORT_CONFIG_KEY = 'model_reasoning_effort';
const OPENCODE_MODEL_FLAG_PREFIX = '--model';
const OPENCODE_VARIANT_FLAG_PREFIX = '--variant';

type PermissionMode = '' | 'auto' | 'plan' | 'acceptEdits' | 'bypassPermissions' | undefined;

function normalizePermissionMode(permissionMode: PermissionMode): '' | 'auto' {
  if (permissionMode === 'auto' || permissionMode === 'acceptEdits' || permissionMode === 'bypassPermissions') {
    return 'auto';
  }
  return '';
}

/**
 * Resolve CLI permission flags for a given agent and muxbase permissionMode.
 */
export function getPermissionFlags(
  agent: AgentName,
  permissionMode: PermissionMode,
): string {
  const mode = normalizePermissionMode(permissionMode);
  if (!mode) return '';

  if (agent === 'claude') return CLAUDE_AUTO_FLAG;
  if (agent === 'codex') return CODEX_AUTO_FLAGS;

  return '';
}

/**
 * Resolve CLI flags that constrain an agent to read-only (review) mode.
 * - Claude: plan mode (analysis-only, cannot edit).
 * - Codex: read-only sandbox with no approval prompts.
 * - OpenCode: the built-in `plan` agent, which denies edits and bash.
 */
export function getReadOnlyFlags(agent: AgentName): string {
  if (agent === 'claude') return CLAUDE_PLAN_FLAG;
  if (agent === 'codex') return CODEX_READ_ONLY_FLAGS;
  if (agent === 'opencode') return OPENCODE_PLAN_AGENT_FLAG;
  return '';
}

/**
 * Resolve the `--model` CLI flag for an agent. Claude-only: codex and opencode
 * use incompatible model namespaces and are returned as no-ops. Values are
 * shell-quoted; validation is the caller's responsibility (enforced at the IPC
 * boundary today).
 */
export function getModelFlags(agent: AgentName, model: string | undefined): string {
  if (agent !== 'claude' || !model) return '';
  return `${CLAUDE_MODEL_FLAG_PREFIX} ${shQuote(model)}`;
}

/**
 * Resolve the `--effort` reasoning flag for an agent. Claude-only.
 * 'ultracode' is a muxbase harness marker (no CLI equivalent); it maps to xhigh
 * — the highest valid CLI value — and the launcher additionally exports
 * MUXBASE_ULTRACODE=1 so the spawned session can detect it.
 */
export function getEffortFlags(agent: AgentName, effort: string | undefined): string {
  if (agent !== 'claude' || !effort) return '';
  const cliEffort = effort === 'ultracode' ? 'xhigh' : effort;
  return `${CLAUDE_EFFORT_FLAG_PREFIX} ${shQuote(cliEffort)}`;
}

/**
 * Resolve the `--model` CLI flag for Codex. Accepts any model id from the OpenAI catalog
 * (e.g. `gpt-5-codex`, `o4-mini`); returns '' when unset.
 */
export function getCodexModelFlags(model: string | undefined): string {
  if (!model) return '';
  return `${CODEX_MODEL_FLAG_PREFIX} ${shQuote(model)}`;
}

/**
 * Resolve the reasoning effort override for Codex via `-c model_reasoning_effort=<level>`.
 * Levels: minimal | low | medium | high | xhigh.
 */
export function getCodexEffortFlags(effort: string | undefined): string {
  if (!effort) return '';
  return `-c ${shQuote(`${CODEX_EFFORT_CONFIG_KEY}=${effort}`)}`;
}

/**
 * Resolve the `--model` CLI flag for OpenCode. Accepts the `provider/model`
 * form documented by `opencode --help`. Returns '' when unset.
 */
export function getOpencodeModelFlags(model: string | undefined): string {
  if (!model) return '';
  return `${OPENCODE_MODEL_FLAG_PREFIX} ${shQuote(model)}`;
}

/**
 * Resolve the interactive OpenCode TUI command. Standard rendering is the
 * default; the compact mini renderer is an explicit scrollback-friendly mode.
 */
export function getOpencodeTuiCommand(scrollbackMode: boolean | undefined): string {
  return scrollbackMode === true ? 'opencode --mini' : 'opencode';
}

/**
 * Resolve the `--variant` flag for OpenCode (provider-specific reasoning
 * effort, per `opencode run --help`: e.g. high | max | minimal). Returns ''
 * when unset.
 */
export function getOpencodeVariantFlags(variant: string | undefined): string {
  if (!variant) return '';
  return `${OPENCODE_VARIANT_FLAG_PREFIX} ${shQuote(variant)}`;
}
