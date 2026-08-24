import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
  };
});

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { McpTranslator } from '../../src/services/marketplace/McpTranslator.js';
import type { McpServerEntry } from '../../src/services/marketplace/types.js';

describe('McpTranslator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('claude', () => {
    it('adds MCP server to claude settings.json mcpServers field', () => {
      (existsSync as ReturnType<typeof vi.fn>).mockReturnValue(false);

      const translator = new McpTranslator();
      const server: McpServerEntry = { name: 'my-server', command: 'npx', args: ['-y', 'my-mcp-server'] };

      const result = translator.installForAgent(server, 'claude');
      expect(result).toContain('.claude');
      expect(result).toContain('settings.json');

      const written = (writeFileSync as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
      const parsed = JSON.parse(written);
      expect(parsed.mcpServers['my-server']).toEqual({ command: 'npx', args: ['-y', 'my-mcp-server'] });
    });

    it('merges with existing Claude settings.json preserving all fields', () => {
      (existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true);
      (readFileSync as ReturnType<typeof vi.fn>).mockReturnValue(
        JSON.stringify({ env: { SOME_VAR: "val" }, mcpServers: { existing: { command: 'node', args: [] } } })
      );

      const translator = new McpTranslator();
      const server: McpServerEntry = { name: 'new-server', command: 'npx', args: ['new'] };

      translator.installForAgent(server, 'claude');

      const written = (writeFileSync as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
      const parsed = JSON.parse(written);
      expect(parsed.env.SOME_VAR).toBe('val');
      expect(parsed.mcpServers.existing).toBeDefined();
      expect(parsed.mcpServers['new-server']).toEqual({ command: 'npx', args: ['new'] });
    });
  });

  describe('codex', () => {
    it('writes MCP server as TOML section to config.toml', () => {
      (existsSync as ReturnType<typeof vi.fn>).mockReturnValue(false);

      const translator = new McpTranslator();
      const server: McpServerEntry = { name: 'jira', command: 'npx', args: ['-y', 'jira-mcp'], env: { JIRA_DOMAIN: 'jira.example.com' } };

      const result = translator.installForAgent(server, 'codex');
      expect(result).toContain('.codex');
      expect(result).toContain('config.toml');

      const written = (writeFileSync as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
      expect(written).toContain('[mcp_servers.jira]');
      expect(written).toContain('command = "npx"');
      expect(written).toContain('args = ["-y", "jira-mcp"]');
      expect(written).toContain('[mcp_servers.jira.env]');
      expect(written).toContain('JIRA_DOMAIN = "jira.example.com"');
    });

    it('appends to existing config.toml without clobbering', () => {
      (existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true);
      (readFileSync as ReturnType<typeof vi.fn>).mockReturnValue(
        'model = "gpt-4"\n\n[model_providers.openai]\nbase_url = "http://localhost"\n'
      );

      const translator = new McpTranslator();
      const server: McpServerEntry = { name: 'test', command: 'node', args: ['server.js'] };

      translator.installForAgent(server, 'codex');

      const written = (writeFileSync as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
      expect(written).toContain('model = "gpt-4"');
      expect(written).toContain('[model_providers.openai]');
      expect(written).toContain('[mcp_servers.test]');
    });
  });

  describe('opencode', () => {
    it('writes MCP server to opencode.json mcp field with local type and command array', () => {
      (existsSync as ReturnType<typeof vi.fn>).mockReturnValue(false);

      const translator = new McpTranslator();
      const server: McpServerEntry = { name: 'test', command: 'node', args: ['server.js'], env: { KEY: 'val' } };

      const result = translator.installForAgent(server, 'opencode');
      expect(result).toContain('opencode');
      expect(result).toContain('opencode.json');

      const written = (writeFileSync as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
      const parsed = JSON.parse(written);
      expect(parsed.mcp.test).toEqual({
        type: 'local',
        command: ['node', 'server.js'],
        environment: { KEY: 'val' },
      });
    });

    it('merges with existing opencode.json preserving all fields', () => {
      (existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true);
      (readFileSync as ReturnType<typeof vi.fn>).mockReturnValue(
        JSON.stringify({ model: 'claude-opus-4-6', provider: { anthropic: {} }, mcp: { existing: { type: 'local', command: ['x'] } } })
      );

      const translator = new McpTranslator();
      const server: McpServerEntry = { name: 'new', command: 'npx', args: ['new-mcp'] };

      translator.installForAgent(server, 'opencode');

      const written = (writeFileSync as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
      const parsed = JSON.parse(written);
      expect(parsed.model).toBe('claude-opus-4-6');
      expect(parsed.mcp.existing).toBeDefined();
      expect(parsed.mcp.new).toEqual({ type: 'local', command: ['npx', 'new-mcp'] });
    });
  });

  describe('uninstall', () => {
    it('removes from claude settings.json', () => {
      (existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true);
      (readFileSync as ReturnType<typeof vi.fn>).mockReturnValue(
        JSON.stringify({ mcpServers: { keep: { command: 'x' }, remove: { command: 'y' } } })
      );

      const translator = new McpTranslator();
      translator.uninstallForAgent('remove', 'claude');

      const written = (writeFileSync as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
      const parsed = JSON.parse(written);
      expect(parsed.mcpServers.keep).toBeDefined();
      expect(parsed.mcpServers.remove).toBeUndefined();
    });

    it('removes TOML section from codex config.toml', () => {
      (existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true);
      (readFileSync as ReturnType<typeof vi.fn>).mockReturnValue(
        'model = "gpt-4"\n\n[mcp_servers.jira]\ncommand = "npx"\nargs = ["-y", "jira"]\n\n[mcp_servers.jira.env]\nDOMAIN = "x"\n\n[other]\nval = 1\n'
      );

      const translator = new McpTranslator();
      translator.uninstallForAgent('jira', 'codex');

      const written = (writeFileSync as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
      expect(written).toContain('model = "gpt-4"');
      expect(written).not.toContain('[mcp_servers.jira]');
      expect(written).not.toContain('DOMAIN = "x"');
      expect(written).toContain('[other]');
    });

    it('removes from opencode.json mcp field', () => {
      (existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true);
      (readFileSync as ReturnType<typeof vi.fn>).mockReturnValue(
        JSON.stringify({ model: 'x', mcp: { keep: { type: 'local', command: ['a'] }, remove: { type: 'local', command: ['b'] } } })
      );

      const translator = new McpTranslator();
      translator.uninstallForAgent('remove', 'opencode');

      const written = (writeFileSync as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
      const parsed = JSON.parse(written);
      expect(parsed.mcp.keep).toBeDefined();
      expect(parsed.mcp.remove).toBeUndefined();
    });
  });
});
