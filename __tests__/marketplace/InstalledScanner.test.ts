import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock fs so the scanner's directory reads (skills + agents) are fully controlled.
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    existsSync: vi.fn(),
    readdirSync: vi.fn(),
    statSync: vi.fn(),
  };
});

// Mock the translators so static path helpers + scan surfaces are deterministic.
vi.mock('../../src/services/marketplace/SkillTranslator.js', () => ({
  SkillTranslator: { skillsDir: (agent: string) => `/home/${agent}/skills` },
}));
vi.mock('../../src/services/marketplace/AgentTranslator.js', () => ({
  AgentTranslator: { agentsDir: (agent: string) => `/home/${agent}/agents` },
}));
vi.mock('../../src/services/marketplace/McpTranslator.js', () => ({
  McpTranslator: { listServerNames: vi.fn(() => [] as string[]) },
}));
vi.mock('../../src/services/marketplace/HookTranslator.js', () => ({
  HookTranslator: { listInstalled: vi.fn(() => [] as { event: string; pluginId?: string }[]) },
}));

import { existsSync, readdirSync, statSync } from 'fs';
import { InstalledScanner } from '../../src/services/marketplace/InstalledScanner.js';
import { McpTranslator } from '../../src/services/marketplace/McpTranslator.js';
import { HookTranslator } from '../../src/services/marketplace/HookTranslator.js';
import type { InstalledPlugin } from '../../src/services/marketplace/types.js';
import type { AgentName } from '../../src/utils/agentLaunch.js';

type Fn = ReturnType<typeof vi.fn>;

// Configure disk contents per agent. skillsByAgent/agentFilesByAgent name the entries the
// mocked fs will surface for `/home/<agent>/skills` and `/home/<agent>/agents`.
function setupDisk(opts: {
  skillsByAgent?: Partial<Record<AgentName, string[]>>;
  agentFilesByAgent?: Partial<Record<AgentName, string[]>>;
  mcpByAgent?: Partial<Record<AgentName, string[]>>;
  hooksByAgent?: Partial<Record<AgentName, { event: string; pluginId?: string }[]>>;
}) {
  const skills = opts.skillsByAgent ?? {};
  const agentFiles = opts.agentFilesByAgent ?? {};

  (existsSync as Fn).mockImplementation((p: string) => {
    for (const [agent, names] of Object.entries(skills)) {
      if (p === `/home/${agent}/skills` && names.length > 0) return true;
    }
    for (const [agent, names] of Object.entries(agentFiles)) {
      if (p === `/home/${agent}/agents` && names.length > 0) return true;
    }
    return false;
  });

  (readdirSync as Fn).mockImplementation((p: string) => {
    for (const [agent, names] of Object.entries(skills)) {
      if (p === `/home/${agent}/skills`) return names;
    }
    for (const [agent, names] of Object.entries(agentFiles)) {
      if (p === `/home/${agent}/agents`) return names;
    }
    return [];
  });

  // Every skill entry is treated as a directory (agents dir entries are read as .md files
  // and never hit statSync).
  (statSync as Fn).mockReturnValue({ isDirectory: () => true });

  (McpTranslator.listServerNames as Fn).mockImplementation(
    (agent: AgentName) => opts.mcpByAgent?.[agent] ?? [],
  );
  (HookTranslator.listInstalled as Fn).mockImplementation(
    (agent: AgentName) => opts.hooksByAgent?.[agent] ?? [],
  );
}

describe('InstalledScanner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('surfaces a skill on disk with no registry record as external', () => {
    setupDisk({ skillsByAgent: { claude: ['my-skill'] } });

    const items = new InstalledScanner().scan(['claude'], []);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      type: 'skill',
      name: 'my-skill',
      agents: ['claude'],
      source: 'external',
      removable: true,
    });
    expect(items[0].pluginId).toBeUndefined();
  });

  it('attributes a skill to amux when the registry lists it in selectedArtifacts', () => {
    setupDisk({ skillsByAgent: { claude: ['my-skill'] } });
    const installed: InstalledPlugin[] = [{
      pluginId: 'plug-a',
      sourceUrl: 'https://example.com/a.git',
      installedAt: '2026-01-01T00:00:00.000Z',
      selectedArtifacts: {
        skills: ['my-skill'], mcpServers: [], agentNames: [],
        hookEvents: [], jsPluginNames: [], usedNativeRegistration: false,
      },
    }];

    const items = new InstalledScanner().scan(['claude'], installed);

    expect(items[0]).toMatchObject({
      type: 'skill',
      name: 'my-skill',
      source: 'amux',
      pluginId: 'plug-a',
      sourceUrl: 'https://example.com/a.git',
    });
  });

  it('unions agents for the same item present on multiple agents', () => {
    setupDisk({ skillsByAgent: { claude: ['shared'], opencode: ['shared'] } });

    const items = new InstalledScanner().scan(['claude', 'opencode'], []);

    expect(items).toHaveLength(1);
    expect(items[0].name).toBe('shared');
    expect(items[0].agents.sort()).toEqual(['claude', 'opencode']);
  });

  it('de-scopes a `pluginId__name` agent file and marks it amux', () => {
    setupDisk({ agentFilesByAgent: { claude: ['myplugin__reviewer.md'] } });
    const installed: InstalledPlugin[] = [{
      pluginId: 'myplugin',
      sourceUrl: 'https://example.com/p.git',
      installedAt: '2026-01-01T00:00:00.000Z',
      selectedArtifacts: {
        skills: [], mcpServers: [], agentNames: ['reviewer'],
        hookEvents: [], jsPluginNames: [], usedNativeRegistration: false,
      },
    }];

    const items = new InstalledScanner().scan(['claude'], installed);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      type: 'agent',
      name: 'reviewer',
      pluginId: 'myplugin',
      source: 'amux',
      sourceUrl: 'https://example.com/p.git',
    });
  });

  it('marks an agent file amux-shaped (no sourceUrl) when no registry record exists', () => {
    setupDisk({ agentFilesByAgent: { claude: ['ghost__helper.md'] } });

    const items = new InstalledScanner().scan(['claude'], []);

    expect(items[0]).toMatchObject({ type: 'agent', name: 'helper', pluginId: 'ghost', source: 'amux' });
    expect(items[0].sourceUrl).toBeUndefined();
  });

  it('leaves an unscoped external agent file as its raw name', () => {
    setupDisk({ agentFilesByAgent: { claude: ['handmade.md'] } });

    const items = new InstalledScanner().scan(['claude'], []);

    expect(items[0]).toMatchObject({ type: 'agent', name: 'handmade', source: 'external' });
    expect(items[0].pluginId).toBeUndefined();
  });

  it('marks sentinel hooks removable and non-sentinel hooks not removable', () => {
    setupDisk({
      hooksByAgent: {
        claude: [
          { event: 'PostToolUse', pluginId: 'hookplug' },
          { event: 'PreToolUse' }, // no pluginId — not attributable
        ],
      },
    });

    const items = new InstalledScanner().scan(['claude'], []);

    const sentinel = items.find((i) => i.name === 'PostToolUse');
    const plain = items.find((i) => i.name === 'PreToolUse');
    expect(sentinel).toMatchObject({ type: 'hook', removable: true, pluginId: 'hookplug' });
    expect(plain).toMatchObject({ type: 'hook', removable: false });
    expect(plain?.pluginId).toBeUndefined();
  });

  it('is removable only if removable on every agent it appears on', () => {
    setupDisk({
      hooksByAgent: {
        claude:    [{ event: 'PostToolUse', pluginId: 'hookplug' }], // removable
        opencode:  [{ event: 'PostToolUse', pluginId: 'hookplug' }], // same plugin, also removable
        codex:     [{ event: 'PostToolUse' }],                        // external — not removable
      },
    });

    const items = new InstalledScanner().scan(['claude', 'opencode', 'codex'], []);

    // The attributed hook (hookplug) and the external hook are separate rows.
    const attributed = items.find((i) => i.type === 'hook' && i.pluginId === 'hookplug');
    const external   = items.find((i) => i.type === 'hook' && !i.pluginId);
    expect(attributed).toBeDefined();
    expect(attributed!.agents.sort()).toEqual(['claude', 'opencode']);
    expect(attributed!.removable).toBe(true);
    expect(external).toBeDefined();
    expect(external!.agents).toEqual(['codex']);
    expect(external!.removable).toBe(false);
  });

  it('lists mcp servers per agent from the translator', () => {
    setupDisk({ mcpByAgent: { claude: ['fetch', 'db'] } });

    const items = new InstalledScanner().scan(['claude'], []);

    const names = items.filter((i) => i.type === 'mcpServer').map((i) => i.name).sort();
    expect(names).toEqual(['db', 'fetch']);
  });

  it('returns nothing for codex when it has no agent/skill dirs', () => {
    setupDisk({}); // nothing on disk for any agent

    const items = new InstalledScanner().scan(['codex'], []);

    expect(items).toEqual([]);
  });

  it('returns an empty list cleanly when directories do not exist', () => {
    (existsSync as Fn).mockReturnValue(false);
    (readdirSync as Fn).mockReturnValue([]);
    (McpTranslator.listServerNames as Fn).mockReturnValue([]);
    (HookTranslator.listInstalled as Fn).mockReturnValue([]);

    const items = new InstalledScanner().scan(['claude', 'codex', 'opencode'], []);

    expect(items).toEqual([]);
  });
});
