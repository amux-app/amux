import { assertNever, type AgentName } from '../agents/agent-contract.js';
import { isPiProcessCommand } from '../agents/pi-runtime.js';

const SHELL_COMMAND_NAMES = new Set(['bash', 'zsh', 'fish', 'sh', 'ksh', 'dash', 'nu', 'pwsh', 'powershell']);
const SEMVER_COMMAND_PATTERN = /^\d+\.\d+\.\d+$/;

export function isShellCommand(command: string): boolean {
  return SHELL_COMMAND_NAMES.has(getCommandBasename(command));
}

export function isAgentCommand(
  agent: AgentName,
  command: string,
): boolean {
  const normalized = command.trim().toLowerCase();
  switch (agent) {
    case 'claude':
      return normalized.includes('claude') || SEMVER_COMMAND_PATTERN.test(getCommandBasename(command));
    case 'codex':
      return normalized.includes('codex');
    case 'opencode':
      return normalized.includes('opencode');
    case 'pi':
      return isPiProcessCommand(command);
    default:
      return assertNever(agent);
  }
}

function getCommandBasename(command: string): string {
  const trimmed = command.trim().toLowerCase();
  const parts = trimmed.split('/');
  return parts[parts.length - 1] ?? trimmed;
}
