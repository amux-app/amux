import { execFile } from 'node:child_process';
import type { AgentName } from '../agents/agent-contract.js';
import { getAgentBinary } from '../agents/agent-contract.js';
import {
  ensureClaudeSessionHookSettings,
  removeClaudeSessionHookSettings,
} from './claudeSessionRegistry.js';
import {
  ensureCodexActivityHookSettings,
  removeCodexActivityHookSettings,
} from './codexActivityRegistry.js';
import {
  ensureOpenCodeActivityPlugin,
  removeOpenCodeActivityPlugin,
} from './opencodeActivityRegistry.js';
import {
  ensurePiActivityExtension,
  removePiActivityExtension,
} from './piActivityRegistry.js';

export type AdapterSupportLevel = 'full' | 'partial' | 'none';
export type ActivityAdapterCapability =
  | 'turnIds'
  | 'notifications'
  | 'backgroundSnapshots'
  | 'compaction'
  | 'backgroundEntities';

export interface AdapterInstallResult {
  installed: boolean;
  path?: string;
  reason?: 'unsupported' | 'declined' | 'unwritable' | 'failed';
}

export interface AdapterRemovalResult {
  removed: boolean;
  reason?: 'not-owned' | 'failed';
}

export interface ActivityAdapter {
  agent: AgentName;
  supports(version: string): AdapterSupportLevel;
  capabilities: readonly ActivityAdapterCapability[];
  install(): AdapterInstallResult;
  remove(): AdapterRemovalResult;
}

export interface PreparedActivityAdapter {
  capabilities: readonly ActivityAdapterCapability[];
  installed: boolean;
  support: AdapterSupportLevel;
  version?: string;
}

const CLAUDE_CAPABILITIES: readonly ActivityAdapterCapability[] = [
  'turnIds', 'notifications', 'backgroundSnapshots', 'compaction', 'backgroundEntities',
];
const BASIC_CAPABILITIES: readonly ActivityAdapterCapability[] = ['turnIds'];

export const ACTIVITY_ADAPTERS: Readonly<Record<AgentName, ActivityAdapter>> = {
  claude: {
    agent: 'claude',
    capabilities: CLAUDE_CAPABILITIES,
    supports: (version) => supportFromVersion(version, [2, 0, 0], [2, 1, 145]),
    install: () => pathResult(ensureClaudeSessionHookSettings()),
    remove: () => removalResult(removeClaudeSessionHookSettings()),
  },
  codex: {
    agent: 'codex',
    capabilities: BASIC_CAPABILITIES,
    supports: (version) => supportFromVersion(version, [0, 1, 0], [0, 1, 0]),
    install: () => pathResult(ensureCodexActivityHookSettings()),
    remove: () => removalResult(removeCodexActivityHookSettings()),
  },
  opencode: {
    agent: 'opencode',
    capabilities: BASIC_CAPABILITIES,
    supports: (version) => supportFromVersion(version, [1, 0, 0], [1, 0, 0]),
    install: () => pathResult(ensureOpenCodeActivityPlugin()),
    remove: () => removalResult(removeOpenCodeActivityPlugin()),
  },
  pi: {
    agent: 'pi',
    capabilities: BASIC_CAPABILITIES,
    supports: (version) => supportFromVersion(version, [0, 1, 0], [0, 1, 0]),
    install: () => pathResult(ensurePiActivityExtension()),
    remove: () => removalResult(removePiActivityExtension()),
  },
};

export function getActivityAdapter(agent: AgentName): ActivityAdapter {
  return ACTIVITY_ADAPTERS[agent];
}

/** Detects an installed agent without invoking a shell or trusting its output as code. */
async function detectActivityAdapterVersion(agent: AgentName): Promise<string | undefined> {
  try {
    const output = await execFileVersion(getAgentBinary(agent));
    const match = /(?:^|\s|v)(\d+\.\d+(?:\.\d+)?)/.exec(`${output.stdout}\n${output.stderr}`);
    return match?.[1];
  } catch {
    return undefined;
  }
}

/** Detects support, installs only when compatible, and returns handshake metadata. */
export async function prepareActivityAdapter(agent: AgentName, enabled: boolean): Promise<PreparedActivityAdapter> {
  const adapter = getActivityAdapter(agent);
  if (!enabled && agent !== 'claude') {
    return { capabilities: adapter.capabilities, installed: false, support: 'none' };
  }
  const version = await detectActivityAdapterVersion(agent);
  // A missing version is not enough evidence for full support. Partial keeps
  // the observer useful while preventing it from publishing confirmed facts.
  const support = version ? adapter.supports(version) : 'partial';
  if (support === 'none') {
    return { capabilities: adapter.capabilities, installed: false, support, version };
  }
  const installation = adapter.install();
  return { capabilities: adapter.capabilities, installed: installation.installed, support, version };
}

function execFileVersion(binary: string): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(binary, ['--version'], { timeout: 2_000 }, (error, stdout, stderr) => {
      if (error) reject(error);
      else resolve({ stderr, stdout });
    });
  });
}

function supportFromVersion(
  version: string,
  minimum: readonly [number, number, number],
  full: readonly [number, number, number],
): AdapterSupportLevel {
  const parsed = parseVersion(version);
  if (!parsed || compareVersions(parsed, minimum) < 0) return 'none';
  return compareVersions(parsed, full) >= 0 ? 'full' : 'partial';
}

function parseVersion(value: string): [number, number, number] | null {
  const match = /(?:^|\s|v)(\d+)\.(\d+)(?:\.(\d+))?/.exec(value.trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)];
}

function compareVersions(left: readonly number[], right: readonly number[]): number {
  for (let index = 0; index < 3; index++) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

function pathResult(path: string | null): AdapterInstallResult {
  return path ? { installed: true, path } : { installed: false, reason: 'unwritable' };
}

function removalResult(removed: boolean): AdapterRemovalResult {
  return removed ? { removed: true } : { removed: false, reason: 'failed' };
}
