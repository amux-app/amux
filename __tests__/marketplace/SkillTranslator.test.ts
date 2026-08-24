import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    existsSync: vi.fn(),
    mkdirSync: vi.fn(),
    cpSync: vi.fn(),
    rmSync: vi.fn(),
  };
});

import { cpSync, mkdirSync } from 'fs';
import { SkillTranslator } from '../../src/services/marketplace/SkillTranslator.js';
import type { SkillEntry } from '../../src/services/marketplace/types.js';

describe('SkillTranslator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('copies skill directory to claude skills path', () => {
    const translator = new SkillTranslator();
    const skill: SkillEntry = { name: 'my-skill', path: '/tmp/source/my-skill/SKILL.md' };

    translator.installForAgent(skill, 'claude');

    expect(mkdirSync).toHaveBeenCalledWith(
      expect.stringContaining('.claude'),
      { recursive: true },
    );
    expect(cpSync).toHaveBeenCalledWith(
      '/tmp/source/my-skill',
      expect.stringContaining('.claude/skills/my-skill'),
      { recursive: true },
    );
  });

  it('copies skill directory to codex skills path', () => {
    const translator = new SkillTranslator();
    const skill: SkillEntry = { name: 'my-skill', path: '/tmp/source/my-skill/SKILL.md' };

    translator.installForAgent(skill, 'codex');

    expect(cpSync).toHaveBeenCalledWith(
      '/tmp/source/my-skill',
      expect.stringContaining('.codex/skills/my-skill'),
      { recursive: true },
    );
  });

  it('copies skill directory to opencode skills path', () => {
    const translator = new SkillTranslator();
    const skill: SkillEntry = { name: 'my-skill', path: '/tmp/source/my-skill/SKILL.md' };

    translator.installForAgent(skill, 'opencode');

    expect(cpSync).toHaveBeenCalledWith(
      '/tmp/source/my-skill',
      expect.stringContaining('opencode/skills/my-skill'),
      { recursive: true },
    );
  });

  it('returns the installed path', () => {
    const translator = new SkillTranslator();
    const skill: SkillEntry = { name: 'my-skill', path: '/tmp/source/my-skill/SKILL.md' };

    const result = translator.installForAgent(skill, 'claude');
    expect(result).toContain('.claude/skills/my-skill');
  });
});
