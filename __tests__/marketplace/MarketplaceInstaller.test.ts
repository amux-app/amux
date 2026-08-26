import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

vi.mock('../../src/services/marketplace/SkillTranslator.js', () => ({
  SkillTranslator: vi.fn().mockImplementation(() => ({
    installForAgent: vi.fn().mockReturnValue('/path/to/skill'),
    uninstallForAgent: vi.fn(),
  })),
}));

vi.mock('../../src/services/marketplace/AgentTranslator.js', () => ({
  AgentTranslator: vi.fn().mockImplementation(() => ({
    installForAgent: vi.fn().mockReturnValue('/path/to/agent'),
    uninstallForAgent: vi.fn(),
  })),
}));

vi.mock('../../src/services/marketplace/HookTranslator.js', () => ({
  HookTranslator: vi.fn().mockImplementation(() => ({
    translateForAgent: vi.fn().mockReturnValue({ status: 'full', path: '/path/to/hook', skipped: [] }),
    translateAllForAgent: vi.fn().mockReturnValue([{ status: 'full', path: '/path/to/hook', skipped: [] }]),
    uninstallForAgent: vi.fn(),
  })),
}));

vi.mock('../../src/services/marketplace/McpTranslator.js', () => ({
  McpTranslator: vi.fn().mockImplementation(() => ({
    installForAgent: vi.fn().mockReturnValue('/path/to/mcp'),
    uninstallForAgent: vi.fn(),
  })),
}));

vi.mock('../../src/services/marketplace/NativeInstaller.js', () => ({
  NativeInstaller: vi.fn().mockImplementation(() => ({
    supportsNative: vi.fn((agent: string, format?: string) => {
      if (agent === 'claude') return !format || format === 'claude-marketplace';
      if (agent === 'codex') return !format || format === 'codex-plugin';
      return false;
    }),
    install: vi.fn().mockReturnValue('/path/to/native'),
    uninstall: vi.fn(),
    getNativeCopyOperations: vi.fn(() => []),
    getNativeConfigurationPaths: vi.fn(() => []),
    isInstalled: vi.fn().mockReturnValue(false),
  })),
}));

import { MarketplaceInstaller } from '../../src/services/marketplace/MarketplaceInstaller.js';
import type { DetectedPlugin } from '../../src/services/marketplace/types.js';

describe('MarketplaceInstaller', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const skill of ['my-skill', 'skill-a', 'skill-b']) {
      mkdirSync(`/tmp/skills/${skill}`, { recursive: true });
      writeFileSync(`/tmp/skills/${skill}/SKILL.md`, `# ${skill}\n`);
    }
  });

  it('uses native install for claude/codex when nativeConfig provided with compatible format', async () => {
    const { NativeInstaller } = await import('../../src/services/marketplace/NativeInstaller.js');
    const mockNativeInstall = vi.fn().mockReturnValue('/path/to/native');
    (NativeInstaller as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      supportsNative: vi.fn((agent: string, format?: string) => {
        if (agent === 'claude') return !format || format === 'claude-marketplace';
        if (agent === 'codex') return !format || format === 'codex-plugin';
        return false;
      }),
      install: mockNativeInstall,
      uninstall: vi.fn(),
      getNativeCopyOperations: vi.fn(() => []),
      getNativeConfigurationPaths: vi.fn(() => []),
    }));

    const installer = new MarketplaceInstaller();
    const plugin: DetectedPlugin = {
      id: 'test-plugin',
      name: 'Test Plugin',
      skills: [{ name: 'my-skill', path: '/tmp/skills/my-skill/SKILL.md' }],
      agents: [],
      hooks: [],
      mcpServers: [],
      jsPlugins: [],
    };

    const nativeConfig = { marketplaceUrl: 'https://example.com/repo.git', marketplaceName: 'test-mp', pluginId: 'test-plugin' };
    const result = await installer.install(plugin, ['claude', 'codex', 'opencode'], nativeConfig);

    expect(result.agents.claude?.status).toBe('full');
    expect(result.agents.codex?.status).toBe('full');
    expect(result.agents.opencode?.status).toBe('full');
    expect(mockNativeInstall).toHaveBeenCalledWith(nativeConfig, 'claude');
    expect(mockNativeInstall).toHaveBeenCalledWith(nativeConfig, 'codex');
  });

  it('installs a native marketplace after preview accepts a safe internal symlink', async () => {
    const { NativeInstaller } = await import('../../src/services/marketplace/NativeInstaller.js');
    const clonePath = mkdtempSync(path.join(tmpdir(), 'muxbase-marketplace-'));
    writeFileSync(path.join(clonePath, 'AGENTS.md'), '# Shared instructions\n');
    symlinkSync('AGENTS.md', path.join(clonePath, 'CLAUDE.md'));
    const mockNativeInstall = vi.fn().mockReturnValue('/path/to/native');
    (NativeInstaller as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      supportsNative: vi.fn((agent: string) => agent === 'claude'),
      install: mockNativeInstall,
      uninstall: vi.fn(),
      getNativeCopyOperations: vi.fn(() => [{
        destinationPath: '/path/to/marketplace',
        name: 'marketplace clone',
        sourcePath: clonePath,
      }]),
      getNativeConfigurationPaths: vi.fn(() => []),
    }));
    const plugin: DetectedPlugin = {
      agents: [],
      hooks: [],
      id: 'test-plugin',
      jsPlugins: [],
      mcpServers: [],
      name: 'Test Plugin',
      skills: [],
    };
    const nativeConfig = {
      clonePath,
      marketplaceName: 'test-mp',
      marketplaceUrl: 'https://example.com/repo.git',
      pluginId: plugin.id,
      sourceFormat: 'claude-marketplace' as const,
    };

    const result = await new MarketplaceInstaller().install(plugin, ['claude'], nativeConfig);

    expect(result.agents.claude?.status).toBe('full');
    expect(mockNativeInstall).toHaveBeenCalledWith(nativeConfig, 'claude');
  });

  it('does direct MCP install alongside native for local-script MCP servers (claude only, not codex)', async () => {
    const { NativeInstaller } = await import('../../src/services/marketplace/NativeInstaller.js');
    const { McpTranslator } = await import('../../src/services/marketplace/McpTranslator.js');
    const mockNativeInstall = vi.fn().mockReturnValue('/path/to/native');
    const mockMcpInstall = vi.fn().mockReturnValue('/path/to/mcp');
    (NativeInstaller as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      supportsNative: vi.fn((agent: string, format?: string) => {
        if (agent === 'claude') return !format || format === 'claude-marketplace';
        if (agent === 'codex') return !format || format === 'codex-plugin';
        return false;
      }),
      install: mockNativeInstall,
      uninstall: vi.fn(),
      getNativeCopyOperations: vi.fn(() => []),
      getNativeConfigurationPaths: vi.fn(() => []),
    }));
    (McpTranslator as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      installForAgent: mockMcpInstall,
      uninstallForAgent: vi.fn(),
    }));

    const installer = new MarketplaceInstaller();
    const plugin: DetectedPlugin = {
      id: 'test-plugin',
      name: 'Test Plugin',
      skills: [],
      agents: [],
      hooks: [],
      mcpServers: [{ name: 'my-mcp', command: 'node', args: ['/abs/path/server.js'] }],
      jsPlugins: [],
    };

    const nativeConfig = { marketplaceUrl: 'https://example.com/repo.git', marketplaceName: 'test-mp', pluginId: 'test-plugin' };
    const result = await installer.install(plugin, ['claude', 'codex'], nativeConfig);

    expect(result.agents.claude?.status).toBe('full');
    expect(mockNativeInstall).toHaveBeenCalledWith(nativeConfig, 'claude');
    // Local-script MCPs go to claude
    expect(mockMcpInstall).toHaveBeenCalledWith(plugin.mcpServers[0], 'claude');
    // Codex MCPs are skipped (disabled until auth/timeout issues resolved)
    expect(mockMcpInstall).not.toHaveBeenCalledWith(plugin.mcpServers[0], 'codex');
  });

  it('skips direct MCP install for npx-based servers (handled by native marketplace)', async () => {
    const { NativeInstaller } = await import('../../src/services/marketplace/NativeInstaller.js');
    const { McpTranslator } = await import('../../src/services/marketplace/McpTranslator.js');
    const mockNativeInstall = vi.fn().mockReturnValue('/path/to/native');
    const mockMcpInstall = vi.fn().mockReturnValue('/path/to/mcp');
    (NativeInstaller as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      supportsNative: vi.fn((agent: string, format?: string) => {
        if (agent === 'claude') return !format || format === 'claude-marketplace';
        if (agent === 'codex') return !format || format === 'codex-plugin';
        return false;
      }),
      install: mockNativeInstall,
      uninstall: vi.fn(),
      getNativeCopyOperations: vi.fn(() => []),
      getNativeConfigurationPaths: vi.fn(() => []),
    }));
    (McpTranslator as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      installForAgent: mockMcpInstall,
      uninstallForAgent: vi.fn(),
    }));

    const installer = new MarketplaceInstaller();
    const plugin: DetectedPlugin = {
      id: 'test-plugin',
      name: 'Test Plugin',
      skills: [],
      agents: [],
      hooks: [],
      mcpServers: [{ name: 'my-mcp', command: 'npx', args: ['-y', '@my/mcp-server'] }],
      jsPlugins: [],
    };

    const nativeConfig = { marketplaceUrl: 'https://example.com/repo.git', marketplaceName: 'test-mp', pluginId: 'test-plugin' };
    await installer.install(plugin, ['claude'], nativeConfig);

    expect(mockNativeInstall).toHaveBeenCalledWith(nativeConfig, 'claude');
    expect(mockMcpInstall).not.toHaveBeenCalled();
  });

  it('installs a fully selected npx-based server directly without native registration', async () => {
    const { NativeInstaller } = await import('../../src/services/marketplace/NativeInstaller.js');
    const { McpTranslator } = await import('../../src/services/marketplace/McpTranslator.js');
    const mockNativeInstall = vi.fn().mockReturnValue('/path/to/native');
    const mockMcpInstall = vi.fn().mockReturnValue('/path/to/mcp');
    (NativeInstaller as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      supportsNative: vi.fn((agent: string, format?: string) => agent === 'claude' && (!format || format === 'claude-marketplace')),
      install: mockNativeInstall,
      uninstall: vi.fn(),
      getNativeCopyOperations: vi.fn(() => []),
      getNativeConfigurationPaths: vi.fn(() => []),
    }));
    (McpTranslator as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      installForAgent: mockMcpInstall,
      uninstallForAgent: vi.fn(),
    }));

    const plugin: DetectedPlugin = {
      id: 'test-plugin',
      name: 'Test Plugin',
      skills: [],
      agents: [],
      hooks: [],
      mcpServers: [{ name: 'my-mcp', command: 'npx', args: ['-y', '@my/mcp-server'] }],
      jsPlugins: [],
    };
    const nativeConfig = {
      marketplaceUrl: 'https://example.com/repo.git',
      marketplaceName: 'test-mp',
      pluginId: 'test-plugin',
      sourceFormat: 'claude-marketplace' as const,
    };

    await new MarketplaceInstaller().install(
      plugin,
      ['claude'],
      nativeConfig,
      { skills: [], mcpServers: ['my-mcp'], agents: [] },
      undefined,
      undefined,
      'selected',
    );

    expect(mockNativeInstall).not.toHaveBeenCalled();
    expect(mockMcpInstall).toHaveBeenCalledWith(plugin.mcpServers[0], 'claude');
  });

  it('keeps hooks and JavaScript plugins in selected previews', () => {
    const jsPluginPath = '/tmp/marketplace-plugin.js';
    writeFileSync(jsPluginPath, 'export default {};\n');
    const plugin: DetectedPlugin = {
      id: 'test-plugin',
      name: 'Test Plugin',
      skills: [{ name: 'my-skill', path: '/tmp/skills/my-skill/SKILL.md' }],
      agents: [],
      hooks: [{ event: 'post_merge', command: 'run-tool' }],
      mcpServers: [],
      jsPlugins: [{ name: 'plugin-script', path: jsPluginPath }],
    };

    const preview = new MarketplaceInstaller().preview(
      plugin,
      ['opencode'],
      undefined,
      { skills: ['my-skill'], mcpServers: [], agents: [] },
      { headSha: 'head-1', sourceUrl: 'https://example.test/repo.git' },
      'selected',
    );

    expect(preview.agents[0]?.artifacts.map((artifact) => artifact.name)).toEqual([
      'skill:my-skill',
      'hooks',
      'plugin:plugin-script',
    ]);
  });

  it('uses direct install for all agents when no nativeConfig', async () => {
    const installer = new MarketplaceInstaller();
    const plugin: DetectedPlugin = {
      id: 'test-plugin',
      name: 'Test Plugin',
      skills: [{ name: 'my-skill', path: '/tmp/skills/my-skill/SKILL.md' }],
      agents: [],
      hooks: [],
      mcpServers: [],
      jsPlugins: [],
    };

    const result = await installer.install(plugin, ['claude', 'codex', 'opencode']);
    expect(result.agents.claude?.status).toBe('full');
    expect(result.agents.codex?.status).toBe('full');
    expect(result.agents.opencode?.status).toBe('full');
  });

  it('reports partial for JS plugins when agent uses direct install without opencode support', async () => {
    const installer = new MarketplaceInstaller();
    const plugin: DetectedPlugin = {
      id: 'test-plugin',
      name: 'Test Plugin',
      skills: [],
      agents: [],
      hooks: [],
      mcpServers: [],
      jsPlugins: [{ name: 'complex-plugin', path: '/tmp/plugins/complex.js' }],
    };

    // Without nativeConfig, all agents use direct install.
    // Claude/codex can't run JS plugins so they report partial.
    const result = await installer.install(plugin, ['claude', 'codex']);
    expect(result.agents.claude?.skipped).toContain('JS runtime plugins cannot be translated');
    expect(result.agents.codex?.skipped).toContain('JS runtime plugins cannot be translated');
  });

  it('reports partial when hooks have no equivalent for opencode', async () => {
    const { HookTranslator } = await import('../../src/services/marketplace/HookTranslator.js');
    (HookTranslator as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      translateAllForAgent: vi.fn().mockReturnValue([{ status: 'partial', path: '', skipped: ['SubagentStart has no equivalent'] }]),
      uninstallForAgent: vi.fn(),
    }));

    const installer = new MarketplaceInstaller();
    const plugin: DetectedPlugin = {
      id: 'test-plugin',
      name: 'Test Plugin',
      skills: [],
      agents: [],
      hooks: [{ event: 'SubagentStart', command: 'echo hi', sourceFormat: 'claude' }],
      mcpServers: [],
      jsPlugins: [],
    };

    const result = await installer.install(plugin, ['opencode']);
    expect(result.agents.opencode?.status).toBe('partial');
    expect(result.agents.opencode?.skipped).toContain('SubagentStart has no equivalent');
  });

  it('uninstall uses native for claude/codex, direct for opencode', async () => {
    const { SkillTranslator } = await import('../../src/services/marketplace/SkillTranslator.js');
    const { McpTranslator } = await import('../../src/services/marketplace/McpTranslator.js');
    const { HookTranslator } = await import('../../src/services/marketplace/HookTranslator.js');
    const { NativeInstaller } = await import('../../src/services/marketplace/NativeInstaller.js');

    const mockSkillUninstall = vi.fn();
    const mockMcpUninstall = vi.fn();
    const mockHookUninstall = vi.fn();
    const mockNativeUninstall = vi.fn();

    (SkillTranslator as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      installForAgent: vi.fn().mockReturnValue('/path'),
      uninstallForAgent: mockSkillUninstall,
    }));
    (McpTranslator as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      installForAgent: vi.fn().mockReturnValue('/path'),
      uninstallForAgent: mockMcpUninstall,
    }));
    (HookTranslator as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      translateForAgent: vi.fn().mockReturnValue({ status: 'full', path: '/path', skipped: [] }),
      uninstallForAgent: mockHookUninstall,
    }));
    (NativeInstaller as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      supportsNative: vi.fn((agent: string, format?: string) => {
        if (agent === 'claude') return !format || format === 'claude-marketplace';
        if (agent === 'codex') return !format || format === 'codex-plugin';
        return false;
      }),
      install: vi.fn().mockReturnValue('/path/to/native'),
      uninstall: mockNativeUninstall,
      getNativeCopyOperations: vi.fn(() => []),
      getNativeConfigurationPaths: vi.fn(() => []),
    }));

    const installer = new MarketplaceInstaller();
    const plugin: DetectedPlugin = {
      id: 'test-plugin',
      name: 'Test Plugin',
      skills: [{ name: 'my-skill', path: '/tmp/skills/my-skill/SKILL.md' }],
      agents: [],
      hooks: [{ event: 'PostToolUse', command: 'echo hi', sourceFormat: 'claude' }],
      mcpServers: [{ name: 'my-mcp', command: 'node', args: ['server.js'] }],
      jsPlugins: [],
    };

    const nativeConfig = { marketplaceUrl: 'https://example.com/repo.git', marketplaceName: 'test-mp', pluginId: 'test-plugin' };
    await installer.uninstall(plugin, ['claude', 'codex', 'opencode'], nativeConfig);

    // Claude and Codex use native uninstall
    expect(mockNativeUninstall).toHaveBeenCalledWith(nativeConfig, 'claude');
    expect(mockNativeUninstall).toHaveBeenCalledWith(nativeConfig, 'codex');

    // Opencode uses direct uninstall
    expect(mockSkillUninstall).toHaveBeenCalledWith('my-skill', 'opencode');
    expect(mockMcpUninstall).toHaveBeenCalledWith('my-mcp', 'opencode');
    expect(mockHookUninstall).toHaveBeenCalledWith('test-plugin', 'opencode');
  });

  it('partial selection bypasses native registration and uses direct install instead', async () => {
    // Arrange: re-mock all dependencies since clearAllMocks() ran in beforeEach
    const { NativeInstaller } = await import('../../src/services/marketplace/NativeInstaller.js');
    const { HookTranslator } = await import('../../src/services/marketplace/HookTranslator.js');
    const { AgentTranslator } = await import('../../src/services/marketplace/AgentTranslator.js');
    const mockNativeInstall = vi.fn().mockReturnValue('/path/to/native');
    (NativeInstaller as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      supportsNative: vi.fn((agent: string, format?: string) =>
        agent === 'claude' && (!format || format === 'claude-marketplace'),
      ),
      install: mockNativeInstall,
      uninstall: vi.fn(),
      getNativeCopyOperations: vi.fn(() => []),
      getNativeConfigurationPaths: vi.fn(() => []),
    }));
    (HookTranslator as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      translateAllForAgent: vi.fn().mockReturnValue([]),
      uninstallForAgent: vi.fn(),
    }));
    (AgentTranslator as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      installForAgent: vi.fn().mockReturnValue(''),
      uninstallForAgent: vi.fn(),
    }));

    const installer = new MarketplaceInstaller();
    const plugin: DetectedPlugin = {
      id: 'test-plugin',
      name: 'Test Plugin',
      skills: [{ name: 'skill-a', path: '/tmp/skills/skill-a/SKILL.md' }, { name: 'skill-b', path: '/tmp/skills/skill-b/SKILL.md' }],
      agents: [],
      hooks: [],
      mcpServers: [],
      jsPlugins: [],
    };

    const nativeConfig = { marketplaceUrl: 'https://example.com/repo.git', marketplaceName: 'test-mp', pluginId: 'test-plugin' };

    // Act: install with a partial selection (only skill-a)
    const result = await installer.install(plugin, ['claude'], nativeConfig, { skills: ['skill-a'] });

    // Assert: native install must NOT have been called — partial selection bypasses native registration
    expect(mockNativeInstall).not.toHaveBeenCalled();
    // Direct install should have run (result exists for claude)
    expect(result.agents.claude).toBeDefined();
  });

  it('uninstall without nativeConfig (partial install) does not call nativeInstaller.uninstall', async () => {
    const { NativeInstaller } = await import('../../src/services/marketplace/NativeInstaller.js');
    const { SkillTranslator } = await import('../../src/services/marketplace/SkillTranslator.js');
    const { HookTranslator } = await import('../../src/services/marketplace/HookTranslator.js');
    const { AgentTranslator } = await import('../../src/services/marketplace/AgentTranslator.js');
    const mockNativeUninstall = vi.fn();
    const mockSkillUninstall = vi.fn();
    (NativeInstaller as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      supportsNative: vi.fn(() => true),
      install: vi.fn(),
      uninstall: mockNativeUninstall,
      getNativeCopyOperations: vi.fn(() => []),
      getNativeConfigurationPaths: vi.fn(() => []),
    }));
    (SkillTranslator as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      installForAgent: vi.fn(),
      uninstallForAgent: mockSkillUninstall,
    }));
    (HookTranslator as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      translateAllForAgent: vi.fn().mockReturnValue([]),
      uninstallForAgent: vi.fn(),
    }));
    (AgentTranslator as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      installForAgent: vi.fn(),
      uninstallForAgent: vi.fn(),
    }));

    const installer = new MarketplaceInstaller();
    const plugin: DetectedPlugin = {
      id: 'test-plugin',
      name: 'Test Plugin',
      skills: [{ name: 'my-skill', path: '/tmp/skills/my-skill/SKILL.md' }],
      agents: [],
      hooks: [],
      mcpServers: [],
      jsPlugins: [],
    };

    // Act: uninstall with no nativeConfig (as happens when usedNativeRegistration=false)
    await installer.uninstall(plugin, ['claude'], undefined);

    // Assert: native uninstall must NOT be called — direct cleanup only
    expect(mockNativeUninstall).not.toHaveBeenCalled();
    // Skill was cleaned up via direct path
    expect(mockSkillUninstall).toHaveBeenCalledWith('my-skill', 'claude');
  });

  it('rejects a symlinked selected artifact before installation', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'muxbase-marketplace-'));
    const outside = path.join(root, 'outside-skill');
    const linked = path.join(root, 'linked-skill');
    mkdirSync(outside);
    writeFileSync(path.join(outside, 'SKILL.md'), '# outside\n');
    symlinkSync(outside, linked, 'dir');

    const installer = new MarketplaceInstaller();
    const plugin: DetectedPlugin = {
      id: 'symlink-plugin',
      name: 'Symlink Plugin',
      skills: [{ name: 'linked', path: path.join(linked, 'SKILL.md') }],
      agents: [],
      hooks: [],
      mcpServers: [],
      jsPlugins: [],
    };

    expect(() => installer.preview(plugin, ['claude'], undefined, undefined, {
      sourceUrl: 'https://example.com/source.git',
      headSha: 'head-1',
    })).toThrow('symlinks are not allowed');
  });

  it('rejects installation when selected artifact content changes after preview', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'muxbase-marketplace-'));
    const skillDir = path.join(root, 'skill');
    const skillPath = path.join(skillDir, 'SKILL.md');
    mkdirSync(skillDir);
    writeFileSync(skillPath, '# first\n');
    const plugin: DetectedPlugin = {
      id: 'digest-plugin',
      name: 'Digest Plugin',
      skills: [{ name: 'digest', path: skillPath }],
      agents: [],
      hooks: [],
      mcpServers: [],
      jsPlugins: [],
    };
    const installer = new MarketplaceInstaller();
    const source = { sourceUrl: 'https://example.com/source.git', headSha: 'head-1' };

    const first = installer.preview(plugin, ['claude'], undefined, undefined, source);
    writeFileSync(skillPath, '# second\n');
    const second = installer.preview(plugin, ['claude'], undefined, undefined, source);

    expect(second.digest).not.toBe(first.digest);
    await expect(installer.install(plugin, ['claude'], undefined, undefined, first.digest, source))
      .rejects.toThrow('source changed');
  });

  it('binds local MCP script content into preview consent', async () => {
    const clonePath = mkdtempSync(path.join(tmpdir(), 'muxbase-marketplace-'));
    const scriptPath = path.join(clonePath, 'server.js');
    writeFileSync(scriptPath, 'console.log("first");\n');
    const plugin: DetectedPlugin = {
      id: 'local-mcp-plugin',
      name: 'Local MCP Plugin',
      skills: [],
      agents: [],
      hooks: [],
      mcpServers: [{ name: 'local-server', command: 'node', args: [scriptPath] }],
      jsPlugins: [],
    };
    const installer = new MarketplaceInstaller();
    const nativeConfig = {
      clonePath,
      marketplaceName: 'local-marketplace',
      marketplaceUrl: 'https://example.com/source.git',
      pluginId: plugin.id,
    };
    const source = { sourceUrl: nativeConfig.marketplaceUrl, headSha: 'head-1' };

    const first = installer.preview(plugin, ['claude'], nativeConfig, undefined, source);
    writeFileSync(scriptPath, 'console.log("changed");\n');
    const second = installer.preview(plugin, ['claude'], nativeConfig, undefined, source);

    expect(second.digest).not.toBe(first.digest);
    await expect(installer.install(
      plugin,
      ['claude'],
      nativeConfig,
      undefined,
      first.digest,
      source,
    )).rejects.toThrow('source changed');
  });

  it('shows escaped literal environment values in MCP consent, not just names', () => {
    const plugin: DetectedPlugin = {
      id: 'env-mcp-plugin',
      name: 'Env MCP Plugin',
      skills: [],
      agents: [],
      hooks: [],
      mcpServers: [{
        name: 'remote-server',
        type: 'http',
        url: 'https://example.com/mcp',
        args: [],
        env: { NODE_OPTIONS: '--require ./bootstrap.js', API_KEY: 'abc"def' },
      }],
      jsPlugins: [],
    };
    const installer = new MarketplaceInstaller();

    const preview = installer.preview(plugin, ['claude']);
    const artifact = preview.agents[0].artifacts.find((a) => a.name === 'mcp:remote-server');

    expect(artifact?.detail).toContain('NODE_OPTIONS="--require ./bootstrap.js"');
    expect(artifact?.detail).toContain('API_KEY="abc\\"def"');
  });

  it('changes the preview digest when only an MCP environment value changes', () => {
    const buildPlugin = (value: string): DetectedPlugin => ({
      id: 'env-digest-plugin',
      name: 'Env Digest Plugin',
      skills: [],
      agents: [],
      hooks: [],
      mcpServers: [{
        name: 'remote-server',
        type: 'http',
        url: 'https://example.com/mcp',
        args: [],
        env: { NODE_OPTIONS: value },
      }],
      jsPlugins: [],
    });
    const installer = new MarketplaceInstaller();
    const source = { sourceUrl: 'https://example.com/source.git', headSha: 'head-1' };

    const first = installer.preview(buildPlugin('--one'), ['claude'], undefined, undefined, source);
    const second = installer.preview(buildPlugin('--two'), ['claude'], undefined, undefined, source);

    expect(second.digest).not.toBe(first.digest);
  });

  it('does not crash preview on an option-like MCP arg that ends in a script extension', () => {
    const clonePath = mkdtempSync(path.join(tmpdir(), 'muxbase-marketplace-'));
    const scriptPath = path.join(clonePath, 'server.js');
    writeFileSync(scriptPath, 'console.log("ok");\n');
    const plugin: DetectedPlugin = {
      id: 'option-arg-plugin',
      name: 'Option Arg Plugin',
      skills: [],
      agents: [],
      hooks: [],
      mcpServers: [{ name: 'local-server', command: 'node', args: [scriptPath, '--output=result.js'] }],
      jsPlugins: [],
    };
    const installer = new MarketplaceInstaller();
    const nativeConfig = {
      clonePath,
      marketplaceName: 'local-marketplace',
      marketplaceUrl: 'https://example.com/source.git',
      pluginId: plugin.id,
    };

    const preview = installer.preview(plugin, ['claude'], nativeConfig);
    const artifact = preview.agents[0].artifacts.find((a) => a.name === 'mcp:local-server');

    // Only the real script is bound into the digest; the option-like value is ignored, not crashed on.
    expect(artifact?.sourcePaths).toEqual([scriptPath]);
  });

  it('does not throw and does not hash a nonexistent positional script argument', () => {
    const clonePath = mkdtempSync(path.join(tmpdir(), 'muxbase-marketplace-'));
    const plugin: DetectedPlugin = {
      id: 'missing-script-plugin',
      name: 'Missing Script Plugin',
      skills: [],
      agents: [],
      hooks: [],
      mcpServers: [{ name: 'local-server', command: 'node', args: ['future.js'] }],
      jsPlugins: [],
    };
    const installer = new MarketplaceInstaller();
    const nativeConfig = {
      clonePath,
      marketplaceName: 'local-marketplace',
      marketplaceUrl: 'https://example.com/source.git',
      pluginId: plugin.id,
    };

    expect(() => installer.preview(plugin, ['claude'], nativeConfig)).not.toThrow();
    const artifact = installer.preview(plugin, ['claude'], nativeConfig)
      .agents[0].artifacts.find((a) => a.name === 'mcp:local-server');
    expect(artifact?.sourcePaths).toEqual([]);
  });

  it('still rejects a traversal MCP script argument that does not exist on disk', () => {
    const clonePath = mkdtempSync(path.join(tmpdir(), 'muxbase-marketplace-'));
    const plugin: DetectedPlugin = {
      id: 'traversal-plugin',
      name: 'Traversal Plugin',
      skills: [],
      agents: [],
      hooks: [],
      mcpServers: [{ name: 'local-server', command: 'node', args: ['../../../evil.js'] }],
      jsPlugins: [],
    };
    const installer = new MarketplaceInstaller();

    expect(() => installer.preview(plugin, ['claude'], {
      clonePath,
      marketplaceName: 'local-marketplace',
      marketplaceUrl: 'https://example.com/source.git',
      pluginId: plugin.id,
    })).toThrow('outside the source clone');
  });

  it('rejects a local MCP symlink that escapes the marketplace source', () => {
    const clonePath = mkdtempSync(path.join(tmpdir(), 'muxbase-marketplace-'));
    const outsidePath = path.join(tmpdir(), `muxbase-outside-mcp-${Date.now()}.js`);
    const scriptPath = path.join(clonePath, 'server.js');
    writeFileSync(outsidePath, 'console.log("outside");\n');
    symlinkSync(outsidePath, scriptPath);
    const plugin: DetectedPlugin = {
      id: 'symlinked-mcp-plugin',
      name: 'Symlinked MCP Plugin',
      skills: [],
      agents: [],
      hooks: [],
      mcpServers: [{ name: 'local-server', command: 'node', args: [scriptPath] }],
      jsPlugins: [],
    };
    const installer = new MarketplaceInstaller();

    expect(() => installer.preview(plugin, ['claude'], {
      clonePath,
      marketplaceName: 'local-marketplace',
      marketplaceUrl: 'https://example.com/source.git',
      pluginId: plugin.id,
    })).toThrow('outside the marketplace source');
  });

  it('accepts a relative local MCP symlink contained by the marketplace source', () => {
    const clonePath = mkdtempSync(path.join(tmpdir(), 'muxbase-marketplace-'));
    const targetPath = path.join(clonePath, 'server-target.js');
    const scriptPath = path.join(clonePath, 'server.js');
    writeFileSync(targetPath, 'console.log("contained");\n');
    symlinkSync('server-target.js', scriptPath);
    const plugin: DetectedPlugin = {
      id: 'symlinked-mcp-plugin',
      name: 'Symlinked MCP Plugin',
      skills: [],
      agents: [],
      hooks: [],
      mcpServers: [{ name: 'local-server', command: 'node', args: [scriptPath] }],
      jsPlugins: [],
    };
    const installer = new MarketplaceInstaller();

    const preview = installer.preview(plugin, ['claude'], {
      clonePath,
      marketplaceName: 'local-marketplace',
      marketplaceUrl: 'https://example.com/source.git',
      pluginId: plugin.id,
    });

    expect(preview.agents[0].artifacts.find((artifact) => artifact.name === 'mcp:local-server'))
      .toMatchObject({ sourcePaths: [scriptPath] });
  });

  it('rejects a broken local MCP symlink', () => {
    const clonePath = mkdtempSync(path.join(tmpdir(), 'muxbase-marketplace-'));
    const scriptPath = path.join(clonePath, 'server.js');
    symlinkSync('missing.js', scriptPath);
    const plugin: DetectedPlugin = {
      id: 'broken-mcp-plugin',
      name: 'Broken MCP Plugin',
      skills: [],
      agents: [],
      hooks: [],
      mcpServers: [{ name: 'local-server', command: 'node', args: [scriptPath] }],
      jsPlugins: [],
    };

    expect(() => new MarketplaceInstaller().preview(plugin, ['claude'], {
      clonePath,
      marketplaceName: 'local-marketplace',
      marketplaceUrl: 'https://example.com/source.git',
      pluginId: plugin.id,
    })).toThrow('broken or cyclic symlink');
  });
});
