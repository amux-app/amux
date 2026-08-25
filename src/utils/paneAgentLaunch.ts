import * as fs from 'fs';
import path from 'path';
import { agentHasCapability, assertNever } from '../agents/agent-contract.js';
import { buildPiFlags } from '../agents/pi-runtime.js';
import { TmuxService } from '../services/TmuxService.js';
import type { MuxBaseSettings } from '../types.js';
import { type AgentName, getCodexEffortFlags, getCodexModelFlags, getEffortFlags, getModelFlags, getOpencodeModelFlags, getOpencodeTuiCommand, getOpencodeVariantFlags, getPermissionFlags, getReadOnlyFlags } from './agentLaunch.js';
import {
  CLAUDE_ENV_UNSETS,
  withAgentTerminalEnvironment,
  withHiddenAgentTerminalEnvironment,
  withInteractiveShellAfterCommand,
} from './agentTerminalEnvironment.js';
import { autoApproveTrustPrompt } from './autoApproveTrustPrompt.js';
import { ensureClaudeSessionHookSettings, ensureClaudeSessionShellWrapper } from './claudeSessionRegistry.js';
import { prepareActivityAdapter, type PreparedActivityAdapter } from './activityAdapters.js';
import { findPiCommand } from './agentDetection.js';
import { waitForAgentReady } from './paneCreationReadiness.js';
import {
  resolveClaudeRendererEnvironment,
  type PaneTerminalProfile,
} from './paneTerminalProfile.js';
import {
  buildPromptReadAndDeleteSnippet,
  writePromptFile,
} from './promptStore.js';
import { shQuote } from './shellEscape.js';
import { getProjectMetadataDir } from './worktreePaths.js';

interface AgentLaunchOptions {
  agent?: AgentName;
  agentPrompt: string;
  muxbasePaneId: string;
  activityJournal?: string;
  activityIncarnationId?: string;
  enableActivityAdapters?: boolean;
  cwd: string;
  paneId: string;
  projectRoot: string;
  promptMode: 'argument' | 'input';
  readOnly?: boolean;
  settings: Pick<MuxBaseSettings, 'permissionMode'> & {
    claudeModel?: string;
    claudeEffort?: string;
    codexModel?: string;
    codexEffort?: string;
    opencodeModel?: string;
    opencodeScrollbackMode?: boolean;
    opencodeVariant?: string;
    piModel?: string;
    piThinking?: string;
  };
  slug: string;
  terminalProfile: PaneTerminalProfile;
  tmuxService: TmuxService;
  /** When set, Claude Code is configured to push OpenTelemetry data to this OTLP-JSON endpoint. */
  otlpEndpoint?: string;
}

interface PromptCommandOptions {
  commandPrefix: string;
  extraEnv?: Record<string, string>;
  extraUnsets?: readonly string[];
  inlinePrefix: string;
  optionTerminator?: string;
  projectRoot: string;
  prompt: string;
  promptFileEnabled?: boolean;
  promptSnippetCommand: string;
  slug: string;
}

export async function launchAgentInPane(options: AgentLaunchOptions): Promise<void> {
  if (!options.agent) return;
  if (options.readOnly && !agentHasCapability(options.agent, 'review')) {
    throw new Error(`${options.agent} does not support review mode`);
  }

  switch (options.agent) {
    case 'claude':
      await launchClaude(options);
      return;
    case 'codex':
      await launchCodex(options);
      return;
    case 'opencode':
      await launchOpencode(options);
      return;
    case 'pi':
      await launchPi(options);
      return;
    default:
      assertNever(options.agent);
  }
}

async function launchClaude(options: AgentLaunchOptions): Promise<void> {
  const { terminalProfile } = options;
  if (terminalProfile.claudeRenderer !== 'classic'
    && terminalProfile.claudeRenderer !== 'fullscreen') {
    throw new Error('Claude launch requires a resolved terminal profile');
  }
  const rendererEnvironment = resolveClaudeRendererEnvironment(terminalProfile);
  const permissionSuffix = resolvePermissionSuffix('claude', options, options.settings.permissionMode);
  const claudeSuffix = buildClaudeFlagsSuffix(options.settings);
  const mcpSuffix = buildMcpSuffix(options.readOnly ? options.cwd : options.projectRoot);
  const adapter = await prepareActivityAdapter('claude', true);
  const settingsPath = adapter.installed ? ensureClaudeSessionHookSettings() : null;
  const settingsSuffix = settingsPath ? ` --settings ${shQuote(settingsPath)}` : '';
  const shellWrapperDir = settingsPath ? ensureClaudeSessionShellWrapper(settingsPath) : null;
  const fallbackShellSetup = shellWrapperDir ? buildClaudeFallbackShellSetup(shellWrapperDir) : undefined;
  const paneEnv: Record<string, string> = {
    ...activityEnvironment(options),
    ...adapterEnvironment(adapter),
    MUXBASE_PANE_ID: options.muxbasePaneId,
    ...rendererEnvironment.set,
  };
  const claudeEnvUnsets = [...CLAUDE_ENV_UNSETS, ...rendererEnvironment.unset];
  if (options.otlpEndpoint) {
    // Tell Claude Code to push OpenTelemetry to MuxBase's localhost receiver. Localhost only —
    // no external traffic. Set both general and signal-specific endpoints because some OTLP
    // SDK implementations don't auto-append `/v1/metrics` to the general endpoint.
    paneEnv.CLAUDE_CODE_ENABLE_TELEMETRY = '1';
    paneEnv.OTEL_METRICS_EXPORTER = 'otlp';
    paneEnv.OTEL_LOGS_EXPORTER = 'otlp';
    paneEnv.OTEL_EXPORTER_OTLP_PROTOCOL = 'http/json';
    paneEnv.OTEL_EXPORTER_OTLP_ENDPOINT = options.otlpEndpoint;
    paneEnv.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT = `${options.otlpEndpoint}/v1/metrics`;
    paneEnv.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT = `${options.otlpEndpoint}/v1/logs`;
    paneEnv.OTEL_METRIC_EXPORT_INTERVAL = '10000';
  }
  if (options.settings.claudeEffort === 'ultracode') {
    paneEnv.MUXBASE_ULTRACODE = '1';
  }
  const inlinePrefix = 'claude';
  const commandPrefix = `claude${permissionSuffix}${claudeSuffix}${mcpSuffix}${settingsSuffix}`;

  if (options.promptMode === 'input' && hasInitialPrompt(options.agentPrompt)) {
    await sendInteractivePrompt(
      options,
      'claude',
      withHiddenAgentTerminalEnvironment(commandPrefix, paneEnv, claudeEnvUnsets),
      400,
      paneEnv,
      fallbackShellSetup,
    );
  } else {
    const command = hasInitialPrompt(options.agentPrompt)
      ? await buildPromptCommand({
        commandPrefix,
        extraEnv: paneEnv,
        extraUnsets: claudeEnvUnsets,
        inlinePrefix,
        projectRoot: options.projectRoot,
        prompt: options.agentPrompt,
        promptFileEnabled: process.env.MUXBASE_E2E !== '1',
        promptSnippetCommand: withAgentTerminalEnvironment(
          `claude "$MUXBASE_PROMPT_CONTENT"${permissionSuffix}${claudeSuffix}${mcpSuffix}${settingsSuffix}`,
          paneEnv,
          claudeEnvUnsets,
        ),
        slug: options.slug,
      })
      : withHiddenAgentTerminalEnvironment(commandPrefix, paneEnv, claudeEnvUnsets);
    await startAgentCommand(options.tmuxService, options.paneId, command, options.cwd, paneEnv, fallbackShellSetup);

    if (process.env.MUXBASE_E2E === '1' && hasInitialPrompt(options.agentPrompt)) {
      const started = await waitForAgentReady(options.tmuxService, options.paneId, 'claude', 15000);
      if (started) {
        await wait(500);
        await options.tmuxService.sendTmuxKeys(options.paneId, 'Enter');
      }
    }
  }

  autoApproveTrustPrompt(options.paneId, options.agentPrompt).catch(() => {});
}

function activityEnvironment(options: Pick<AgentLaunchOptions, 'activityIncarnationId' | 'activityJournal' | 'muxbasePaneId'>): Record<string, string> {
  if (!options.activityJournal || !options.activityIncarnationId) return {};
  return {
    MUXBASE_ACTIVITY_JOURNAL: options.activityJournal,
    MUXBASE_PANE_ID: options.muxbasePaneId,
    MUXBASE_PANE_INCARNATION_ID: options.activityIncarnationId,
  };
}

function adapterEnvironment(adapter: PreparedActivityAdapter): Record<string, string> {
  return {
    MUXBASE_ACTIVITY_ADAPTER_SUPPORT: adapter.support,
    MUXBASE_ACTIVITY_ADAPTER_VERSION: adapter.version ?? 'unknown',
    MUXBASE_ACTIVITY_ADAPTER_CAPABILITIES: JSON.stringify(adapter.capabilities),
  };
}

async function launchCodex(options: AgentLaunchOptions): Promise<void> {
  const permissionSuffix = resolvePermissionSuffix('codex', options, options.settings.permissionMode);
  const codexSuffix = buildCodexFlagsSuffix(options.settings);
  // Codex exposes an official inline mode specifically to preserve terminal
  // scrollback. Keep MuxBase's terminal history authoritative instead of trying
  // to reconstruct content repainted in Codex's alternate screen.
  const commandPrefix = `codex --no-alt-screen${permissionSuffix}${codexSuffix}`;
  const adapter = await prepareActivityAdapter('codex', options.enableActivityAdapters === true);
  const paneEnv = { ...activityEnvironment(options), ...adapterEnvironment(adapter) };

  if (options.promptMode === 'input' && hasInitialPrompt(options.agentPrompt)) {
    await sendInteractivePrompt(options, 'codex', withHiddenAgentTerminalEnvironment(commandPrefix, paneEnv), 0, paneEnv);
    return;
  }

  const command = hasInitialPrompt(options.agentPrompt)
    ? await buildPromptCommand({
      commandPrefix,
      extraEnv: paneEnv,
      inlinePrefix: commandPrefix,
      projectRoot: options.projectRoot,
      prompt: options.agentPrompt,
      promptSnippetCommand: withAgentTerminalEnvironment(`${commandPrefix} "$MUXBASE_PROMPT_CONTENT"`, paneEnv),
      slug: options.slug,
    })
    : withHiddenAgentTerminalEnvironment(commandPrefix, paneEnv);
  await startAgentCommand(options.tmuxService, options.paneId, command, options.cwd, paneEnv);
}

async function launchOpencode(options: AgentLaunchOptions): Promise<void> {
  const permissionSuffix = resolvePermissionSuffix('opencode', options, options.settings.permissionMode);
  const runFlagsSuffix = buildOpencodeRunFlagsSuffix(options.settings);
  const tuiFlagsSuffix = buildOpencodeTuiFlagsSuffix(options.settings);
  const commandPrefix = `opencode run --interactive${runFlagsSuffix}${permissionSuffix}`;
  const tuiCommand = `${getOpencodeTuiCommand(options.settings.opencodeScrollbackMode)}${tuiFlagsSuffix}${permissionSuffix}`;
  const adapter = await prepareActivityAdapter('opencode', options.enableActivityAdapters === true);
  // A live E2E run must exercise the installed TUI without an unrelated
  // network-driven updater modal taking over its alternate screen.
  const e2eEnvironment = process.env.MUXBASE_E2E === '1'
    ? { OPENCODE_DISABLE_AUTOUPDATE: '1' }
    : undefined;
  const paneEnv = { ...activityEnvironment(options), ...adapterEnvironment(adapter), ...e2eEnvironment };

  if (options.promptMode === 'input' && hasInitialPrompt(options.agentPrompt)) {
    await sendInteractivePrompt(
      options,
      'opencode',
      withHiddenAgentTerminalEnvironment(tuiCommand, paneEnv),
      0,
      paneEnv,
    );
    return;
  }

  const command = hasInitialPrompt(options.agentPrompt)
    ? await buildPromptCommand({
      commandPrefix,
      extraEnv: paneEnv,
      inlinePrefix: commandPrefix,
      optionTerminator: '--',
      projectRoot: options.projectRoot,
      prompt: options.agentPrompt,
      promptSnippetCommand: withAgentTerminalEnvironment(
        `${commandPrefix} -- "$MUXBASE_PROMPT_CONTENT"`,
        paneEnv,
      ),
      slug: options.slug,
    })
    : withHiddenAgentTerminalEnvironment(tuiCommand, paneEnv);
  await startAgentCommand(options.tmuxService, options.paneId, command, options.cwd, paneEnv);
}

async function launchPi(options: AgentLaunchOptions): Promise<void> {
  const adapter = await prepareActivityAdapter('pi', options.enableActivityAdapters === true);
  const executable = await findPiCommand();
  if (!executable) throw new Error('Pi Coding Agent is no longer available');
  const flags = buildPiFlags({
    model: options.settings.piModel,
    effort: options.settings.piThinking,
  });
  const commandPrefix = `${shQuote(executable)}${flags}`;
  const paneEnv = { ...activityEnvironment(options), ...adapterEnvironment(adapter) };

  if (options.promptMode === 'input' && hasInitialPrompt(options.agentPrompt)) {
    await sendInteractivePrompt(options, 'pi', withHiddenAgentTerminalEnvironment(commandPrefix, paneEnv), 0, paneEnv);
    return;
  }

  const prompt = disambiguatePiPrompt(options.agentPrompt);
  const command = hasInitialPrompt(options.agentPrompt)
    ? await buildPromptCommand({
      commandPrefix,
      extraEnv: paneEnv,
      inlinePrefix: commandPrefix,
      projectRoot: options.projectRoot,
      prompt,
      promptSnippetCommand: withAgentTerminalEnvironment(`${commandPrefix} "$MUXBASE_PROMPT_CONTENT"`, paneEnv),
      slug: options.slug,
    })
    : withHiddenAgentTerminalEnvironment(commandPrefix, paneEnv);
  await startAgentCommand(options.tmuxService, options.paneId, command, options.cwd, paneEnv);
}

function disambiguatePiPrompt(prompt: string): string {
  // Pi has no `--` option terminator: a leading dash is parsed as an option and
  // `@` as a file reference. One leading space keeps the request intact while
  // making it an unambiguous positional message in both prompt launch paths.
  return prompt.startsWith('-') || prompt.startsWith('@') ? ` ${prompt}` : prompt;
}

async function sendInteractivePrompt(
  options: AgentLaunchOptions,
  agent: AgentName,
  command: string,
  inputDelayMs: number = 0,
  extraEnv?: Record<string, string>,
  fallbackShellSetup?: string,
): Promise<void> {
  await startAgentCommand(options.tmuxService, options.paneId, command, options.cwd, extraEnv, fallbackShellSetup);
  const started = await waitForAgentReady(options.tmuxService, options.paneId, agent, 15000);
  if (!started) {
    await wait(600);
  }
  if (inputDelayMs > 0) {
    await wait(inputDelayMs);
  }
  await sendPromptText(options.tmuxService, options.paneId, options.agentPrompt);
  await options.tmuxService.sendTmuxKeys(options.paneId, 'Enter');
}

async function buildPromptCommand(options: PromptCommandOptions): Promise<string> {
  let promptFilePath: string | null = null;
  if (options.promptFileEnabled !== false) {
    try {
      promptFilePath = await writePromptFile(options.projectRoot, options.slug, options.prompt);
    } catch {
    }
  }

  if (promptFilePath) {
    return buildPromptReadAndDeleteSnippet(
      promptFilePath,
      options.promptSnippetCommand,
    );
  }

  const optionTerminator = options.optionTerminator ? `${options.optionTerminator} ` : '';
  return withHiddenAgentTerminalEnvironment(
    `${options.inlinePrefix} ${optionTerminator}"${escapePrompt(options.prompt)}"${options.commandPrefix.slice(options.inlinePrefix.length)}`,
    options.extraEnv,
    options.extraUnsets,
  );
}

function buildPermissionSuffix(
  agent: AgentName,
  permissionMode: MuxBaseSettings['permissionMode'] | '',
): string {
  const permissionFlags = getPermissionFlags(agent, permissionMode);
  return permissionFlags ? ` ${permissionFlags}` : '';
}

function resolvePermissionSuffix(
  agent: AgentName,
  options: AgentLaunchOptions,
  permissionMode: MuxBaseSettings['permissionMode'] | '',
): string {
  if (options.readOnly) {
    const readOnlyFlags = getReadOnlyFlags(agent);
    return readOnlyFlags ? ` ${readOnlyFlags}` : '';
  }
  return buildPermissionSuffix(agent, permissionMode);
}

function buildMcpSuffix(projectRoot: string): string {
  // For E2E tests, hard-isolate MCP servers: empty config + --strict-mcp-config so no
  // user-scope / project-scope servers leak into the test agent.
  if (process.env.MUXBASE_E2E === '1') {
    const mcpDir = getProjectMetadataDir(projectRoot);
    const mcpConfigPath = path.join(mcpDir, 'e2e-mcp-config.json');
    fs.mkdirSync(mcpDir, { recursive: true });
    fs.writeFileSync(mcpConfigPath, JSON.stringify({ mcpServers: {} }));
    return ` --strict-mcp-config --mcp-config ${shQuote(mcpConfigPath)}`;
  }

  // Production: don't inject any MCP config. Claude Code already has native
  // Read/Write/Edit/Bash for filesystem work, and injecting an mcp__filesystem
  // server would burn context on redundant tool schemas every turn. Users who
  // want their own MCP servers can configure them via Claude's own settings.
  return '';
}

function buildClaudeFallbackShellSetup(wrapperDir: string): string {
  return `export MUXBASE_CLAUDE_ORIGINAL_PATH="$PATH"; export PATH=${shQuote(wrapperDir)}:"$PATH"`;
}

function buildClaudeFlagsSuffix(
  settings: { claudeModel?: string; claudeEffort?: string },
): string {
  const modelFlags = getModelFlags('claude', settings.claudeModel);
  const effortFlags = getEffortFlags('claude', settings.claudeEffort);
  const parts = [modelFlags, effortFlags].filter(Boolean);
  return parts.length > 0 ? ` ${parts.join(' ')}` : '';
}

function buildCodexFlagsSuffix(
  settings: { codexModel?: string; codexEffort?: string },
): string {
  const modelFlags = getCodexModelFlags(settings.codexModel);
  const effortFlags = getCodexEffortFlags(settings.codexEffort);
  const parts = [modelFlags, effortFlags].filter(Boolean);
  return parts.length > 0 ? ` ${parts.join(' ')}` : '';
}

function buildOpencodeRunFlagsSuffix(
  settings: { opencodeModel?: string; opencodeVariant?: string },
): string {
  const modelFlags = getOpencodeModelFlags(settings.opencodeModel);
  const variantFlags = getOpencodeVariantFlags(settings.opencodeVariant);
  const parts = [modelFlags, variantFlags].filter(Boolean);
  return parts.length > 0 ? ` ${parts.join(' ')}` : '';
}

function buildOpencodeTuiFlagsSuffix(settings: { opencodeModel?: string }): string {
  // `--variant` belongs to `opencode run`; the bare TUI rejects it and exits
  // after printing help. The TUI does support selecting the configured model.
  const modelFlags = getOpencodeModelFlags(settings.opencodeModel);
  return modelFlags ? ` ${modelFlags}` : '';
}

function escapePrompt(prompt: string): string {
  return prompt
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/`/g, '\\`')
    .replace(/\$/g, '\\$');
}

function hasInitialPrompt(prompt: string): boolean {
  return !!(prompt && prompt.trim());
}

async function startAgentCommand(
  tmuxService: TmuxService,
  paneId: string,
  command: string,
  cwd: string,
  extraEnv?: Record<string, string>,
  fallbackShellSetup?: string,
): Promise<void> {
  await tmuxService.respawnPane({
    command: withInteractiveShellAfterCommand(command, extraEnv, fallbackShellSetup),
    cwd,
    paneId,
  });
}

async function sendPromptText(
  tmuxService: TmuxService,
  paneId: string,
  prompt: string,
): Promise<void> {
  const lines = prompt.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim().length > 0) {
      await tmuxService.sendShellCommand(paneId, line);
    }
    if (i < lines.length - 1) {
      await tmuxService.sendTmuxKeys(paneId, 'Enter');
    }
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
