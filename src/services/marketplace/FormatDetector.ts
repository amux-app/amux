import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import path from 'path';
import type { AgentEntry, DetectedPlugin, HookEntry, MarketplaceFormat, McpServerEntry, SkillEntry } from './types.js';
import { safeName, safeResolveUnder } from './utils.js';

export class FormatDetector {
  private readonly descriptionCache = new Map<string, string | undefined>();

  clearDescriptionCache(): void {
    this.descriptionCache.clear();
  }

  detectFormat(repoPath: string): MarketplaceFormat | null {
    if (this.isClaudeMarketplace(repoPath)) return 'claude-marketplace';
    if (this.isCodexPlugin(repoPath)) return 'codex-plugin';
    if (this.isOpencodePlugins(repoPath)) return 'opencode-plugins';
    if (this.isOpencodeSkills(repoPath)) return 'opencode-skills';
    if (this.hasMcpServers(repoPath)) return 'mcp-servers';
    if (this.isRawSkills(repoPath)) return 'raw-skills';
    return null;
  }

  detectPlugins(repoPath: string, format: MarketplaceFormat): DetectedPlugin[] {
    switch (format) {
      case 'claude-marketplace': return this.detectClaudePlugins(repoPath);
      case 'codex-plugin': return this.detectCodexPlugins(repoPath);
      case 'opencode-skills': return this.detectOpencodeSkills(repoPath);
      case 'opencode-plugins': return this.detectOpencodeJsPlugins(repoPath);
      case 'mcp-servers': return this.detectMcpServerPlugins(repoPath);
      case 'raw-skills': return this.detectRawSkills(repoPath);
    }
  }

  private isClaudeMarketplace(repoPath: string): boolean {
    return existsSync(path.join(repoPath, '.claude-plugin', 'marketplace.json'));
  }

  private isCodexPlugin(repoPath: string): boolean {
    const codexDir = path.join(repoPath, '.codex');
    return existsSync(codexDir) && (
      existsSync(path.join(codexDir, 'config.toml')) ||
      existsSync(path.join(codexDir, 'hooks.json'))
    );
  }

  private isOpencodeSkills(repoPath: string): boolean {
    return existsSync(path.join(repoPath, '.opencode', 'skills'));
  }

  private isOpencodePlugins(repoPath: string): boolean {
    return existsSync(path.join(repoPath, '.opencode', 'plugins'));
  }

  private hasMcpServers(repoPath: string): boolean {
    // Either a mcp-servers/ directory OR a root-level .mcp.json file
    return existsSync(path.join(repoPath, 'mcp-servers'))
      || existsSync(path.join(repoPath, '.mcp.json'));
  }

  private isRawSkills(repoPath: string): boolean {
    const candidates = [
      path.join(repoPath, '.claude', 'skills'),
      path.join(repoPath, '.agents', 'skills'),
      path.join(repoPath, 'skills'),
    ];
    return candidates.some((p) => existsSync(p) && this.hasSkillMdFiles(p));
  }

  private hasSkillMdFiles(dir: string): boolean {
    try {
      const entries = readdirSync(dir);
      return entries.some((entry) => {
        const entryPath = path.join(dir, entry);
        try {
          return statSync(entryPath).isDirectory() &&
            existsSync(path.join(entryPath, 'SKILL.md'));
        } catch {
          return false;
        }
      });
    } catch {
      return false;
    }
  }

  private detectClaudePlugins(repoPath: string): DetectedPlugin[] {
    const manifestPath = path.join(repoPath, '.claude-plugin', 'marketplace.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    const rawPlugins: Array<string | Record<string, unknown>> = manifest.plugins ?? [];

    const results: DetectedPlugin[] = [];
    for (const entry of rawPlugins) {
      const rawName = typeof entry === 'string' ? entry : entry.name as string;
      const rawSource = typeof entry === 'string' ? undefined : entry.source;
      const description = typeof entry === 'string' ? undefined : entry.description as string | undefined;
      const version = typeof entry === 'string' ? undefined : entry.version as string | undefined;

      // Reject unsafe plugin names (path traversal, absolute paths, shell-unsafe chars)
      const name = safeName(rawName);
      if (!name) continue;

      // Skip entries whose source is an object (e.g. git-subdir format) — not locally cloned
      if (rawSource !== undefined && typeof rawSource !== 'string') continue;

      let pluginDir: string;
      if (typeof rawSource === 'string') {
        // Ensure source path stays inside the clone — reject ../escape attempts
        const resolved = safeResolveUnder(repoPath, rawSource);
        if (!resolved) continue;
        pluginDir = resolved;
      } else {
        pluginDir = path.join(repoPath, 'plugins', name);
      }

      results.push({
        id: name,
        name,
        description,
        version,
        skills: this.scanSkillsDir(path.join(pluginDir, 'skills')),
        agents: this.scanAgentsDir(path.join(pluginDir, 'agents')),
        hooks: this.scanClaudeHooks(path.join(pluginDir, 'hooks')),
        mcpServers: this.scanMcpServersFromPlugin(pluginDir),
        jsPlugins: [],
      });
    }
    return results;
  }

  private detectCodexPlugins(repoPath: string): DetectedPlugin[] {
    const pluginsDir = path.join(repoPath, 'plugins');
    if (!existsSync(pluginsDir)) {
      return [{
        id: path.basename(repoPath),
        name: path.basename(repoPath),
        skills: this.scanSkillsDir(path.join(repoPath, 'skills')),
        hooks: this.scanCodexHooks(repoPath),
        mcpServers: this.scanMcpServersFromPlugin(repoPath),
        agents: [],
      jsPlugins: [],
      }];
    }
    const dirs = readdirSync(pluginsDir).filter((d) => {
      try { return statSync(path.join(pluginsDir, d)).isDirectory(); } catch { return false; }
    });
    return dirs
      .filter((name) => safeName(name) !== null)
      .map((name) => ({
        id: name,
      name,
      skills: this.scanSkillsDir(path.join(pluginsDir, name, 'skills')),
      hooks: this.scanCodexHooks(path.join(pluginsDir, name)),
      mcpServers: this.scanMcpServersFromPlugin(path.join(pluginsDir, name)),
      agents: [],
      jsPlugins: [],
    }));
  }

  private detectOpencodeSkills(repoPath: string): DetectedPlugin[] {
    const skillsDir = path.join(repoPath, '.opencode', 'skills');
    return [{
      id: path.basename(repoPath),
      name: path.basename(repoPath),
      skills: this.scanSkillsDir(skillsDir),
      hooks: [],
      mcpServers: [],
      agents: [],
      jsPlugins: [],
    }];
  }

  private detectOpencodeJsPlugins(repoPath: string): DetectedPlugin[] {
    const pluginsDir = path.join(repoPath, '.opencode', 'plugins');
    if (!existsSync(pluginsDir)) return [];
    const files = readdirSync(pluginsDir).filter((f) => f.endsWith('.js') || f.endsWith('.ts'));
    return [{
      id: path.basename(repoPath),
      name: path.basename(repoPath),
      skills: this.scanSkillsDir(path.join(repoPath, '.opencode', 'skills')),
      agents: [],
      hooks: [],
      mcpServers: [],
      jsPlugins: files.map((f) => ({ name: f.replace(/\.(js|ts)$/, ''), path: path.join(pluginsDir, f) })),
    }];
  }

  private detectMcpServerPlugins(repoPath: string): DetectedPlugin[] {
    const serversDir = path.join(repoPath, 'mcp-servers');

    const mcpServers = existsSync(serversDir)
      ? readdirSync(serversDir)
          .filter((d) => { try { return statSync(path.join(serversDir, d)).isDirectory(); } catch { return false; } })
          .flatMap((d) => this.scanMcpServersDir(path.join(serversDir, d)))
      : this.scanMcpServersFromPlugin(repoPath); // root-level .mcp.json

    if (mcpServers.length === 0) return [];
    return [{
      id: path.basename(repoPath),
      name: path.basename(repoPath),
      skills: [],
      hooks: [],
      mcpServers,
      agents: [],
      jsPlugins: [],
    }];
  }

  private detectRawSkills(repoPath: string): DetectedPlugin[] {
    const candidates = [
      path.join(repoPath, '.claude', 'skills'),
      path.join(repoPath, '.agents', 'skills'),
      path.join(repoPath, 'skills'),
    ];
    const skillsDir = candidates.find((p) => existsSync(p));
    if (!skillsDir) return [];
    return [{
      id: path.basename(repoPath),
      name: path.basename(repoPath),
      skills: this.scanSkillsDir(skillsDir),
      hooks: [],
      mcpServers: [],
      agents: [],
      jsPlugins: [],
    }];
  }

  private scanAgentsDir(dir: string): AgentEntry[] {
    if (!existsSync(dir)) return [];
    try {
      return readdirSync(dir)
        .filter((f) => {
          if (!f.endsWith('.md')) return false;
          // Skip documentation files that are not agent definitions
          const lower = f.toLowerCase();
          if (lower === 'readme.md' || lower === 'license.md' || lower === 'changelog.md' || lower === 'contributing.md') return false;
          // Agent files must have valid frontmatter (contain ---)
          try {
            const content = readFileSync(path.join(dir, f), 'utf-8');
            return content.startsWith('---');
          } catch { return false; }
        })
        .map((f) => {
          const agentPath = path.join(dir, f);
          return { name: f.replace(/\.md$/, ''), path: agentPath, description: this.parseSkillDescription(agentPath) };
        });
    } catch { return []; }
  }

  private scanSkillsDir(dir: string): SkillEntry[] {
    if (!existsSync(dir)) return [];
    try {
      return readdirSync(dir)
        .filter((entry) => {
          const entryPath = path.join(dir, entry);
          try {
            return statSync(entryPath).isDirectory() &&
              existsSync(path.join(entryPath, 'SKILL.md'));
          } catch { return false; }
        })
        .map((entry) => {
          const skillPath = path.join(dir, entry, 'SKILL.md');
          return { name: entry, path: skillPath, description: this.parseSkillDescription(skillPath) };
        });
    } catch { return []; }
  }

  private inferMcpDescription(_name: string, args: string[], url?: string): string | undefined {
    if (url) return `HTTP/SSE endpoint: ${url}`;
    const pkg = args.find((a) => !a.startsWith('-'));
    if (!pkg) return undefined;
    const pkgName = pkg.replace(/^git\+https?:\/\/[^/]+\//, '').replace(/\.git$/, '');
    return pkgName !== pkg ? pkgName : undefined;
  }

  private parseSkillDescription(skillPath: string): string | undefined {
    if (this.descriptionCache.has(skillPath)) return this.descriptionCache.get(skillPath);
    let description: string | undefined;
    try {
      const content = readFileSync(skillPath, 'utf-8');
      const match = content.match(/^---[\s\S]*?^description:\s*(.+?)$/m);
      description = match?.[1]?.trim();
    } catch { /* description unavailable */ }
    this.descriptionCache.set(skillPath, description);
    return description;
  }

  private scanClaudeHooks(dir: string): HookEntry[] {
    if (!existsSync(dir)) return [];
    try {
      const hooksFile = path.join(dir, 'hooks.json');
      if (!existsSync(hooksFile)) return [];
      const data = JSON.parse(readFileSync(hooksFile, 'utf-8'));
      // Support both bare { EventName: [...] } and wrapped { hooks: { EventName: [...] } }
      const map = (data.hooks && typeof data.hooks === 'object' && !Array.isArray(data.hooks))
        ? data.hooks
        : data;
      const entries: HookEntry[] = [];
      for (const [event, hooks] of Object.entries(map)) {
        for (const hook of hooks as Array<Record<string, unknown>>) {
          // Native Claude format: { matcher?: string, hooks: [{ command }] }
          // Legacy marketplace format: { match?: { tool }, run?: { cmd } }
          const nativeHooks = Array.isArray(hook.hooks) ? hook.hooks as Array<{ command?: string }> : null;
          const command = nativeHooks
            ? nativeHooks.find((h) => h.command)?.command
            : (hook.run as { cmd?: string } | undefined)?.cmd;
          const matcher = nativeHooks
            ? (typeof hook.matcher === 'string' ? hook.matcher : undefined)
            : (hook.match as { tool?: string } | undefined)?.tool;
          entries.push({ event, command, matcher, sourceFormat: 'claude' });
        }
      }
      return entries;
    } catch { return []; }
  }

  private scanCodexHooks(dir: string): HookEntry[] {
    const hooksJsonPath = path.join(dir, '.codex', 'hooks.json');
    if (!existsSync(hooksJsonPath)) return [];
    try {
      const data = JSON.parse(readFileSync(hooksJsonPath, 'utf-8'));
      const entries: HookEntry[] = [];
      for (const [event, hooks] of Object.entries(data)) {
        for (const hook of hooks as Array<{ command?: string; matcher?: string }>) {
          entries.push({
            event,
            command: hook.command,
            matcher: hook.matcher,
            sourceFormat: 'codex',
          });
        }
      }
      return entries;
    } catch { return []; }
  }

  private scanMcpServersDir(dir: string): McpServerEntry[] {
    if (!existsSync(dir)) return [];
    try {
      const configPath = path.join(dir, 'config.json');
      if (existsSync(configPath)) {
        const data = JSON.parse(readFileSync(configPath, 'utf-8'));
        return [{ name: path.basename(dir), command: data.command, args: data.args ?? [], env: data.env }];
      }
      return [];
    } catch { return []; }
  }

  private scanMcpServersFromPlugin(pluginDir: string): McpServerEntry[] {
    const mcpJsonPath = path.join(pluginDir, '.mcp.json');
    if (existsSync(mcpJsonPath)) {
      try {
        const data = JSON.parse(readFileSync(mcpJsonPath, 'utf-8'));
        const servers = data.mcpServers ?? {};
        const results: McpServerEntry[] = [];
        for (const [rawServerName, config] of Object.entries(servers)) {
          // Sanitise server names — they flow into TOML section headers and config keys
          const name = safeName(rawServerName);
          if (!name) continue;
          const cfg = config as {
            type?: string;
            command?: string;
            args?: string[];
            url?: string;
            env?: Record<string, string>;
            startup_timeout_sec?: number;
            description?: string;
          };
          const isRemote = cfg.type === 'http' || cfg.type === 'sse';
          // Resolve local script args within the plugin dir — skip the whole server if any arg escapes
          let argsUnsafe = false;
          const args = (cfg.args ?? []).map((arg) => {
            if (arg.endsWith('.js') || arg.endsWith('.ts') || arg.endsWith('.py')) {
              const resolved = safeResolveUnder(pluginDir, arg);
              if (!resolved) { argsUnsafe = true; return arg; }
              // Option-like values such as --output=result.js also end in a script
              // extension without naming a real file — only rewrite real scripts.
              return existsSync(resolved) ? resolved : arg;
            }
            return arg;
          });
          if (argsUnsafe) continue; // reject entire MCP server entry with unsafe script path
          results.push({
            name,
            type: isRemote ? cfg.type as 'http' | 'sse' : 'stdio',
            command: cfg.command ?? '',
            args,
            url: cfg.url,
            env: cfg.env,
            startupTimeoutSec: cfg.startup_timeout_sec,
            description: cfg.description ?? this.inferMcpDescription(name, cfg.args ?? [], cfg.url),
          });
        }
        return results;
      } catch { /* fall through */ }
    }
    const mcpServersDir = path.join(pluginDir, 'mcp-servers');
    return this.scanMcpServersDir(mcpServersDir);
  }
}
