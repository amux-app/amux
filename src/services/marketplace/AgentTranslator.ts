import { copyFileSync, mkdirSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import type { AgentName } from '../../utils/agentLaunch.js';
import type { AgentEntry } from './types.js';

export class AgentTranslator {
  constructor(private readonly homeDir = os.homedir()) {}

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
    return `${pluginId}__${agentName}`;
  }

  installForAgent(agentEntry: AgentEntry, agent: AgentName, pluginId: string): string {
    // Codex has no documented support for custom agents — skip silently
    if (agent === 'codex' || agent === 'pi') return '';
    const targetDir = this.getAgentsDir(agent);
    mkdirSync(targetDir, { recursive: true });
    const targetPath = path.join(targetDir, `${this.scopedName(pluginId, agentEntry.name)}.md`);
    copyFileSync(agentEntry.path, targetPath);
    return targetDir;
  }

  uninstallForAgent(agentName: string, agent: AgentName, pluginId: string): void {
    if (agent === 'codex' || agent === 'pi') return;
    const targetPath = path.join(this.getAgentsDir(agent), `${this.scopedName(pluginId, agentName)}.md`);
    try {
      rmSync(targetPath, { force: true });
    } catch { /* already removed */ }
  }
}
