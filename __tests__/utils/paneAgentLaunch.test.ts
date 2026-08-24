import * as fs from 'fs';
import * as os from 'os';
import path from 'path';
import { describe, expect, it, vi } from 'vitest';
import type { TmuxService } from '../../src/services/TmuxService.js';
import type { AumxSettings } from '../../src/types.js';
import { launchAgentInPane } from '../../src/utils/paneAgentLaunch.js';
import { resolvePaneTerminalProfile } from '../../src/utils/paneTerminalProfile.js';

vi.mock('../../src/utils/claudeSessionRegistry.js', () => ({
  ensureClaudeSessionHookSettings: () => '/tmp/aumx-hook.settings.json',
  ensureClaudeSessionShellWrapper: () => '/tmp/aumx-claude-bin',
}));

const ensureCodexActivityHookSettingsMock = vi.hoisted(() => vi.fn(() => '/tmp/aumx-codex-hooks.json'));
vi.mock('../../src/utils/codexActivityRegistry.js', () => ({
  ensureCodexActivityHookSettings: ensureCodexActivityHookSettingsMock,
}));

vi.mock('../../src/utils/paneCreationReadiness.js', () => ({
  waitForAgentReady: vi.fn(async () => true),
}));

vi.mock('../../src/utils/agentDetection.js', () => ({
  findPiCommand: vi.fn(async () => '/verified/pi'),
}));

type LaunchTmuxService = TmuxService & {
  respawnPane: ReturnType<typeof vi.fn>;
  sendShellCommand: ReturnType<typeof vi.fn>;
  sendTmuxKeys: ReturnType<typeof vi.fn>;
};

function createTmuxService(): LaunchTmuxService {
  return {
    respawnPane: vi.fn().mockResolvedValue(undefined),
    sendShellCommand: vi.fn().mockResolvedValue(undefined),
    sendTmuxKeys: vi.fn().mockResolvedValue(undefined),
  } as unknown as LaunchTmuxService;
}

function launch(
  options: Omit<Parameters<typeof launchAgentInPane>[0], 'terminalProfile'>,
): Promise<void> {
  return launchAgentInPane({
    ...options,
    terminalProfile: resolvePaneTerminalProfile(options.agent, options.settings),
  });
}

describe('paneAgentLaunch', () => {
  it('installs the Codex lifecycle adapter only after explicit user consent', async () => {
    const tmuxService = createTmuxService();
    const settings = { permissionMode: 'auto' } satisfies Pick<AumxSettings, 'permissionMode'>;

    await launch({
      agent: 'codex',
      agentPrompt: '',
      aumxPaneId: 'aumx-codex',
      activityJournal: '/tmp/aumx-codex.ndjson',
      activityIncarnationId: 'incarnation-1',
      cwd: '/tmp/aumx-worktree',
      enableActivityAdapters: true,
      paneId: '%1',
      projectRoot: '/tmp/aumx-project',
      promptMode: 'argument',
      settings,
      slug: 'task',
      tmuxService,
    });

    expect(ensureCodexActivityHookSettingsMock).toHaveBeenCalledOnce();
  });

  it.each([
    ['claude', 'claude'],
    ['codex', 'codex'],
    ['opencode', 'opencode'],
    ['pi', 'pi'],
  ] as const)('starts hidden %s commands through tmux respawn without echoing the launch command', async (agent, commandName) => {
    // Arrange
    const tmuxService = createTmuxService();
    const settings = {
      permissionMode: 'auto',
    } satisfies Pick<AumxSettings, 'permissionMode'>;

    // Act
    await launch({
      agent,
      agentPrompt: '',
      aumxPaneId: 'aumx-test',
      cwd: '/tmp/aumx-worktree',
      paneId: '%1',
      projectRoot: '/tmp/aumx-project',
      promptMode: 'argument',
      settings,
      slug: 'task',
      tmuxService,
    });

    // Assert
    const respawnCommand = tmuxService.respawnPane.mock.calls[0]?.[0]?.command ?? '';
    expect(respawnCommand).toMatch(/^sh -c /);
    expect(tmuxService.respawnPane).toHaveBeenCalledWith({
      command: expect.stringContaining(commandName),
      cwd: '/tmp/aumx-worktree',
      paneId: '%1',
    });
    expect(tmuxService.respawnPane).toHaveBeenCalledWith({
      command: expect.stringContaining('exec env -u NO_COLOR'),
      cwd: '/tmp/aumx-worktree',
      paneId: '%1',
    });
    expect(tmuxService.respawnPane).toHaveBeenCalledWith({
      command: expect.stringContaining('exec "${SHELL:-/bin/sh}"'),
      cwd: '/tmp/aumx-worktree',
      paneId: '%1',
    });
    if (agent === 'claude') {
      expect(respawnCommand).toContain('export AUMX_PANE_ID=');
      expect(respawnCommand).toContain('aumx-test');
      expect(respawnCommand).toContain('AUMX_CLAUDE_ORIGINAL_PATH');
      expect(respawnCommand).toContain('export PATH=');
      expect(respawnCommand).toContain('/tmp/aumx-claude-bin');
      expect(respawnCommand).toContain('--settings');
    } else {
      expect(respawnCommand).not.toContain('AUMX_PANE_ID');
    }
    if (agent === 'codex') expect(respawnCommand).toContain('codex --no-alt-screen');
    if (agent === 'opencode') expect(respawnCommand).not.toContain('opencode --mini');
    expect(tmuxService.sendShellCommand).not.toHaveBeenCalled();
    expect(tmuxService.sendTmuxKeys).not.toHaveBeenCalled();
  });

  it('runs read-only codex review through the sandbox flags with the rubric prompt', async () => {
    // Arrange
    const tmuxService = createTmuxService();
    const settings = { permissionMode: '' } satisfies Pick<AumxSettings, 'permissionMode'>;

    // Act
    await launch({
      agent: 'codex',
      agentPrompt: 'review the changes',
      aumxPaneId: 'aumx-review',
      cwd: '/tmp/aumx-review-worktree',
      paneId: '%2',
      projectRoot: '/tmp/aumx-project',
      promptMode: 'argument',
      readOnly: true,
      settings,
      slug: 'review-task',
      tmuxService,
    });

    // Assert: read-only Codex (not the native `codex review` subcommand) WITH the prompt
    const respawnCommand = tmuxService.respawnPane.mock.calls[0]?.[0]?.command ?? '';
    expect(respawnCommand).toContain('--sandbox read-only --ask-for-approval never');
    expect(respawnCommand).toContain('AUMX_PROMPT_CONTENT');
    expect(respawnCommand).not.toContain('codex review');
  });

  it('launches opencode reviews through the read-only plan agent', async () => {
    // Arrange
    const tmuxService = createTmuxService();
    const settings = { permissionMode: '' } satisfies Pick<AumxSettings, 'permissionMode'>;

    // Act
    await launch({
      agent: 'opencode',
      agentPrompt: 'review the changes',
      aumxPaneId: 'aumx-review',
      cwd: '/tmp/aumx-review-worktree',
      paneId: '%2',
      projectRoot: '/tmp/aumx-project',
      promptMode: 'argument',
      readOnly: true,
      settings,
      slug: 'review-task',
      tmuxService,
    });

    // Assert
    const respawnCommand = tmuxService.respawnPane.mock.calls[0]?.[0]?.command ?? '';
    expect(respawnCommand).toContain('opencode run --interactive --agent plan');
  });

  it('does not inject an mcp filesystem server into claude review panes', async () => {
    // Arrange
    const tmuxService = createTmuxService();
    const settings = { permissionMode: '' } satisfies Pick<AumxSettings, 'permissionMode'>;
    const worktreeDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'aumx-review-cwd-'));
    const projectRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'aumx-review-project-'));

    try {
      // Act
      await launch({
        agent: 'claude',
        agentPrompt: 'review the changes',
        aumxPaneId: 'aumx-review',
        cwd: worktreeDir,
        paneId: '%3',
        projectRoot,
        promptMode: 'argument',
        readOnly: true,
        settings,
        slug: 'review-task',
        tmuxService,
      });

      // Assert: --permission-mode plan still applied, but no MCP filesystem server is injected —
      // Claude Code's native Read/Write/Edit/Bash cover filesystem work without burning context
      // on redundant mcp__filesystem tool schemas every turn.
      const respawnCommand = tmuxService.respawnPane.mock.calls[0]?.[0]?.command ?? '';
      expect(respawnCommand).toContain('--permission-mode plan');
      expect(respawnCommand).not.toContain('--mcp-config');
      expect(fs.existsSync(path.join(worktreeDir, '.aumx', 'mcp-config.json'))).toBe(false);
      expect(fs.existsSync(path.join(projectRoot, '.aumx', 'mcp-config.json'))).toBe(false);
    } finally {
      await fs.promises.rm(worktreeDir, { recursive: true, force: true });
      await fs.promises.rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('does not inject an mcp filesystem server into claude impl panes', async () => {
    // Arrange
    const tmuxService = createTmuxService();
    const settings = {
      permissionMode: 'auto',
    } satisfies Pick<AumxSettings, 'permissionMode'>;
    const worktreeDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'aumx-impl-cwd-'));
    const projectRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'aumx-impl-project-'));

    try {
      // Act
      await launch({
        agent: 'claude',
        agentPrompt: '',
        aumxPaneId: 'aumx-impl',
        cwd: worktreeDir,
        paneId: '%4',
        projectRoot,
        promptMode: 'argument',
        settings,
        slug: 'impl-task',
        tmuxService,
      });

      // Assert: no --mcp-config flag, no mcp-config.json written under either root
      const respawnCommand = tmuxService.respawnPane.mock.calls[0]?.[0]?.command ?? '';
      expect(respawnCommand).not.toContain('--mcp-config');
      expect(fs.existsSync(path.join(projectRoot, '.aumx', 'mcp-config.json'))).toBe(false);
      expect(fs.existsSync(path.join(worktreeDir, '.aumx', 'mcp-config.json'))).toBe(false);
    } finally {
      await fs.promises.rm(worktreeDir, { recursive: true, force: true });
      await fs.promises.rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('starts opencode prompt sessions through direct interactive run mode', async () => {
    // Arrange
    const tmuxService = createTmuxService();
    const settings = {
      permissionMode: 'auto',
    } satisfies Pick<AumxSettings, 'permissionMode'>;

    // Act
    await launch({
      agent: 'opencode',
      agentPrompt: 'fix the failing tests',
      aumxPaneId: 'aumx-test',
      cwd: '/tmp/aumx-worktree',
      paneId: '%1',
      projectRoot: '/tmp/aumx-project',
      promptMode: 'argument',
      settings,
      slug: 'fix-tests',
      tmuxService,
    });

    // Assert
    expect(tmuxService.respawnPane).toHaveBeenCalledWith({
      command: expect.stringContaining('opencode run --interactive -- "$AUMX_PROMPT_CONTENT"'),
      cwd: '/tmp/aumx-worktree',
      paneId: '%1',
    });
  });

  it('passes claude --model and --effort flags from settings on no-prompt launches', async () => {
    // Arrange
    const tmuxService = createTmuxService();
    const settings = {
      permissionMode: 'auto',
      claudeModel: 'opus',
      claudeEffort: 'high',
    } satisfies Pick<AumxSettings, 'permissionMode' | 'claudeModel' | 'claudeEffort'>;

    // Act
    await launch({
      agent: 'claude',
      agentPrompt: '',
      aumxPaneId: 'aumx-test',
      cwd: '/tmp/aumx-worktree',
      paneId: '%1',
      projectRoot: '/tmp/aumx-project',
      promptMode: 'argument',
      settings,
      slug: 'task',
      tmuxService,
    });

    // Assert
    const respawnCommand = tmuxService.respawnPane.mock.calls[0]?.[0]?.command ?? '';
    expect(respawnCommand).toContain('--model');
    expect(respawnCommand).toContain('opus');
    expect(respawnCommand).toContain('--effort');
    expect(respawnCommand).toContain('high');
  });

  it('passes claude --model and --effort flags through the with-prompt launch path', async () => {
    // Arrange
    const tmuxService = createTmuxService();
    const settings = {
      permissionMode: 'auto',
      claudeModel: 'sonnet',
      claudeEffort: 'max',
    } satisfies Pick<AumxSettings, 'permissionMode' | 'claudeModel' | 'claudeEffort'>;

    // Act
    await launch({
      agent: 'claude',
      agentPrompt: 'do the thing',
      aumxPaneId: 'aumx-test',
      cwd: '/tmp/aumx-worktree',
      paneId: '%1',
      projectRoot: '/tmp/aumx-project',
      promptMode: 'argument',
      settings,
      slug: 'with-prompt',
      tmuxService,
    });

    // Assert
    const respawnCommand = tmuxService.respawnPane.mock.calls[0]?.[0]?.command ?? '';
    expect(respawnCommand).toContain('--model');
    expect(respawnCommand).toContain('sonnet');
    expect(respawnCommand).toContain('--effort');
    expect(respawnCommand).toContain('max');
  });

  it('translates claudeEffort=ultracode to --effort xhigh and exports AUMX_ULTRACODE=1', async () => {
    // Arrange
    const tmuxService = createTmuxService();
    const settings = {
      permissionMode: 'auto',
      claudeModel: 'opus',
      claudeEffort: 'ultracode',
    } satisfies Pick<AumxSettings, 'permissionMode' | 'claudeModel' | 'claudeEffort'>;

    // Act
    await launch({
      agent: 'claude',
      agentPrompt: '',
      aumxPaneId: 'aumx-test',
      cwd: '/tmp/aumx-worktree',
      paneId: '%1',
      projectRoot: '/tmp/aumx-project',
      promptMode: 'argument',
      settings,
      slug: 'task',
      tmuxService,
    });

    // Assert
    const respawnCommand = tmuxService.respawnPane.mock.calls[0]?.[0]?.command ?? '';
    expect(respawnCommand).toContain('--effort');
    expect(respawnCommand).toContain('xhigh');
    expect(respawnCommand).not.toContain("'ultracode'");
    expect(respawnCommand).toContain('AUMX_ULTRACODE=');
  });

  it('does not export AUMX_ULTRACODE when effort is anything other than ultracode', async () => {
    // Arrange
    const tmuxService = createTmuxService();
    const settings = {
      permissionMode: 'auto',
      claudeModel: 'opus',
      claudeEffort: 'high',
    } satisfies Pick<AumxSettings, 'permissionMode' | 'claudeModel' | 'claudeEffort'>;

    // Act
    await launch({
      agent: 'claude',
      agentPrompt: '',
      aumxPaneId: 'aumx-test',
      cwd: '/tmp/aumx-worktree',
      paneId: '%1',
      projectRoot: '/tmp/aumx-project',
      promptMode: 'argument',
      settings,
      slug: 'task',
      tmuxService,
    });

    // Assert
    const respawnCommand = tmuxService.respawnPane.mock.calls[0]?.[0]?.command ?? '';
    expect(respawnCommand).not.toContain('AUMX_ULTRACODE');
  });

  it('forces classic in both directions when the resolved test profile is classic', async () => {
    // Arrange
    const tmuxService = createTmuxService();
    const settings = {
      permissionMode: 'auto',
      claudeModel: 'opus',
      claudeFullscreenRendering: false,
    } satisfies Pick<AumxSettings, 'permissionMode' | 'claudeModel' | 'claudeFullscreenRendering'>;

    // Act
    await launch({
      agent: 'claude',
      agentPrompt: '',
      aumxPaneId: 'aumx-test',
      cwd: '/tmp/aumx-worktree',
      paneId: '%1',
      projectRoot: '/tmp/aumx-project',
      promptMode: 'argument',
      settings,
      slug: 'task',
      tmuxService,
    });

    // Assert: classic is deterministic even if either variable is inherited.
    const respawnCommand = tmuxService.respawnPane.mock.calls[0]?.[0]?.command ?? '';
    expect(respawnCommand).toContain('-u CLAUDE_CODE_NO_FLICKER');
    expect(respawnCommand).toContain('CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=');
    expect(respawnCommand).not.toContain('CLAUDE_CODE_DISABLE_MOUSE');
  });

  it('exports CLAUDE_CODE_NO_FLICKER and keeps Claude mouse on in fullscreen mode', async () => {
    // Arrange
    const tmuxService = createTmuxService();
    const settings = {
      permissionMode: 'auto',
      claudeModel: 'opus',
      claudeFullscreenRendering: true,
    } satisfies Pick<AumxSettings, 'permissionMode' | 'claudeModel' | 'claudeFullscreenRendering'>;

    // Act
    await launch({
      agent: 'claude',
      agentPrompt: '',
      aumxPaneId: 'aumx-test',
      cwd: '/tmp/aumx-worktree',
      paneId: '%1',
      projectRoot: '/tmp/aumx-project',
      promptMode: 'argument',
      settings,
      slug: 'task',
      tmuxService,
    });

    // Assert: fullscreen on, but Claude keeps its mouse so the wheel scrolls its
    // conversation by line (passed through by the renderer). DISABLE_MOUSE must
    // NOT be set — that would break smooth wheel scrolling.
    const respawnCommand = tmuxService.respawnPane.mock.calls[0]?.[0]?.command ?? '';
    expect(respawnCommand).toContain('CLAUDE_CODE_NO_FLICKER=');
    expect(respawnCommand).toContain('-u CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN');
    expect(respawnCommand).not.toContain('CLAUDE_CODE_DISABLE_MOUSE');
  });

  it('keeps the exact fullscreen environment when an initial prompt falls back to an inline argument', async () => {
    const tmuxService = createTmuxService();

    await launch({
      agent: 'claude',
      agentPrompt: 'inspect the project',
      aumxPaneId: 'aumx-test',
      cwd: '/tmp/aumx-worktree',
      paneId: '%1',
      projectRoot: '/dev/null',
      promptMode: 'argument',
      settings: { permissionMode: 'auto', claudeFullscreenRendering: true },
      slug: 'task',
      tmuxService,
    });

    const respawnCommand = tmuxService.respawnPane.mock.calls[0]?.[0]?.command ?? '';
    expect(respawnCommand).toContain('CLAUDE_CODE_NO_FLICKER=');
    expect(respawnCommand).toContain('-u CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN');
  });

  it('unsets TMUX for Claude so it emits its truecolor brand palette', async () => {
    // Arrange
    const tmuxService = createTmuxService();
    const settings = {
      permissionMode: 'auto',
      claudeModel: 'opus',
    } satisfies Pick<AumxSettings, 'permissionMode' | 'claudeModel'>;

    // Act
    await launch({
      agent: 'claude',
      agentPrompt: '',
      aumxPaneId: 'aumx-test',
      cwd: '/tmp/aumx-worktree',
      paneId: '%1',
      projectRoot: '/tmp/aumx-project',
      promptMode: 'argument',
      settings,
      slug: 'task',
      tmuxService,
    });

    // Assert
    const respawnCommand = tmuxService.respawnPane.mock.calls[0]?.[0]?.command ?? '';
    expect(respawnCommand).toContain('-u TMUX');
  });

  it.each([
    ['prompt-file', '/tmp/aumx-project', 'argument'],
    ['inline-fallback', '/dev/null', 'argument'],
    ['interactive-input', '/tmp/aumx-project', 'input'],
  ] as const)('unsets TMUX for Claude in the %s launch path', async (_path, projectRoot, promptMode) => {
    const tmuxService = createTmuxService();

    await launch({
      agent: 'claude',
      agentPrompt: 'keep truecolor in every path',
      aumxPaneId: 'aumx-test',
      cwd: '/tmp',
      paneId: '%1',
      projectRoot,
      promptMode,
      settings: { permissionMode: 'auto' },
      slug: 'terminal-env',
      tmuxService,
    });

    const respawnCommand = tmuxService.respawnPane.mock.calls[0]?.[0]?.command ?? '';
    expect(respawnCommand).toContain('-u TMUX');
  });

  it.each(['codex', 'opencode'] as const)('does not unset TMUX for %s argument or input launches', async (agent) => {
    for (const promptMode of ['argument', 'input'] as const) {
      const tmuxService = createTmuxService();

      await launch({
        agent,
        agentPrompt: 'preserve native tmux behavior',
        aumxPaneId: 'aumx-test',
        cwd: '/tmp',
        paneId: '%1',
        projectRoot: '/tmp',
        promptMode,
        settings: { permissionMode: 'auto' },
        slug: 'terminal-env',
        tmuxService,
      });

      const respawnCommand = tmuxService.respawnPane.mock.calls[0]?.[0]?.command ?? '';
      expect(respawnCommand).not.toContain('-u TMUX');
      if (agent === 'codex') expect(respawnCommand).toContain('codex --no-alt-screen');
      if (agent === 'opencode' && promptMode === 'input') {
        expect(respawnCommand).not.toContain('opencode --mini');
      }
    }
  });

  it('uses the OpenCode mini interface only when scrollback-friendly mode is enabled', async () => {
    // Arrange
    const tmuxService = createTmuxService();
    const settings = {
      permissionMode: 'auto',
      opencodeScrollbackMode: true,
    } satisfies Pick<AumxSettings, 'permissionMode' | 'opencodeScrollbackMode'>;

    // Act
    await launch({
      agent: 'opencode',
      agentPrompt: 'inspect the project',
      aumxPaneId: 'aumx-test',
      cwd: '/tmp/aumx-worktree',
      paneId: '%1',
      projectRoot: '/tmp/aumx-project',
      promptMode: 'input',
      settings,
      slug: 'task',
      tmuxService,
    });

    // Assert
    const respawnCommand = tmuxService.respawnPane.mock.calls[0]?.[0]?.command ?? '';
    expect(respawnCommand).toContain('opencode --mini');
  });

  it('forces classic compatibility when claudeFullscreenRendering is false', async () => {
    // Arrange
    const tmuxService = createTmuxService();
    const settings = {
      permissionMode: 'auto',
      claudeModel: 'opus',
      claudeFullscreenRendering: false,
    } satisfies Pick<AumxSettings, 'permissionMode' | 'claudeModel' | 'claudeFullscreenRendering'>;

    // Act
    await launch({
      agent: 'claude',
      agentPrompt: '',
      aumxPaneId: 'aumx-test',
      cwd: '/tmp/aumx-worktree',
      paneId: '%1',
      projectRoot: '/tmp/aumx-project',
      promptMode: 'argument',
      settings,
      slug: 'task',
      tmuxService,
    });

    // Assert
    const respawnCommand = tmuxService.respawnPane.mock.calls[0]?.[0]?.command ?? '';
    expect(respawnCommand).toContain('-u CLAUDE_CODE_NO_FLICKER');
    expect(respawnCommand).toContain('CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=');
    expect(respawnCommand).not.toContain('CLAUDE_CODE_DISABLE_MOUSE');
  });

  it('omits claude --model and --effort flags when settings are empty', async () => {
    // Arrange
    const tmuxService = createTmuxService();
    const settings = {
      permissionMode: 'auto',
      claudeModel: '',
      claudeEffort: '',
    } satisfies Pick<AumxSettings, 'permissionMode' | 'claudeModel' | 'claudeEffort'>;

    // Act
    await launch({
      agent: 'claude',
      agentPrompt: '',
      aumxPaneId: 'aumx-test',
      cwd: '/tmp/aumx-worktree',
      paneId: '%1',
      projectRoot: '/tmp/aumx-project',
      promptMode: 'argument',
      settings,
      slug: 'task',
      tmuxService,
    });

    // Assert
    const respawnCommand = tmuxService.respawnPane.mock.calls[0]?.[0]?.command ?? '';
    expect(respawnCommand).not.toContain('--model');
    expect(respawnCommand).not.toContain('--effort');
  });

  it('passes codex --model and -c model_reasoning_effort flags from per-agent settings', async () => {
    // Arrange — Codex now reads its own codexModel/codexEffort keys (no longer leaks from claude settings)
    const tmuxService = createTmuxService();
    const settings = {
      permissionMode: 'auto',
      codexModel: 'gpt-5-codex',
      codexEffort: 'high',
    } satisfies Pick<AumxSettings, 'permissionMode' | 'codexModel' | 'codexEffort'>;

    // Act
    await launch({
      agent: 'codex',
      agentPrompt: '',
      aumxPaneId: 'aumx-test',
      cwd: '/tmp/aumx-worktree',
      paneId: '%1',
      projectRoot: '/tmp/aumx-project',
      promptMode: 'argument',
      settings,
      slug: 'task',
      tmuxService,
    });

    // Assert
    const respawnCommand = tmuxService.respawnPane.mock.calls[0]?.[0]?.command ?? '';
    expect(respawnCommand).toContain('--model');
    expect(respawnCommand).toContain('gpt-5-codex');
    expect(respawnCommand).toContain('-c');
    expect(respawnCommand).toContain('model_reasoning_effort=high');
    expect(respawnCommand).toContain('--sandbox workspace-write --ask-for-approval on-request');
    expect(respawnCommand).not.toContain('--effort');
  });

  it('omits codex model/effort flags when both are empty', async () => {
    // Arrange
    const tmuxService = createTmuxService();
    const settings = {
      permissionMode: 'auto',
      codexModel: '',
      codexEffort: '',
    } satisfies Pick<AumxSettings, 'permissionMode' | 'codexModel' | 'codexEffort'>;

    // Act
    await launch({
      agent: 'codex',
      agentPrompt: '',
      aumxPaneId: 'aumx-test',
      cwd: '/tmp/aumx-worktree',
      paneId: '%1',
      projectRoot: '/tmp/aumx-project',
      promptMode: 'argument',
      settings,
      slug: 'task',
      tmuxService,
    });

    // Assert
    const respawnCommand = tmuxService.respawnPane.mock.calls[0]?.[0]?.command ?? '';
    expect(respawnCommand).not.toContain('--model');
    expect(respawnCommand).not.toContain('model_reasoning_effort');
  });

  it('passes OpenCode model but omits the run-only variant on a bare TUI launch', async () => {
    // Arrange — OpenCode now reads its own opencodeModel/opencodeVariant keys
    const tmuxService = createTmuxService();
    const settings = {
      permissionMode: 'auto',
      opencodeModel: 'openai/gpt-5.5-fast',
      opencodeVariant: 'high',
    } satisfies Pick<AumxSettings, 'permissionMode' | 'opencodeModel' | 'opencodeVariant'>;

    // Act
    await launch({
      agent: 'opencode',
      agentPrompt: '',
      aumxPaneId: 'aumx-test',
      cwd: '/tmp/aumx-worktree',
      paneId: '%1',
      projectRoot: '/tmp/aumx-project',
      promptMode: 'argument',
      settings,
      slug: 'task',
      tmuxService,
    });

    // Assert
    const respawnCommand = tmuxService.respawnPane.mock.calls[0]?.[0]?.command ?? '';
    expect(respawnCommand).toContain('--model');
    expect(respawnCommand).toContain('openai/gpt-5.5-fast');
    expect(respawnCommand).not.toContain('--variant');
    // aumx must NOT pass codex/claude effort spellings to opencode
    expect(respawnCommand).not.toContain('--effort');
    expect(respawnCommand).not.toContain('model_reasoning_effort');
  });

  it('passes OpenCode model and variant to interactive run launches', async () => {
    const tmuxService = createTmuxService();
    const settings = {
      permissionMode: 'auto',
      opencodeModel: 'openai/gpt-5.5-fast',
      opencodeVariant: 'high',
    } satisfies Pick<AumxSettings, 'permissionMode' | 'opencodeModel' | 'opencodeVariant'>;

    await launch({
      agent: 'opencode',
      agentPrompt: 'inspect the project',
      aumxPaneId: 'aumx-test',
      cwd: '/tmp/aumx-worktree',
      paneId: '%1',
      projectRoot: '/tmp/aumx-project',
      promptMode: 'argument',
      settings,
      slug: 'task',
      tmuxService,
    });

    const respawnCommand = tmuxService.respawnPane.mock.calls[0]?.[0]?.command ?? '';
    expect(respawnCommand).toContain('opencode run --interactive');
    expect(respawnCommand).toContain('--model');
    expect(respawnCommand).toContain('openai/gpt-5.5-fast');
    expect(respawnCommand).toContain('--variant');
    expect(respawnCommand).toContain('high');
  });

  it('omits opencode --model when opencode keys are empty', async () => {
    // Arrange
    const tmuxService = createTmuxService();
    const settings = {
      permissionMode: 'auto',
      opencodeModel: '',
      opencodeVariant: '',
    } satisfies Pick<AumxSettings, 'permissionMode' | 'opencodeModel' | 'opencodeVariant'>;

    // Act
    await launch({
      agent: 'opencode',
      agentPrompt: '',
      aumxPaneId: 'aumx-test',
      cwd: '/tmp/aumx-worktree',
      paneId: '%1',
      projectRoot: '/tmp/aumx-project',
      promptMode: 'argument',
      settings,
      slug: 'task',
      tmuxService,
    });

    // Assert
    const respawnCommand = tmuxService.respawnPane.mock.calls[0]?.[0]?.command ?? '';
    expect(respawnCommand).not.toContain('--model');
    expect(respawnCommand).not.toContain('--variant');
  });

  it('launches Pi with explicit model and thinking overrides but no permission flag', async () => {
    const tmuxService = createTmuxService();
    const settings = {
      permissionMode: 'auto',
      piModel: 'openai/gpt-5.5',
      piThinking: 'high',
    } satisfies Pick<AumxSettings, 'permissionMode' | 'piModel' | 'piThinking'>;

    await launch({
      agent: 'pi',
      agentPrompt: 'inspect the project safely',
      aumxPaneId: 'aumx-pi',
      cwd: '/tmp/aumx-worktree',
      paneId: '%4',
      projectRoot: '/tmp/aumx-project',
      promptMode: 'argument',
      settings,
      slug: 'pi-task',
      tmuxService,
    });

    const command = tmuxService.respawnPane.mock.calls[0]?.[0]?.command ?? '';
    expect(command).toContain('/verified/pi');
    expect(command).toContain('--model');
    expect(command).toContain('openai/gpt-5.5');
    expect(command).toContain('--thinking');
    expect(command).toContain('high');
    expect(command).toContain('AUMX_PROMPT_CONTENT');
    expect(command).not.toContain('--permission-mode');
    expect(command).not.toContain('--sandbox');
    expect(command).not.toContain('--agent plan');
  });

  it.each(['- inspect the tests', '-- compare both approaches', '@review-notes'])(
    'passes syntax-sensitive Pi prompt %s as prompt content instead of CLI syntax',
    async (agentPrompt) => {
      const tmuxService = createTmuxService();
      const projectRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'aumx-pi-prompt-'));

      try {
        await launch({
          agent: 'pi',
          agentPrompt,
          aumxPaneId: 'aumx-pi',
          cwd: projectRoot,
          paneId: '%4',
          projectRoot,
          promptMode: 'argument',
          settings: { permissionMode: 'auto' },
          slug: 'pi-prompt',
          tmuxService,
        });

        const command = tmuxService.respawnPane.mock.calls[0]?.[0]?.command ?? '';
        const promptDirectory = path.join(projectRoot, '.amux', 'prompts');
        const [promptFile] = await fs.promises.readdir(promptDirectory);
        expect(await fs.promises.readFile(path.join(promptDirectory, promptFile), 'utf8'))
          .toBe(` ${agentPrompt}`);
        expect(command).toContain('rm -f "$AUMX_PROMPT_FILE"');
        expect(command).toContain('"$AUMX_PROMPT_CONTENT"');
        expect(command).not.toContain(agentPrompt);
      } finally {
        await fs.promises.rm(projectRoot, { recursive: true, force: true });
      }
    },
    15_000,
  );
});
