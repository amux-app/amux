import { LogService } from '../services/LogService.js';
import { TmuxService } from '../services/TmuxService.js';
import type { AumxPane, AumxSettings } from '../types.js';
import { assertNever, type AgentName } from '../agents/agent-contract.js';
import { buildPiResumeCommand } from '../agents/pi-runtime.js';
import { isShellCommand } from './agentCommandDetection.js';
import { findPiCommand } from './agentDetection.js';
import { getOpencodeTuiCommand, getPermissionFlags } from './agentLaunch.js';
import { ensureClaudeSessionHookSettings } from './claudeSessionRegistry.js';
import { prepareActivityAdapter } from './activityAdapters.js';
import { ensureTmuxPaneIncarnationOption } from './paneRebinding.js';
import { getPaneActivityJournalPath } from './paneActivityJournal.js';
import {
  CLAUDE_ENV_UNSETS,
  withHiddenAgentTerminalEnvironment,
  withInteractiveShellAfterCommand,
} from './agentTerminalEnvironment.js';
import { autoApproveTrustPrompt } from './autoApproveTrustPrompt.js';
import { assertClaudeFullscreenSupported } from './claudeVersion.js';
import { isAgentRunningInTmuxPane } from './paneAgentProcess.js';
import { CLAUDE_TERMINAL_COLS, resolveClaudeRendererEnvironment } from './paneTerminalProfile.js';
import { shQuote } from './shellEscape.js';

export async function isAgentRunningInPane(
  paneId: string,
  agent: AgentName,
): Promise<boolean> {
  const tmuxService = TmuxService.getInstance();
  return isAgentRunningInTmuxPane(tmuxService, paneId, agent);
}

export async function resumeAgentInPane(
  paneId: string,
  agent: AgentName,
  settings: Pick<AumxSettings, 'opencodeScrollbackMode' | 'permissionMode'>,
  agentSessionId?: string,
  claudeRenderer?: AumxPane['claudeRenderer'],
  options: {
    aumxPaneId?: string;
    activityJournal?: string;
    activityIncarnationId?: string;
    enableActivityAdapters?: boolean;
    piSessionMode?: 'fork' | 'resume';
    piSessionPath?: string;
  } = {},
): Promise<boolean> {
  const tmuxService = TmuxService.getInstance();
  const log = LogService.getInstance();

  if (agent === 'claude' && claudeRenderer === 'fullscreen') {
    await assertClaudeFullscreenSupported();
  }

  const currentCommand = await tmuxService.getPaneCurrentCommand(paneId);
  if (currentCommand && !isShellCommand(currentCommand)) {
    log.info(`[resumeAgentInPane] Skipping resume — pane ${paneId} is not at a shell prompt (running: "${currentCommand}")`, 'paneCreation');
    return false;
  }

  const activityAdapter = await prepareActivityAdapter(agent, options.enableActivityAdapters === true || agent === 'claude');

  const permissionFlags = getPermissionFlags(agent, settings.permissionMode);
  const permissionSuffix = permissionFlags ? ` ${permissionFlags}` : '';

  let command: string;
  switch (agent) {
    case 'claude': {
      const resumeTarget = agentSessionId ? `--resume ${shQuote(agentSessionId)}` : '--continue';
      const settingsPath = activityAdapter.installed ? ensureClaudeSessionHookSettings() : null;
      const settingsSuffix = settingsPath ? ` --settings ${shQuote(settingsPath)}` : '';
      command = `claude${permissionSuffix} ${resumeTarget}${settingsSuffix}`;
      break;
    }
    case 'codex': {
      const resumeTarget = agentSessionId ? ` ${shQuote(agentSessionId)}` : ' --last';
      command = `codex --no-alt-screen${permissionSuffix} resume${resumeTarget}`;
      break;
    }
    case 'opencode':
      command = buildOpencodeResumeCommand(
        agentSessionId,
        permissionSuffix,
        settings.opencodeScrollbackMode,
      );
      break;
    case 'pi': {
      const executable = await findPiCommand();
      if (!executable) throw new Error('Pi Coding Agent is no longer available');
      command = buildPiResumeCommand(
        options.piSessionPath ?? agentSessionId,
        options.piSessionMode,
        executable,
      );
      break;
    }
    default:
      command = assertNever(agent);
  }

  const rendererEnvironment = agent === 'claude'
    ? resolveClaudeRendererEnvironment(claudeRenderer === 'fullscreen'
      ? { claudeRenderer: 'fullscreen' }
      : { claudeRenderer: 'classic', terminalFixedCols: CLAUDE_TERMINAL_COLS })
    : null;
  const activityIncarnationId = options.activityIncarnationId ?? await ensureTmuxPaneIncarnationOption(paneId);
  const paneEnv: Record<string, string> = {
    AUMX_ACTIVITY_JOURNAL: options.activityJournal ?? getPaneActivityJournalPath(activityIncarnationId),
    AUMX_PANE_ID: options.aumxPaneId ?? paneId,
    AUMX_PANE_INCARNATION_ID: activityIncarnationId,
    AUMX_ACTIVITY_ADAPTER_SUPPORT: activityAdapter.support,
    AUMX_ACTIVITY_ADAPTER_VERSION: activityAdapter.version ?? 'unknown',
    AUMX_ACTIVITY_ADAPTER_CAPABILITIES: JSON.stringify(activityAdapter.capabilities),
    ...rendererEnvironment?.set,
  };
  const claudeEnvUnsets = rendererEnvironment
    ? [...CLAUDE_ENV_UNSETS, ...rendererEnvironment.unset]
    : CLAUDE_ENV_UNSETS;
  const hiddenCommand = agent === 'claude'
    ? withHiddenAgentTerminalEnvironment(command, paneEnv, claudeEnvUnsets)
    : withHiddenAgentTerminalEnvironment(command, paneEnv);

  log.info(`[resumeAgentInPane] Sending resume command to pane ${paneId}: ${command}`, 'paneCreation');
  await tmuxService.respawnPane({
    command: withInteractiveShellAfterCommand(hiddenCommand),
    paneId,
  });

  if (agent === 'claude') {
    autoApproveTrustPrompt(paneId).catch(() => {});
  }
  return true;
}

function buildOpencodeResumeCommand(
  agentSessionId: string | undefined,
  permissionSuffix: string,
  scrollbackMode: boolean | undefined,
): string {
  const sessionTarget = agentSessionId ? `--session ${shQuote(agentSessionId)}` : '--continue';
  return `${getOpencodeTuiCommand(scrollbackMode)} ${sessionTarget}${permissionSuffix}`;
}
