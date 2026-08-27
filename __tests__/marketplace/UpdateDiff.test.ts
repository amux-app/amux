import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildSnapshot, diffAgainstSnapshot } from '../../src/services/marketplace/UpdateDiff.js';
import type { DetectedPlugin } from '../../src/services/marketplace/types.js';

function plugin(overrides: Partial<DetectedPlugin> & Pick<DetectedPlugin, 'id' | 'name'>): DetectedPlugin {
  return {
    description: undefined,
    version: undefined,
    skills: [],
    agents: [],
    hooks: [],
    mcpServers: [],
    jsPlugins: [],
    ...overrides,
  };
}

const source = { url: 'https://example.com/org/repo', name: 'org-repo' };

// Skills are hashed at the directory level (<skillDir>/SKILL.md), matching real install layout.
// Each skill lives in its own subdirectory so distinct skills don't share a directory hash.
let dir: string;
const write = (name: string, contents: string): string => {
  const p = path.join(dir, name);
  writeFileSync(p, contents);
  return p;
};
// Create <dir>/<skillName>/SKILL.md and return the SKILL.md path (matches SkillEntry.path).
const writeSkill = (skillName: string, contents: string): string => {
  const skillDir = path.join(dir, skillName);
  mkdirSync(skillDir, { recursive: true });
  const p = path.join(skillDir, 'SKILL.md');
  writeFileSync(p, contents);
  return p;
};

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'updatediff-'));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('buildSnapshot', () => {
  it('reduces each plugin to a per-type map of item name to content hash', () => {
    const skillPath = writeSkill('skill-a', 'alpha');
    const snapshot = buildSnapshot([
      plugin({
        id: 'p1',
        name: 'Plugin One',
        skills: [{ name: 'skill-a', path: skillPath }],
        mcpServers: [{ name: 'mcp-x', args: [] }],
        hooks: [{ event: 'PreToolUse', sourceFormat: 'claude' }],
      }),
    ]);

    expect(Object.keys(snapshot)).toEqual(['p1']);
    expect(Object.keys(snapshot.p1.skills)).toEqual(['skill-a']);
    expect(snapshot.p1.skills['skill-a']).toMatch(/^[0-9a-f]{40}$/);
    expect(Object.keys(snapshot.p1.mcpServers)).toEqual(['mcp-x']);
    expect(Object.keys(snapshot.p1.hookEvents)).toEqual(['PreToolUse']);
  });

  it('produces an empty snapshot for no plugins', () => {
    expect(buildSnapshot([])).toEqual({});
  });
});

describe('diffAgainstSnapshot', () => {
  it('reports a newly added skill as changeType "new"', () => {
    const s1 = writeSkill('skill1', 'one');
    const previous = buildSnapshot([
      plugin({ id: 'p1', name: 'Plugin One', skills: [{ name: 'skill1', path: s1 }] }),
    ]);
    const s2 = writeSkill('skill2', 'two');
    const current = [
      plugin({
        id: 'p1',
        name: 'Plugin One',
        skills: [
          { name: 'skill1', path: s1 },
          { name: 'skill2', path: s2, description: 'the second' },
        ],
      }),
    ];

    const updates = diffAgainstSnapshot(source, current, previous);

    expect(updates).toEqual([
      {
        sourceUrl: source.url,
        sourceName: source.name,
        pluginId: 'p1',
        pluginName: 'Plugin One',
        newArtifacts: [{ type: 'skill', name: 'skill2', description: 'the second', changeType: 'new', changedAt: expect.any(String) }],
      },
    ]);
  });

  it('reports a same-named skill whose content changed as changeType "updated"', () => {
    const skillPath = writeSkill('changing-skill', 'v1');
    const previous = buildSnapshot([
      plugin({ id: 'p1', name: 'One', skills: [{ name: 'sk', path: skillPath }] }),
    ]);
    // Rewrite the file so its hash differs from the snapshot.
    writeFileSync(skillPath, 'v2 — changed');
    const current = [
      plugin({ id: 'p1', name: 'One', skills: [{ name: 'sk', path: skillPath, description: 'desc' }] }),
    ];

    const updates = diffAgainstSnapshot(source, current, previous);

    expect(updates).toHaveLength(1);
    expect(updates[0].newArtifacts).toEqual([
      { type: 'skill', name: 'sk', description: 'desc', changeType: 'updated', changedAt: expect.any(String) },
    ]);
  });

  it('returns no updates when content is unchanged', () => {
    const skillPath = writeSkill('stable-skill', 'stable');
    const plugins = [
      plugin({ id: 'p1', name: 'One', skills: [{ name: 'sk', path: skillPath }] }),
    ];
    expect(diffAgainstSnapshot(source, plugins, buildSnapshot(plugins))).toEqual([]);
  });

  it('detects an mcp server config change as "updated"', () => {
    const previous = buildSnapshot([
      plugin({ id: 'p1', name: 'One', mcpServers: [{ name: 'mcp', command: 'node', args: ['a.js'] }] }),
    ]);
    const current = [
      plugin({ id: 'p1', name: 'One', mcpServers: [{ name: 'mcp', command: 'node', args: ['b.js'] }] }),
    ];

    const updates = diffAgainstSnapshot(source, current, previous);
    expect(updates[0].newArtifacts).toEqual([
      { type: 'mcpServer', name: 'mcp', description: undefined, changeType: 'updated', changedAt: expect.any(String) },
    ]);
  });

  it('treats a plugin absent from the previous snapshot as entirely new', () => {
    const s1 = writeSkill('p2-skill1', 'x');
    const previous = buildSnapshot([plugin({ id: 'p1', name: 'One', skills: [{ name: 's1', path: s1 }] })]);
    const current = [
      plugin({ id: 'p1', name: 'One', skills: [{ name: 's1', path: s1 }] }),
      plugin({ id: 'p2', name: 'Two', mcpServers: [{ name: 'mcp1', args: [] }] }),
    ];

    const updates = diffAgainstSnapshot(source, current, previous);

    expect(updates).toHaveLength(1);
    expect(updates[0].pluginId).toBe('p2');
    expect(updates[0].newArtifacts).toEqual([
      { type: 'mcpServer', name: 'mcp1', description: undefined, changeType: 'new', changedAt: expect.any(String) },
    ]);
  });

  it('reports every item as "new" when there is no previous snapshot', () => {
    const s1 = writeSkill('none-skill1', 'x');
    const a1 = write('none-a1.md', '---\n');
    const current = [
      plugin({
        id: 'p1',
        name: 'One',
        skills: [{ name: 's1', path: s1 }],
        agents: [{ name: 'a1', path: a1 }],
      }),
    ];

    const updates = diffAgainstSnapshot(source, current, undefined);

    expect(updates).toHaveLength(1);
    expect(updates[0].newArtifacts.map((a) => `${a.type}:${a.name}:${a.changeType}`))
      .toEqual(['skill:s1:new', 'agent:a1:new']);
  });

  it('does not report items removed since the snapshot', () => {
    const s1 = writeSkill('rm-skill1', 'a');
    const s2 = writeSkill('rm-skill2', 'b');
    const previous = buildSnapshot([
      plugin({ id: 'p1', name: 'One', skills: [{ name: 's1', path: s1 }, { name: 's2', path: s2 }] }),
    ]);
    const current = [
      plugin({ id: 'p1', name: 'One', skills: [{ name: 's1', path: s1 }] }),
    ];

    expect(diffAgainstSnapshot(source, current, previous)).toEqual([]);
  });

  it('migrates a legacy names-only snapshot without falsely flagging updates', () => {
    const skillPath = writeSkill('legacy-skill', 'content');
    // Legacy snapshot shape: item names as bare string[] (pre-hash format).
    const legacy = {
      p1: { skills: ['sk'], mcpServers: [], agents: [], jsPlugins: [], hookEvents: [] },
    } as never;
    const current = [
      plugin({ id: 'p1', name: 'One', skills: [{ name: 'sk', path: skillPath }] }),
    ];

    // 'sk' is known from the legacy snapshot (not new) and has no baseline hash to
    // compare, so it must not be reported as updated either.
    expect(diffAgainstSnapshot(source, current, legacy)).toEqual([]);
  });
});
