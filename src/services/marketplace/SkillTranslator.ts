import { cpSync, mkdirSync, mkdtempSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import type { AgentName } from '../../utils/agentLaunch.js';
import { materializeMarketplaceSourceTree } from './MarketplaceSourceTree.js';
import type { SkillEntry } from './types.js';
import { safeName, safeResolveUnder } from './utils.js';

export class SkillTranslator {
  constructor(private readonly homeDir = os.homedir()) {}

  // Single source of truth for on-disk skill locations, shared with InstalledScanner.
  static skillsDir(agent: AgentName): string {
    const home = os.homedir();
    switch (agent) {
      case 'claude': return path.join(home, '.claude', 'skills');
      case 'codex': return path.join(home, '.codex', 'skills');
      case 'opencode': return path.join(home, '.config', 'opencode', 'skills');
      case 'pi': throw new Error('Marketplace skills are not supported for Pi');
    }
  }

  private getSkillsDir(agent: AgentName): string {
    switch (agent) {
      case 'claude': return path.join(this.homeDir, '.claude', 'skills');
      case 'codex': return path.join(this.homeDir, '.codex', 'skills');
      case 'opencode': return path.join(this.homeDir, '.config', 'opencode', 'skills');
      case 'pi': throw new Error('Marketplace skills are not supported for Pi');
    }
  }

  installForAgent(skill: SkillEntry, agent: AgentName, containmentRoot?: string): string {
    // Guard against a hostile skill name escaping the skills dir (path traversal).
    const clean = safeName(skill.name);
    if (!clean) throw new Error(`Unsafe skill name: ${skill.name}`);
    const skillsDir = this.getSkillsDir(agent);
    const targetDir = safeResolveUnder(skillsDir, clean);
    if (!targetDir) throw new Error(`Unsafe skill name: ${skill.name}`);
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
    // A malicious skillName such as `../../.ssh` would otherwise recursively delete an
    // arbitrary user directory. Reject unsafe components and verify path containment.
    const clean = safeName(skillName);
    if (!clean) return;
    const skillsDir = this.getSkillsDir(agent);
    const targetDir = safeResolveUnder(skillsDir, clean);
    if (!targetDir || targetDir === skillsDir) return;
    try {
      rmSync(targetDir, { recursive: true, force: true });
    } catch { /* already removed */ }
  }
}
