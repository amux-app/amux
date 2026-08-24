import { execFile } from 'child_process';
import { AGENT_IDS, type AgentName } from '../agents/agent-contract.js';
import { getAvailableAgents } from './agentDetection.js';
import { loadSystemRequirements } from './systemRequirements.js';
import { isSupportedTmuxVersion, parseTmuxVersion } from './tmuxVersion.js';

const NO_SERVER_PATTERNS = ['no server running', 'no such file or directory'];

/**
 * System requirement check results
 */
export interface ValidationResult {
  agents: AgentName[];
  canRun: boolean;
  warnings: string[];
  errors: string[];
}

export interface RequiredValidationResult {
  canRun: boolean;
  errors: string[];
}

interface DependencyCheck {
  valid: boolean;
  version?: string;
  errors: string[];
}

interface CommandOutcome {
  error: Error | null;
  stdout: string;
  stderr: string;
}

/**
 * Check if the effective tmux client meets the minimum version, preserving
 * the full detected version string (including its letter suffix) for the UI.
 */
async function checkTmuxClientVersion(minVersion: string, homebrewFormula: string): Promise<DependencyCheck> {
  const outcome = await runCommand('tmux', ['-V']);
  if (outcome.error) {
    if (didCommandTimeOut(outcome.error)) {
      return {
        valid: false,
        errors: ['Amux could not verify tmux because the version check timed out. Retry startup.'],
      };
    }
    if (isCommandMissing(outcome.error)) {
      return { valid: false, errors: [`tmux is required. Install it with: brew install ${homebrewFormula}`] };
    }
    return {
      valid: false,
      errors: ['Amux could not verify tmux. Check the tmux installation and PATH, then retry startup.'],
    };
  }

  const parsed = parseTmuxVersion(outcome.stdout);
  if (!parsed) {
    return {
      valid: false,
      errors: [`Amux could not verify tmux version ${outcome.stdout.trim()}; install stable tmux >=${minVersion}.`],
    };
  }

  if (!isSupportedTmuxVersion(parsed.raw, minVersion)) {
    return {
      valid: false,
      version: parsed.raw.replace(/^tmux\s+/, ''),
      errors: [`tmux ${parsed.raw.replace(/^tmux\s+/, '')} is below Amux's minimum ${minVersion}. Run: brew upgrade ${homebrewFormula}`],
    };
  }

  return { valid: true, version: parsed.raw.replace(/^tmux\s+/, ''), errors: [] };
}

/**
 * Detect a pre-upgrade tmux server that is still running an older version.
 * Never starts a server and never treats a genuine probe failure as absence.
 */
async function checkTmuxServerVersion(minVersion: string, clientVersion: string | undefined): Promise<DependencyCheck> {
  const outcome = await runCommand('tmux', ['display-message', '-p', '#{version}']);
  if (outcome.error) {
    if (isNoServer(outcome)) return { valid: true, errors: [] };
    return { valid: false, errors: [`Amux could not verify the running tmux server. Save and close active tmux sessions, restart tmux completely, then retry Amux startup.`] };
  }

  const parsed = parseTmuxVersion(outcome.stdout);
  if (!parsed) {
    return { valid: false, errors: [`Amux could not verify the running tmux server version ${outcome.stdout.trim()}; restart tmux completely, then retry Amux startup.`] };
  }

  if (!isSupportedTmuxVersion(parsed.raw, minVersion)) {
    const client = clientVersion ?? `>=${minVersion}`;
    return {
      valid: false,
      version: parsed.raw,
      errors: [`tmux client ${client} is installed, but the running server is ${parsed.raw}. Save and close active tmux sessions, restart tmux completely, then retry Amux startup.`],
    };
  }

  return { valid: true, version: parsed.raw, errors: [] };
}

function isNoServer(outcome: CommandOutcome): boolean {
  const haystack = `${outcome.stderr} ${outcome.error?.message ?? ''}`.toLowerCase();
  return NO_SERVER_PATTERNS.some((pattern) => haystack.includes(pattern));
}

/**
 * Check if git is installed and meets minimum version requirement
 */
async function checkGitVersion(minVersion: string): Promise<DependencyCheck> {
  const outcome = await runCommand('git', ['--version']);
  if (outcome.error) {
    if (didCommandTimeOut(outcome.error)) {
      return {
        valid: false,
        errors: ['Amux could not verify Git because the version check timed out. Retry startup.'],
      };
    }
    if (isCommandMissing(outcome.error)) {
      return { valid: false, errors: ['git is not installed or not in PATH'] };
    }
    return {
      valid: false,
      errors: ['Amux could not verify Git. Check the Git installation and PATH, then retry startup.'],
    };
  }

  const versionMatch = outcome.stdout.match(/git version\s+([\d.]+)/);
  if (!versionMatch) {
    return { valid: false, errors: [`Could not parse git version: ${outcome.stdout}`] };
  }

  const installedVersion = versionMatch[1];
  if (compareGitVersions(parseGitVersion(installedVersion), parseGitVersion(minVersion)) >= 0) {
    return { valid: true, version: installedVersion, errors: [] };
  }
  return {
    valid: false,
    version: installedVersion,
    errors: [`git version ${installedVersion} is below minimum required version ${minVersion}`],
  };
}

function runCommand(command: string, args: string[]): Promise<CommandOutcome> {
  return new Promise((resolve) => {
    execFile(command, args, {
      encoding: 'utf8',
      shell: false,
      timeout: 5_000,
    }, (error, stdout, stderr) => {
      resolve({ error: error ?? null, stdout: (stdout ?? '').trim(), stderr: (stderr ?? '').trim() });
    });
  });
}

function didCommandTimeOut(error: Error): boolean {
  const commandError = error as Error & {
    code?: string | number | null;
    killed?: boolean;
    signal?: NodeJS.Signals | null;
  };
  return commandError.code === 'ETIMEDOUT'
    || (commandError.killed === true && commandError.signal === 'SIGTERM');
}

function isCommandMissing(error: Error): boolean {
  return (error as Error & { code?: string | number | null }).code === 'ENOENT';
}

function parseGitVersion(version: string): number[] {
  return version.split('.').map((v) => {
    const num = parseInt(v.replace(/[^\d]/g, ''), 10);
    return isNaN(num) ? 0 : num;
  });
}

function compareGitVersions(a: number[], b: number[]): number {
  const maxLength = Math.max(a.length, b.length);
  for (let i = 0; i < maxLength; i++) {
    const aVal = a[i] || 0;
    const bVal = b[i] || 0;
    if (aVal < bVal) return -1;
    if (aVal > bVal) return 1;
  }
  return 0;
}

function collectAgentWarnings(agents: AgentName[]): string[] {
  if (agents.length === 0) {
    return [`No agents found (${AGENT_IDS.join(', ')}). You will not be able to use AI features.`];
  }
  const missing = AGENT_IDS.filter((a) => !agents.includes(a));
  if (missing.length === 0) return [];
  return [`Agent(s) not found: ${missing.map((a) => `'${a}'`).join(', ')}. Available: ${agents.map((a) => `'${a}'`).join(', ')}.`];
}

/**
 * Validate all system requirements for aumx
 * Returns validation result with errors and warnings
 */
export async function validateRequiredSystemRequirements(): Promise<RequiredValidationResult> {
  const requirements = loadSystemRequirements();
  const [tmuxClient, git] = await Promise.all([
    checkTmuxClientVersion(requirements.tmux.minimum, requirements.tmux.homebrewFormula),
    checkGitVersion(requirements.git.minimum),
  ]);

  const tmuxServer = tmuxClient.valid
    ? await checkTmuxServerVersion(requirements.tmux.minimum, tmuxClient.version)
    : { valid: true, errors: [] };

  const errors = [...tmuxClient.errors, ...tmuxServer.errors, ...git.errors];

  return {
    canRun: tmuxClient.valid && tmuxServer.valid && git.valid,
    errors,
  };
}

export async function validateSystemRequirements(): Promise<ValidationResult> {
  const [required, agents] = await Promise.all([
    validateRequiredSystemRequirements(),
    getAvailableAgents(),
  ]);

  return {
    ...required,
    agents,
    warnings: collectAgentWarnings(agents),
  };
}
