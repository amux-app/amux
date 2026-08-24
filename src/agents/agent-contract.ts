export const AGENT_IDS = ['claude', 'codex', 'opencode', 'pi'] as const;
export const AGENT_CAPABILITIES = [
  'launch',
  'duel',
  'kanban',
  'sessionList',
  'sessionParsing',
  'review',
  'marketplaceMcp',
] as const;

export type AgentName = (typeof AGENT_IDS)[number];
export type AgentCapability = (typeof AGENT_CAPABILITIES)[number];

export interface AgentCapabilities {
  launch: boolean;
  duel: boolean;
  kanban: boolean;
  sessionList: boolean;
  sessionParsing: boolean;
  review: boolean;
  marketplaceMcp: boolean;
}

interface AgentDefinition {
  binary: string;
  capabilities: AgentCapabilities;
  label: string;
  slugSuffix: string;
}

const FULL_CAPABILITIES: AgentCapabilities = {
  launch: true,
  duel: true,
  kanban: true,
  sessionList: true,
  sessionParsing: true,
  review: true,
  marketplaceMcp: true,
};

export const AGENT_DEFINITIONS: Readonly<Record<AgentName, AgentDefinition>> = {
  claude: {
    binary: 'claude',
    capabilities: FULL_CAPABILITIES,
    label: 'Claude Code',
    slugSuffix: 'claude-code',
  },
  codex: {
    binary: 'codex',
    capabilities: FULL_CAPABILITIES,
    label: 'Codex',
    slugSuffix: 'codex',
  },
  opencode: {
    binary: 'opencode',
    capabilities: FULL_CAPABILITIES,
    label: 'OpenCode',
    slugSuffix: 'opencode',
  },
  pi: {
    binary: 'pi',
    capabilities: {
      launch: true,
      duel: true,
      kanban: true,
      sessionList: true,
      sessionParsing: true,
      review: false,
      marketplaceMcp: false,
    },
    label: 'Pi',
    slugSuffix: 'pi',
  },
};

const AGENT_ID_SET = new Set<string>(AGENT_IDS);

export function isAgentName(value: unknown): value is AgentName {
  return typeof value === 'string' && AGENT_ID_SET.has(value);
}

export function getAgentLabel(agent: AgentName): string {
  return AGENT_DEFINITIONS[agent].label;
}

export function getAgentBinary(agent: AgentName): string {
  return AGENT_DEFINITIONS[agent].binary;
}

export function getAgentSlugSuffix(agent: AgentName): string {
  return AGENT_DEFINITIONS[agent].slugSuffix;
}

export function agentHasCapability(agent: AgentName, capability: AgentCapability): boolean {
  return AGENT_DEFINITIONS[agent].capabilities[capability];
}

export function getAgentsWithCapability(
  agents: readonly AgentName[],
  capability: AgentCapability,
): AgentName[] {
  const installed = new Set(agents);
  return AGENT_IDS.filter((agent) => installed.has(agent) && agentHasCapability(agent, capability));
}

export function assertNever(value: never): never {
  throw new Error(`Unhandled agent: ${String(value)}`);
}
