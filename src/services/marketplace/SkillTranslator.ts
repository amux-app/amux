import { cpSync, mkdirSync, mkdtempSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import type { AgentName } from '../../utils/agentLaunch.js';
import { materializeMarketplaceSourceTree } from './MarketplaceSourceTree.js';
import type { SkillEntry } from './types.js';

export class SkillTranslator {
  constructor(private readonly homeDir = os.homedir()) {}

  private getSkillsDir(agent: AgentName): string {
    switch (agent) {
      case 'claude': return path.join(this.homeDir, '.claude', 'skills');
      case 'codex': return path.join(this.homeDir, '.codex', 'skills');
      case 'opencode': return path.join(this.homeDir, '.config', 'opencode', 'skills');
      case 'pi': throw new Error('Marketplace skills are not supported for Pi');
    }
  }

  installForAgent(skill: SkillEntry, agent: AgentName, containmentRoot?: string): string {
    const targetDir = path.join(this.getSkillsDir(agent), skill.name);
    mkdirSync(path.dirname(targetDir), { recursive: true });
    // Copy the whole skill directory (scripts/, references/, and other assets included)
    if (!containmentRoot) {
      cpSync(path.dirname(skill.path), targetDir, { recursive: true });
      return targetDir;
    }

    const stagingRoot = mkdtempSync(path.join(os.tmpdir(), 'muxbase-marketplace-skill-'));
    const stagedSkill = path.join(stagingRoot, skill.name);
    try {
      materializeMarketplaceSourceTree(path.dirname(skill.path), stagedSkill, containmentRoot);
      cpSync(stagedSkill, targetDir, { recursive: true });
    } finally {
      rmSync(stagingRoot, { force: true, recursive: true });
    }
    return targetDir;
  }

  uninstallForAgent(skillName: string, agent: AgentName): void {
    const targetDir = path.join(this.getSkillsDir(agent), skillName);
    try {
      rmSync(targetDir, { recursive: true, force: true });
    } catch { /* already removed */ }
  }
}
