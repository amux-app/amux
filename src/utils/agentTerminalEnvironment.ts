import { shQuote } from './shellEscape.js';

export const AGENT_TERMINAL_ENV_UNSETS = ['NO_COLOR'] as const;

// Claude downgrades its logo/UI to the indexed 256-color palette when $TMUX is
// present. Unsetting it (Claude-only) lets Claude emit its truecolor brand
// terracotta (#D77757) instead of the pink fallback. Every Claude launch path
// (create, resume, conflict-resolution) must pass this through the env wrapper.
export const CLAUDE_ENV_UNSETS = ['TMUX'] as const;

export const AGENT_TERMINAL_ENVIRONMENT = [
  ['TERM', 'tmux-256color'],
  ['COLORTERM', 'truecolor'],
  ['CLICOLOR', '1'],
  ['FORCE_COLOR', '1'],
  ['CLICOLOR_FORCE', '1'],
] as const;

export function withAgentTerminalEnvironment(
  command: string,
  extraEnv?: Record<string, string>,
  extraUnsets?: readonly string[],
): string {
  return [
    'env',
    ...AGENT_TERMINAL_ENV_UNSETS.map((name) => `-u ${name}`),
    ...(extraUnsets ?? []).map((name) => `-u ${name}`),
    ...AGENT_TERMINAL_ENVIRONMENT.map(([name, value]) => `${name}=${value}`),
    ...Object.entries(extraEnv ?? {}).map(([name, value]) => `${name}=${shQuote(value)}`),
    command,
  ].join(' ');
}

export function withHiddenAgentTerminalEnvironment(
  command: string,
  extraEnv?: Record<string, string>,
  extraUnsets?: readonly string[],
): string {
  const launchCommand = `printf '\\033c'; exec ${withAgentTerminalEnvironment(command, extraEnv, extraUnsets)}`;
  return `sh -c ${shQuote(launchCommand)}`;
}

export function withInteractiveShellAfterCommand(
  command: string,
  extraEnv?: Record<string, string>,
  fallbackShellSetup?: string,
): string {
  const exports = Object.entries(extraEnv ?? {})
    .map(([name, value]) => `export ${name}=${shQuote(value)}`)
    .join('; ');
  const exportPrefix = exports ? `${exports}; ` : '';
  const setupPrefix = fallbackShellSetup ? `${fallbackShellSetup}; ` : '';
  return `sh -c ${shQuote(`${exportPrefix}${command}; ${setupPrefix}exec "\${SHELL:-/bin/sh}"`)}`;
}
