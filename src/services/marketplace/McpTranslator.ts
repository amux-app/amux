import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import type { AgentName } from '../../utils/agentLaunch.js';
import type { McpServerEntry } from './types.js';
import { loadJson } from './utils.js';

// Slow npm-based servers (internal git installs) often take >30s on first run.
const SLOW_NPM_TIMEOUT_SEC = 120;
const SLOW_NPM_ARG_PATTERNS = ['git+https://', 'git+http://'];

export class McpTranslator {
  constructor(private readonly homeDir = os.homedir()) {}

  // Single source of truth for per-agent MCP config paths, shared with InstalledScanner.
  // Callers that inject a home directory (e.g. tests) pass it through; the scanner uses
  // the real home by default.
  static configPath(agent: AgentName, homeDir: string = os.homedir()): string {
    switch (agent) {
      case 'claude': return path.join(homeDir, '.claude', 'settings.json');
      case 'codex': return path.join(homeDir, '.codex', 'config.toml');
      case 'opencode': return path.join(homeDir, '.config', 'opencode', 'opencode.json');
      case 'pi': throw new Error('Marketplace MCP is not supported for Pi');
    }
  }

  // Enumerate MCP server names configured for an agent on disk.
  static listServerNames(agent: AgentName): string[] {
    const configPath = McpTranslator.configPath(agent);
    if (!existsSync(configPath)) return [];
    if (agent === 'codex') {
      const content = readFileSync(configPath, 'utf-8');
      const names: string[] = [];
      for (const line of content.split('\n')) {
        const m = line.trim().match(/^\[mcp_servers\.([^.\]]+)\]$/);
        if (m) names.push(m[1]);
      }
      return names;
    }
    const config = loadJson(configPath);
    const key = agent === 'opencode' ? 'mcp' : 'mcpServers';
    const map = config[key];
    return map && typeof map === 'object' ? Object.keys(map as Record<string, unknown>) : [];
  }

  private getAgentConfigPath(agent: AgentName): string {
    return McpTranslator.configPath(agent, this.homeDir);
  }

  installForAgent(server: McpServerEntry, agent: AgentName): string {
    const configPath = this.getAgentConfigPath(agent);
    mkdirSync(path.dirname(configPath), { recursive: true });

    switch (agent) {
      case 'claude': this.installForClaude(configPath, server); break;
      case 'codex': this.installForCodex(configPath, server); break;
      case 'opencode': this.installForOpencode(configPath, server); break;
      case 'pi': throw new Error('Marketplace MCP is not supported for Pi');
    }

    return configPath;
  }

  uninstallForAgent(serverName: string, agent: AgentName): void {
    const configPath = this.getAgentConfigPath(agent);
    if (!existsSync(configPath)) return;

    switch (agent) {
      case 'claude': this.removeFromClaudeSettings(configPath, serverName); break;
      case 'codex': this.removeFromCodexConfig(configPath, serverName); break;
      case 'opencode': this.removeFromOpencodeConfig(configPath, serverName); break;
      case 'pi': throw new Error('Marketplace MCP is not supported for Pi');
    }
  }

  private isRemote(server: McpServerEntry): boolean {
    return server.type === 'http' || server.type === 'sse';
  }

  private installForClaude(configPath: string, server: McpServerEntry): void {
    const settings = loadJson(configPath);
    if (!settings.mcpServers) settings.mcpServers = {};

    const entry: Record<string, unknown> = this.isRemote(server)
      ? { type: server.type, url: server.url }
      : {
          command: server.command,
          args: server.args,
          ...(server.env ? { env: server.env } : {}),
        };

    (settings.mcpServers as Record<string, unknown>)[server.name] = entry;
    writeFileSync(configPath, JSON.stringify(settings, null, 2), 'utf-8');
  }

  private installForCodex(configPath: string, server: McpServerEntry): void {
    let content = existsSync(configPath) ? readFileSync(configPath, 'utf-8') : '';
    content = this.removeCodexTomlSection(content, server.name);
    content = content.trimEnd() + '\n\n' + this.buildCodexTomlSection(server) + '\n';
    writeFileSync(configPath, content, 'utf-8');
  }

  private installForOpencode(configPath: string, server: McpServerEntry): void {
    const config = loadJson(configPath);
    if (!config.mcp) config.mcp = {};

    const entry: Record<string, unknown> = this.isRemote(server)
      ? {
          type: server.type === 'sse' ? 'sse' : 'http',
          url: server.url,
          ...(server.env ? { headers: this.envToHeaders(server.env) } : {}),
        }
      : {
          type: 'local',
          command: [server.command, ...(server.args ?? [])],
          ...(server.env ? { environment: server.env } : {}),
        };

    (config.mcp as Record<string, unknown>)[server.name] = entry;
    writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
  }

  private removeFromClaudeSettings(configPath: string, serverName: string): void {
    const settings = loadJson(configPath);
    if (settings.mcpServers) {
      delete (settings.mcpServers as Record<string, unknown>)[serverName];
      writeFileSync(configPath, JSON.stringify(settings, null, 2), 'utf-8');
    }
  }

  private removeFromCodexConfig(configPath: string, serverName: string): void {
    if (!existsSync(configPath)) return;
    let content = readFileSync(configPath, 'utf-8');
    content = this.removeCodexTomlSection(content, serverName);
    writeFileSync(configPath, content, 'utf-8');
  }

  private removeFromOpencodeConfig(configPath: string, serverName: string): void {
    const config = loadJson(configPath);
    if (config.mcp) {
      delete (config.mcp as Record<string, unknown>)[serverName];
      writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
    }
  }

  private buildCodexTomlSection(server: McpServerEntry): string {
    const lines: string[] = [`[mcp_servers.${server.name}]`];

    if (this.isRemote(server)) {
      lines.push(`url = ${JSON.stringify(server.url ?? '')}`);
    } else {
      lines.push(`command = ${JSON.stringify(server.command)}`);
      lines.push(`args = [${(server.args ?? []).map((a) => JSON.stringify(a)).join(', ')}]`);
    }

    const timeoutSec = server.startupTimeoutSec ?? this.inferStartupTimeout(server);
    if (timeoutSec) lines.push(`startup_timeout_sec = ${timeoutSec}`);

    if (!this.isRemote(server) && server.env && Object.keys(server.env).length > 0) {
      lines.push('');
      lines.push(`[mcp_servers.${server.name}.env]`);
      for (const [key, value] of Object.entries(server.env)) {
        lines.push(`${key} = ${JSON.stringify(value)}`);
      }
    }

    return lines.join('\n');
  }

  private inferStartupTimeout(server: McpServerEntry): number | null {
    const isSlowNpm = SLOW_NPM_ARG_PATTERNS.some((p) =>
      server.args?.some((a) => a.includes(p)),
    );
    return isSlowNpm ? SLOW_NPM_TIMEOUT_SEC : null;
  }

  private envToHeaders(env: Record<string, string>): Record<string, string> {
    // OpenCode HTTP/SSE servers pass auth via headers, not env vars.
    // Best-effort: expose env vars as Authorization header if they look like tokens.
    const authKey = Object.keys(env).find((k) =>
      k.toLowerCase().includes('token') || k.toLowerCase().includes('auth'),
    );
    if (!authKey) return {};
    return { Authorization: `Bearer ${env[authKey]}` };
  }

  private removeCodexTomlSection(content: string, serverName: string): string {
    const sectionHeader = `[mcp_servers.${serverName}]`;
    const lines = content.split('\n');
    const result: string[] = [];
    let skipping = false;
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed === sectionHeader) { skipping = true; continue; }
      // Stop skipping when we reach a new top-level section (not a subsection of the removed one)
      if (skipping && trimmed.startsWith('[') && !trimmed.startsWith(`[mcp_servers.${serverName}.`)) {
        skipping = false;
      }
      if (!skipping) result.push(line);
    }
    return result.join('\n').replace(/\n{3,}/g, '\n\n');
  }
}
