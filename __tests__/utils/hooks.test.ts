import { execFileSync } from 'child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildHookEnvironment, findHook, initializeHooksDirectory, triggerHookSync } from '../../src/utils/hooks.js';

describe('hooks initialization', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots) {
      rmSync(root, { force: true, recursive: true });
    }
    roots.length = 0;
  });

  it('gitignores Amux metadata directories when hooks are initialized', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'aumx-hooks-'));
    roots.push(projectRoot);
    mkdirSync(join(projectRoot, '.git'));
    writeFileSync(join(projectRoot, '.gitignore'), 'node_modules/\n');

    initializeHooksDirectory(projectRoot);

    const gitignore = readFileSync(join(projectRoot, '.gitignore'), 'utf-8');
    expect(gitignore).toContain('.amux/');
    expect(gitignore).toContain('.amux-hooks/');
    expect(existsSync(join(projectRoot, '.amux-hooks'))).toBe(true);
  });

  it('keeps generated legacy hooks on the active metadata path', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'aumx-hooks-legacy-'));
    roots.push(projectRoot);
    mkdirSync(join(projectRoot, '.git'));
    mkdirSync(join(projectRoot, '.aumx'));

    initializeHooksDirectory(projectRoot);
    const env = await buildHookEnvironment(projectRoot);
    const example = readFileSync(
      join(projectRoot, '.aumx-hooks', 'examples', 'worktree_created.example'),
      'utf-8',
    );

    expect(env.AUMX_METADATA_DIR).toBe(join(projectRoot, '.aumx'));
    expect(env.AUMX_HOOKS_DIR).toBe(join(projectRoot, '.aumx-hooks'));
    expect(example).toContain('$AUMX_METADATA_DIR/worktree_history.log');
    expect(example).not.toContain('$AUMX_ROOT/.amux/');
  });

  it('does not expose ambient secrets to hook environments', async () => {
    const previousSecret = process.env.OPENROUTER_API_KEY;
    const previousAumx = process.env.AUMX_EXISTING_VALUE;
    process.env.OPENROUTER_API_KEY = 'secret-token';
    process.env.AUMX_EXISTING_VALUE = 'kept';

    try {
      const env = await buildHookEnvironment('/repo', undefined, { AUMX_EXTRA: 'extra' });

      expect(env.OPENROUTER_API_KEY).toBeUndefined();
      expect(env.AUMX_ROOT).toBe('/repo');
      expect(env.AUMX_EXISTING_VALUE).toBe('kept');
      expect(env.AUMX_EXTRA).toBe('extra');
      expect(env.PATH).toBe(process.env.PATH);
    } finally {
      if (previousSecret === undefined) {
        delete process.env.OPENROUTER_API_KEY;
      } else {
        process.env.OPENROUTER_API_KEY = previousSecret;
      }
      if (previousAumx === undefined) {
        delete process.env.AUMX_EXISTING_VALUE;
      } else {
        process.env.AUMX_EXISTING_VALUE = previousAumx;
      }
    }
  });

  it('skips git-tracked project hooks and falls back to local hooks', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'aumx-hooks-'));
    roots.push(projectRoot);
    execFileSync('git', ['init'], { cwd: projectRoot, stdio: 'ignore' });

    const trackedHook = join(projectRoot, '.aumx-hooks', 'pane_created');
    const localHook = join(projectRoot, '.aumx', 'hooks', 'pane_created');
    mkdirSync(join(projectRoot, '.aumx-hooks'), { recursive: true });
    mkdirSync(join(projectRoot, '.aumx', 'hooks'), { recursive: true });
    writeFileSync(trackedHook, '#!/bin/sh\nexit 0\n');
    writeFileSync(localHook, '#!/bin/sh\nexit 0\n');
    chmodSync(trackedHook, 0o755);
    chmodSync(localHook, 0o755);
    execFileSync('git', ['add', '.aumx-hooks/pane_created'], { cwd: projectRoot, stdio: 'ignore' });

    expect(findHook(projectRoot, 'pane_created')).toBe(localHook);
  });

  it('rechecks project hook tracking when the git index changes', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'aumx-hooks-'));
    roots.push(projectRoot);
    execFileSync('git', ['init'], { cwd: projectRoot, stdio: 'ignore' });

    const hookPath = join(projectRoot, '.aumx-hooks', 'pane_created');
    mkdirSync(join(projectRoot, '.aumx-hooks'), { recursive: true });
    writeFileSync(hookPath, '#!/bin/sh\nexit 0\n');
    chmodSync(hookPath, 0o755);

    expect(findHook(projectRoot, 'pane_created')).toBe(hookPath);

    execFileSync('git', ['add', '.aumx-hooks/pane_created'], { cwd: projectRoot, stdio: 'ignore' });

    expect(findHook(projectRoot, 'pane_created')).toBeNull();
  });

  it('runs synchronous hooks without shell-parsing the hook path', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'aumx hooks '));
    roots.push(projectRoot);

    const hookPath = join(projectRoot, '.aumx-hooks', 'pane_created');
    mkdirSync(join(projectRoot, '.aumx-hooks'), { recursive: true });
    writeFileSync(hookPath, '#!/bin/sh\nprintf ok\n');
    chmodSync(hookPath, 0o755);

    await expect(triggerHookSync('pane_created', projectRoot)).resolves.toEqual({
      success: true,
      output: 'ok',
    });
  });
});
