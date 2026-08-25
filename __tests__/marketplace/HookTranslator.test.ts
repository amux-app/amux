import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    existsSync: vi.fn(() => false),
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
    rmSync: vi.fn(),
  };
});

import { existsSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { HookTranslator, isMarketplaceHookOwnedBy } from '../../src/services/marketplace/HookTranslator.js';
import type { HookEntry } from '../../src/services/marketplace/types.js';

describe('HookTranslator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(existsSync).mockReturnValue(false);
    vi.mocked(readFileSync).mockReturnValue('');
  });

  describe('claude', () => {
    it('writes hook entry to ~/.claude/settings.json', () => {
      const translator = new HookTranslator();
      const hook: HookEntry = {
        event: 'PostToolUse',
        command: 'npm run lint:fix',
        matcher: 'Edit',
        sourceFormat: 'claude',
      };

      const result = translator.translateForAgent(hook, 'claude', 'test-plugin');
      expect(result.status).toBe('full');
      expect(writeFileSync).toHaveBeenCalledWith(
        expect.stringContaining('.claude/settings.json'),
        expect.any(String),
        'utf-8',
      );
    });

    it('returns partial when hook has no shell command', () => {
      const translator = new HookTranslator();
      const hook: HookEntry = { event: 'PostToolUse', sourceFormat: 'claude' };
      const result = translator.translateForAgent(hook, 'claude', 'test-plugin');
      expect(result.status).toBe('partial');
      expect(result.skipped[0]).toContain('no shell command');
    });

    it('stores special event names as own properties without touching the prototype', () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue('{"hooks":{}}');
      const translator = new HookTranslator();
      const hook: HookEntry = {
        event: '__proto__',
        command: 'true',
        sourceFormat: 'claude',
      };

      translator.translateForAgent(hook, 'claude', 'test-plugin');

      const written = vi.mocked(writeFileSync).mock.calls.at(-1)?.[1];
      const settings = JSON.parse(String(written)) as { hooks: Record<string, unknown> };
      expect(Object.hasOwn(settings.hooks, '__proto__')).toBe(true);
      expect(Array.isArray(settings.hooks['__proto__'])).toBe(true);
      expect(Object.prototype).not.toHaveProperty('__marketplace__');
    });
  });

  describe('codex', () => {
    it('writes hook entry to ~/.codex/hooks.json', () => {
      const translator = new HookTranslator();
      const hook: HookEntry = {
        event: 'PostToolUse',
        command: 'npm run lint:fix',
        sourceFormat: 'codex',
      };

      const result = translator.translateForAgent(hook, 'codex', 'test-plugin');
      expect(result.status).toBe('full');
      expect(writeFileSync).toHaveBeenCalledWith(
        expect.stringContaining('.codex/hooks.json'),
        expect.any(String),
        'utf-8',
      );
    });

    it('returns partial when hook has no shell command', () => {
      const translator = new HookTranslator();
      const hook: HookEntry = { event: 'PostToolUse', sourceFormat: 'codex' };
      const result = translator.translateForAgent(hook, 'codex', 'test-plugin');
      expect(result.status).toBe('partial');
      expect(result.skipped[0]).toContain('no shell command');
    });
  });

  describe('opencode', () => {
    it('wraps shell command in a JS plugin file', () => {
      const translator = new HookTranslator();
      const hook: HookEntry = {
        event: 'PostToolUse',
        command: 'npm run lint:fix',
        matcher: 'Edit',
        sourceFormat: 'claude',
      };

      const result = translator.translateForAgent(hook, 'opencode', 'test-plugin');
      expect(result.status).toBe('full');
      expect(writeFileSync).toHaveBeenCalledWith(
        expect.stringContaining('opencode'),
        expect.stringContaining('tool.execute.after'),
        'utf-8',
      );
    });

    it('returns partial when hook has no shell command', () => {
      const translator = new HookTranslator();
      const hook: HookEntry = { event: 'PostToolUse', sourceFormat: 'opencode' };
      const result = translator.translateForAgent(hook, 'opencode', 'test-plugin');
      expect(result.status).toBe('partial');
      expect(result.skipped[0]).toContain('no shell command');
    });

    it('returns partial for events with no OpenCode equivalent', () => {
      const translator = new HookTranslator();
      const hook: HookEntry = { event: 'UnknownEvent', command: 'echo hi', sourceFormat: 'claude' };
      const result = translator.translateForAgent(hook, 'opencode', 'test-plugin');
      expect(result.status).toBe('partial');
      expect(result.skipped[0]).toContain('no OpenCode equivalent');
    });
  });

  describe('uninstallForAgent', () => {
    it('parses an exact legacy owner for hook events introduced after the original event list', () => {
      const entry = {
        __marketplace__: '__marketplace__foo__bar__SubagentStart__0',
      };

      expect(isMarketplaceHookOwnedBy(entry, 'foo__bar', 'SubagentStart')).toBe(true);
      expect(isMarketplaceHookOwnedBy(entry, 'foo', 'SubagentStart')).toBe(false);
    });

    it('is a no-op for claude when settings.json is missing', () => {
      const translator = new HookTranslator();
      translator.uninstallForAgent('my-plugin', 'claude');
      expect(writeFileSync).not.toHaveBeenCalled();
    });

    it('is a no-op for codex when hooks.json is missing', () => {
      const translator = new HookTranslator();
      translator.uninstallForAgent('my-plugin', 'codex');
      expect(writeFileSync).not.toHaveBeenCalled();
    });

    it('removes the JS plugin file for opencode', () => {
      const translator = new HookTranslator();
      translator.uninstallForAgent('my-plugin', 'opencode');
      expect(rmSync).toHaveBeenCalledWith(
        expect.stringContaining('opencode/plugins/marketplace-my-plugin.js'),
        { force: true },
      );
    });
  });
});
