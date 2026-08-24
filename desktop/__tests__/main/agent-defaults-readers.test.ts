import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

const homeState = vi.hoisted(() => ({ value: '' }));
const settings = vi.hoisted(() => ({ claudeEffort: '', claudeModel: '' }));

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return { ...actual, homedir: () => homeState.value };
});
vi.mock('aumx/core', () => ({
  SettingsManager: {
    getInstance: vi.fn(() => ({ getSettings: () => settings })),
  },
}));

async function importReaders() {
  vi.resetModules();
  return {
    claude: await import('../../src/main/services/agent-defaults/ClaudeDefaultsReader.js'),
    codex: await import('../../src/main/services/agent-defaults/CodexDefaultsReader.js'),
    opencode: await import('../../src/main/services/agent-defaults/OpencodeDefaultsReader.js'),
  };
}

describe('agent default readers', () => {
  let home = '';

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'aumx-agent-defaults-'));
    homeState.value = home;
    settings.claudeEffort = '';
    settings.claudeModel = '';
    delete process.env.ANTHROPIC_MODEL;
  });

  afterEach(async () => {
    delete process.env.ANTHROPIC_MODEL;
    await rm(home, { force: true, recursive: true });
  });

  it('reads Claude settings with Amux, environment, file, and fallback precedence', async () => {
    const claudeDir = join(home, '.claude');
    await (await import('node:fs/promises')).mkdir(claudeDir, { recursive: true });
    await writeFile(
      join(claudeDir, 'settings.json'),
      JSON.stringify({ env: { ANTHROPIC_MODEL: 'claude-haiku-latest' } }),
    );
    const { claude } = await importReaders();

    expect(claude.readClaudeDefaults('/repo')).toEqual({
      effort: 'ultracode',
      model: 'haiku',
    });
    process.env.ANTHROPIC_MODEL = 'claude-sonnet-4';
    expect(claude.readClaudeDefaults('/repo')).toEqual({
      effort: 'ultracode',
      model: 'sonnet',
    });
    settings.claudeModel = 'claude-opus-latest';
    settings.claudeEffort = 'high';
    expect(claude.readClaudeDefaults('/repo')).toEqual({
      effort: 'high',
      model: 'claude-opus-latest',
    });
  });

  it('falls back safely for missing, malformed, and oversized configuration files', async () => {
    const readers = await importReaders();
    expect(readers.claude.readClaudeDefaults()).toEqual({
      effort: 'ultracode',
      model: 'opus',
    });
    expect(readers.codex.readCodexDefaults()).toEqual({});
    expect(readers.opencode.readOpencodeDefaults()).toEqual({});

    const claudeDir = join(home, '.claude');
    const codexDir = join(home, '.codex');
    const opencodeDir = join(home, '.config', 'opencode');
    await (await import('node:fs/promises')).mkdir(claudeDir, { recursive: true });
    await (await import('node:fs/promises')).mkdir(codexDir, { recursive: true });
    await (await import('node:fs/promises')).mkdir(opencodeDir, { recursive: true });
    await writeFile(join(claudeDir, 'settings.json'), '{broken');
    await writeFile(join(codexDir, 'config.toml'), 'model = "gpt"\n'.repeat(100_000));
    await writeFile(join(opencodeDir, 'opencode.json'), '{broken');
    const fresh = await importReaders();
    expect(fresh.claude.readClaudeDefaults()).toEqual({
      effort: 'ultracode',
      model: 'opus',
    });
    expect(fresh.codex.readCodexDefaults()).toEqual({});
    expect(fresh.opencode.readOpencodeDefaults()).toEqual({});
  });

  it('reads only top-level Codex TOML keys before the first section', async () => {
    await (await import('node:fs/promises')).mkdir(join(home, '.codex'), { recursive: true });
    await writeFile(
      join(home, '.codex', 'config.toml'),
      [
        'model = "gpt-5"',
        'model_reasoning_effort = "high"',
        '[profiles.default]',
        'model = "nested-model"',
        'model_reasoning_effort = "low"',
      ].join('\n'),
    );
    const { codex } = await importReaders();
    expect(codex.readCodexDefaults()).toEqual({
      effort: 'high',
      model: 'gpt-5',
    });
  });

  it('resolves OpenCode mode, reasoning, sorted models, and the 1,000-model cap', async () => {
    const models = Object.fromEntries(Array.from({ length: 1_005 }, (_, index) => [`m-${index}`, {}]));
    await (await import('node:fs/promises')).mkdir(join(home, '.config', 'opencode'), { recursive: true });
    await writeFile(
      join(home, '.config', 'opencode', 'opencode.json'),
      JSON.stringify({
        mode: {
          build: { model: 'openai/build-model' },
          invalid: { model: 42 },
        },
        model: 'openai/gpt-5',
        provider: {
          openai: {
            models: { 'gpt-5': { reasoningEffort: 'high' }, ...models },
          },
        },
      }),
    );
    const { opencode } = await importReaders();
    const result = opencode.readOpencodeDefaults();
    expect(result.model).toBe('openai/gpt-5');
    expect(result.effort).toBe('high');
    expect(result.modelByMode).toEqual({ build: 'openai/build-model' });
    expect(result.availableModels).toHaveLength(1_000);
    expect(result.availableModels).toEqual([...result.availableModels!].sort());
  });
});
