import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    existsSync: vi.fn(),
    readdirSync: vi.fn(),
    readFileSync: vi.fn(),
    statSync: vi.fn(),
  };
});

import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { FormatDetector } from '../../src/services/marketplace/FormatDetector.js';

describe('FormatDetector', () => {
  const detector = new FormatDetector();

  beforeEach(() => {
    vi.clearAllMocks();
    (statSync as ReturnType<typeof vi.fn>).mockReturnValue({ isDirectory: () => true });
  });

  it('detects claude-marketplace format', () => {
    (existsSync as ReturnType<typeof vi.fn>).mockImplementation((p: string) => {
      return p.endsWith('.claude-plugin/marketplace.json');
    });

    const result = detector.detectFormat('/tmp/repo');
    expect(result).toBe('claude-marketplace');
  });

  it('detects codex-plugin format', () => {
    (existsSync as ReturnType<typeof vi.fn>).mockImplementation((p: string) => {
      if (p.endsWith('.claude-plugin/marketplace.json')) return false;
      if (p.includes('.codex') && (p.endsWith('config.toml') || p.endsWith('.codex'))) return true;
      return false;
    });

    const result = detector.detectFormat('/tmp/repo');
    expect(result).toBe('codex-plugin');
  });

  it('detects raw-skills format', () => {
    (existsSync as ReturnType<typeof vi.fn>).mockImplementation((p: string) => {
      if (p.endsWith('.claude-plugin/marketplace.json')) return false;
      if (p.includes('.codex')) return false;
      if (p.includes('.opencode')) return false;
      if (p.endsWith('mcp-servers')) return false;
      if (p.endsWith('/skills')) return true;
      if (p.endsWith('/SKILL.md')) return true;
      return false;
    });
    (readdirSync as ReturnType<typeof vi.fn>).mockReturnValue(['my-skill']);

    const result = detector.detectFormat('/tmp/repo');
    expect(result).toBe('raw-skills');
  });

  it('returns null for unrecognized format', () => {
    (existsSync as ReturnType<typeof vi.fn>).mockReturnValue(false);
    const result = detector.detectFormat('/tmp/repo');
    expect(result).toBeNull();
  });

  describe('codex-plugin MCP from .mcp.json', () => {
    it('detects MCP servers from .mcp.json in repo root', () => {
      (existsSync as ReturnType<typeof vi.fn>).mockImplementation((p: string) => {
        if (p.endsWith('.codex')) return true;
        if (p.endsWith('.codex/hooks.json')) return true;
        if (p.endsWith('.mcp.json')) return true;
        if (p.endsWith('/skills')) return true;
        if (p.endsWith('/SKILL.md')) return true;
        if (p.endsWith('/plugins')) return false;
        if (p.endsWith('server.js')) return true;
        return false;
      });
      (readdirSync as ReturnType<typeof vi.fn>).mockImplementation((p: string) => {
        if (typeof p === 'string' && p.endsWith('/skills')) return ['my-skill'];
        return [];
      });
      (readFileSync as ReturnType<typeof vi.fn>).mockImplementation((p: string) => {
        if (typeof p === 'string' && p.endsWith('.codex/hooks.json')) {
          return JSON.stringify({ UserPromptSubmit: [{ command: 'echo hi' }] });
        }
        if (typeof p === 'string' && p.endsWith('.mcp.json')) {
          return JSON.stringify({
            mcpServers: {
              'my-mcp': { command: 'node', args: ['server.js'], env: { KEY: 'val' } },
            },
          });
        }
        return '';
      });

      const plugins = detector.detectPlugins('/tmp/repo', 'codex-plugin');
      expect(plugins).toHaveLength(1);
      expect(plugins[0].skills).toHaveLength(1);
      expect(plugins[0].hooks).toHaveLength(1);
      expect(plugins[0].mcpServers).toHaveLength(1);
      expect(plugins[0].mcpServers[0].name).toBe('my-mcp');
      expect(plugins[0].mcpServers[0].command).toBe('node');
      expect(plugins[0].mcpServers[0].args).toEqual(['/tmp/repo/server.js']);
      expect(plugins[0].mcpServers[0].env).toEqual({ KEY: 'val' });
    });

    it('returns empty mcpServers when .mcp.json is missing', () => {
      (existsSync as ReturnType<typeof vi.fn>).mockImplementation((p: string) => {
        if (p.endsWith('.codex')) return true;
        if (p.endsWith('.codex/hooks.json')) return true;
        if (p.endsWith('/plugins')) return false;
        return false;
      });
      (readdirSync as ReturnType<typeof vi.fn>).mockReturnValue([]);
      (readFileSync as ReturnType<typeof vi.fn>).mockImplementation((p: string) => {
        if (typeof p === 'string' && p.endsWith('.codex/hooks.json')) {
          return JSON.stringify({ UserPromptSubmit: [{ command: 'echo hi' }] });
        }
        return '';
      });

      const plugins = detector.detectPlugins('/tmp/repo', 'codex-plugin');
      expect(plugins).toHaveLength(1);
      expect(plugins[0].mcpServers).toHaveLength(0);
    });

    it('rejects MCP server entries with path-traversal or absolute script args', () => {
      (existsSync as ReturnType<typeof vi.fn>).mockImplementation((p: string) => {
        if (p.endsWith('.codex')) return true;
        if (p.endsWith('.mcp.json')) return true;
        return false;
      });
      (readdirSync as ReturnType<typeof vi.fn>).mockReturnValue([]);
      (readFileSync as ReturnType<typeof vi.fn>).mockImplementation((p: string) => {
        if (typeof p === 'string' && p.endsWith('.mcp.json')) {
          return JSON.stringify({
            mcpServers: {
              'safe-server': { command: 'node', args: ['server.js'] },
              'traversal-server': { command: 'node', args: ['../../../evil.js'] },
              'absolute-server': { command: 'node', args: ['/tmp/evil.js'] },
            },
          });
        }
        return '';
      });

      const plugins = detector.detectPlugins('/tmp/repo', 'codex-plugin');
      expect(plugins).toHaveLength(1);
      // Only the safe server should be included; traversal and absolute-path servers must be rejected
      expect(plugins[0].mcpServers).toHaveLength(1);
      expect(plugins[0].mcpServers[0].name).toBe('safe-server');
      expect(plugins[0].mcpServers.map((s) => s.name)).not.toContain('traversal-server');
      expect(plugins[0].mcpServers.map((s) => s.name)).not.toContain('absolute-server');
    });

    it('preserves an option-like argument that merely ends in a script extension', () => {
      (existsSync as ReturnType<typeof vi.fn>).mockImplementation((p: string) => {
        if (p.endsWith('.codex')) return true;
        if (p.endsWith('.mcp.json')) return true;
        // Note: no path ends with '--output=result.js', so it never "exists" on disk.
        return false;
      });
      (readdirSync as ReturnType<typeof vi.fn>).mockReturnValue([]);
      (readFileSync as ReturnType<typeof vi.fn>).mockImplementation((p: string) => {
        if (typeof p === 'string' && p.endsWith('.mcp.json')) {
          return JSON.stringify({
            mcpServers: {
              'safe-server': { command: 'node', args: ['--output=result.js'] },
            },
          });
        }
        return '';
      });

      const plugins = detector.detectPlugins('/tmp/repo', 'codex-plugin');

      expect(plugins[0].mcpServers).toHaveLength(1);
      expect(plugins[0].mcpServers[0].args).toEqual(['--output=result.js']);
    });
  });

  describe('opencode-plugins format with skills', () => {
    it('detects skills alongside JS plugins', () => {
      (existsSync as ReturnType<typeof vi.fn>).mockImplementation((p: string) => {
        if (p.endsWith('.opencode/plugins')) return true;
        if (p.endsWith('.opencode/skills')) return true;
        if (p.endsWith('/SKILL.md')) return true;
        return false;
      });
      (readdirSync as ReturnType<typeof vi.fn>).mockImplementation((p: string) => {
        if (typeof p === 'string' && p.endsWith('.opencode/plugins')) return ['my-plugin.js'];
        if (typeof p === 'string' && p.endsWith('.opencode/skills')) return ['my-skill'];
        return [];
      });

      const plugins = detector.detectPlugins('/tmp/repo', 'opencode-plugins');
      expect(plugins).toHaveLength(1);
      expect(plugins[0].jsPlugins).toHaveLength(1);
      expect(plugins[0].jsPlugins[0].name).toBe('my-plugin');
      expect(plugins[0].skills).toHaveLength(1);
      expect(plugins[0].skills[0].name).toBe('my-skill');
      expect(plugins[0].mcpServers).toHaveLength(0);
    });

    it('returns empty skills when .opencode/skills dir is missing', () => {
      (existsSync as ReturnType<typeof vi.fn>).mockImplementation((p: string) => {
        if (p.endsWith('.opencode/plugins')) return true;
        return false;
      });
      (readdirSync as ReturnType<typeof vi.fn>).mockImplementation((p: string) => {
        if (typeof p === 'string' && p.endsWith('.opencode/plugins')) return ['my-plugin.js'];
        return [];
      });

      const plugins = detector.detectPlugins('/tmp/repo', 'opencode-plugins');
      expect(plugins).toHaveLength(1);
      expect(plugins[0].jsPlugins).toHaveLength(1);
      expect(plugins[0].skills).toHaveLength(0);
    });
  });
});
