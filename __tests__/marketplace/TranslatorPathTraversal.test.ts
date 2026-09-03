import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import { tmpdir } from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentTranslator } from '../../src/services/marketplace/AgentTranslator.js';
import { SkillTranslator } from '../../src/services/marketplace/SkillTranslator.js';

// These tests exercise the real filesystem (no fs mock) against a sandboxed fake HOME so
// we can prove a hostile artifact name cannot delete anything outside the agent's own dir.
// A value such as `../../.ssh` must be rejected, not resolved-and-deleted.

let home: string;
let secret: string; // a file OUTSIDE the skills/agents dirs that must survive

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), 'traversal-home-'));
  vi.spyOn(os, 'homedir').mockReturnValue(home);
  // A precious file two levels up from ~/.claude/skills — the classic traversal target.
  secret = path.join(home, 'secret.txt');
  writeFileSync(secret, 'do not delete me');
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(home, { recursive: true, force: true });
});

describe('SkillTranslator path traversal', () => {
  it('does not delete files outside the skills dir for a traversal name', () => {
    const skillsDir = SkillTranslator.skillsDir('claude'); // ~/.claude/skills
    mkdirSync(skillsDir, { recursive: true });

    // ../../secret.txt from ~/.claude/skills resolves to ~/secret.txt.
    new SkillTranslator().uninstallForAgent('../../secret.txt', 'claude');

    expect(existsSync(secret)).toBe(true);
  });

  it('does not delete the skills dir itself for a `.` name', () => {
    const skillsDir = SkillTranslator.skillsDir('claude');
    mkdirSync(skillsDir, { recursive: true });
    writeFileSync(path.join(skillsDir, 'marker'), 'x');

    new SkillTranslator().uninstallForAgent('.', 'claude');

    expect(existsSync(skillsDir)).toBe(true);
    expect(existsSync(path.join(skillsDir, 'marker'))).toBe(true);
  });

  it('still removes a legitimately-named skill', () => {
    const skillsDir = SkillTranslator.skillsDir('claude');
    const skillDir = path.join(skillsDir, 'my-skill');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(path.join(skillDir, 'SKILL.md'), 'content');

    new SkillTranslator().uninstallForAgent('my-skill', 'claude');

    expect(existsSync(skillDir)).toBe(false);
  });

  it('refuses to install a skill with a traversal name', () => {
    expect(() =>
      new SkillTranslator().installForAgent(
        { name: '../../evil', path: '/tmp/whatever/SKILL.md' },
        'claude',
      ),
    ).toThrow(/unsafe skill name/i);
  });
});

describe('AgentTranslator path traversal', () => {
  it('does not delete a .md file outside the agents dir for a traversal name', () => {
    const agentsDir = AgentTranslator.agentsDir('claude'); // ~/.claude/agents
    mkdirSync(agentsDir, { recursive: true });
    // A `*.md` sibling of the traversal target, two levels up.
    const outsideMd = path.join(home, 'important.md');
    writeFileSync(outsideMd, 'keep me');

    // `../../important` + `.md` would resolve to ~/important.md.
    new AgentTranslator().uninstallForAgent('../../important', 'claude');

    expect(existsSync(outsideMd)).toBe(true);
  });

  it('rejects a traversal pluginId component', () => {
    const agentsDir = AgentTranslator.agentsDir('claude');
    mkdirSync(agentsDir, { recursive: true });
    const outsideMd = path.join(home, 'important.md');
    writeFileSync(outsideMd, 'keep me');

    new AgentTranslator().uninstallForAgent('important', 'claude', '../..');

    expect(existsSync(outsideMd)).toBe(true);
  });

  it('still removes a legitimately-named agent file', () => {
    const agentsDir = AgentTranslator.agentsDir('claude');
    mkdirSync(agentsDir, { recursive: true });
    const file = path.join(agentsDir, 'myplugin__reviewer.md');
    writeFileSync(file, 'content');

    new AgentTranslator().uninstallForAgent('reviewer', 'claude', 'myplugin');

    expect(existsSync(file)).toBe(false);
  });

  it('refuses to install an agent with a traversal name', () => {
    expect(() =>
      new AgentTranslator().installForAgent(
        { name: '../../evil', path: '/tmp/whatever.md' },
        'claude',
        'myplugin',
      ),
    ).toThrow(/unsafe agent name/i);
  });
});
