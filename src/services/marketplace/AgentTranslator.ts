import { copyFileSync, mkdirSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import type { AgentName } from '../../utils/agentLaunch.js';
import type { AgentEntry } from './types.js';
import { safeName, safeResolveUnder } from './utils.js';

export class AgentTranslator {
  constructor(private readonly homeDir = os.homedir()) {}

  // Single source of truth for per-agent custom-agent dirs, shared with InstalledScanner.
  static agentsDir(agent: AgentName): string {
    const home = os.homedir();
    switch (agent) {
      case 'claude': return path.join(home, '.claude', 'agents');
      case 'codex': return path.join(home, '.codex', 'agents');
      case 'opencode': return path.join(home, '.config', 'opencode', 'agents');
      case 'pi': throw new Error('Marketplace agents are not supported for Pi');
    }
  }

  // Amux scopes installed agent files as `<pluginId>__<name>.md` to avoid collisions.
  static scopedName(pluginId: string, agentName: string): string {
    return `${pluginId}__${agentName}`;
  }

  private getAgentsDir(agent: AgentName): string {
    switch (agent) {
      case 'claude': return path.join(this.homeDir, '.claude', 'agents');
      case 'codex': return path.join(this.homeDir, '.codex', 'agents');
      case 'opencode': return path.join(this.homeDir, '.config', 'opencode', 'agents');
      case 'pi': throw new Error('Marketplace agents are not supported for Pi');
    }
  }

  // Prefix with pluginId to prevent name collisions between different marketplace plugins
  private scopedName(pluginId: string, agentName: string): string {
    return AgentTranslator.scopedName(pluginId, agentName);
  }

  installForAgent(agentEntry: AgentEntry, agent: AgentName, pluginId: string): string {
    // Codex has no documented support for custom agents — skip silently
    if (agent === 'codex' || agent === 'pi') return '';
    // Reject names that would escape the agents dir once suffixed with `.md`.
    const stem = this.safeStem(agentEntry.name, pluginId);
    if (!stem) throw new Error(`Unsafe agent name: ${agentEntry.name}`);
    const targetDir = this.getAgentsDir(agent);
    const targetPath = safeResolveUnder(targetDir, `${stem}.md`);
    if (!targetPath) throw new Error(`Unsafe agent name: ${agentEntry.name}`);
    mkdirSync(targetDir, { recursive: true });
    copyFileSync(agentEntry.path, targetPath);
    return targetDir;
  }

  uninstallForAgent(agentName: string, agent: AgentName, pluginId?: string): void {
    if (agent === 'codex' || agent === 'pi') return;
    // A hostile agentName/pluginId such as `../../.bashrc` would otherwise let `rmSync`
    // delete an arbitrary `*.md` outside the agents dir. Reject unsafe components and
    // verify containment before removal.
    const stem = this.safeStem(agentName, pluginId);
    if (!stem) return;
    const agentsDir = this.getAgentsDir(agent);
    const targetPath = safeResolveUnder(agentsDir, `${stem}.md`);
    if (!targetPath) return;
    try {
      rmSync(targetPath, { force: true });
    } catch { /* already removed */ }
  }

  // Build the on-disk filename stem, validating each attacker-influenced component so it
  // cannot contain path separators or traversal sequences. Returns null if unsafe.
  private safeStem(agentName: string, pluginId?: string): string | null {
    const name = safeName(agentName);
    if (!name) return null;
    if (pluginId === undefined) return name;
    const plugin = safeName(pluginId);
    if (!plugin) return null;
    return this.scopedName(plugin, name);
  }
}
