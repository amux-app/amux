import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const createWelcomePane = vi.hoisted(() => vi.fn());
const destroyWelcomePane = vi.hoisted(() => vi.fn());
const welcomePaneExists = vi.hoisted(() => vi.fn());

vi.mock('../../src/utils/welcomePane.js', () => ({
  createWelcomePane,
  destroyWelcomePane,
  welcomePaneExists,
}));

import { createWelcomePaneCoordinated, destroyWelcomePaneCoordinated } from '../../src/utils/welcomePaneManager.js';

describe('welcome pane config mutations', () => {
  const roots: string[] = [];

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    createWelcomePane.mockReset();
    destroyWelcomePane.mockReset();
    welcomePaneExists.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    for (const root of roots) rmSync(root, { force: true, recursive: true });
    roots.length = 0;
  });

  function createConfig(welcomePaneId?: string): string {
    const root = mkdtempSync(path.join(tmpdir(), 'muxbase-welcome-'));
    roots.push(root);
    mkdirSync(path.join(root, '.muxbase'));
    const configPath = path.join(root, '.muxbase', 'muxbase.config.json');
    writeFileSync(configPath, JSON.stringify({
      customField: { preserved: true },
      lastUpdated: 'old',
      panes: [],
      projectName: 'demo',
      projectRoot: root,
      ...(welcomePaneId ? { welcomePaneId } : {}),
    }));
    return root;
  }

  it('clears only the welcome pane field while preserving config data', () => {
    const root = createConfig('%welcome');

    expect(destroyWelcomePaneCoordinated(root)).toBe(true);

    const config = JSON.parse(readFileSync(path.join(root, '.muxbase', 'muxbase.config.json'), 'utf8')) as Record<string, unknown>;
    expect(config.welcomePaneId).toBeUndefined();
    expect(config.customField).toEqual({ preserved: true });
    expect(destroyWelcomePane).toHaveBeenCalledWith('%welcome');
  });

  it('records a newly created welcome pane through the field-owned mutation', async () => {
    const root = createConfig();
    createWelcomePane.mockResolvedValue('%welcome-2');
    welcomePaneExists.mockResolvedValue(false);

    expect(await createWelcomePaneCoordinated(root, '%control')).toBe(true);

    const config = JSON.parse(readFileSync(path.join(root, '.muxbase', 'muxbase.config.json'), 'utf8')) as Record<string, unknown>;
    expect(config.welcomePaneId).toBe('%welcome-2');
    expect(config.customField).toEqual({ preserved: true });
    expect(createWelcomePane).toHaveBeenCalledWith('%control');
  });
});
