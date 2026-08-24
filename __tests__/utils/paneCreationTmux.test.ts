import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const setupSidebarLayout = vi.hoisted(() => vi.fn(() => '%2'));
const splitPane = vi.hoisted(() => vi.fn(() => '%3'));
const ensureMinimumWindowSize = vi.hoisted(() => vi.fn());
const updateAumxControlFields = vi.hoisted(() => vi.fn());

vi.mock('../../src/utils/tmux.js', () => ({
  ensureMinimumWindowSize,
  setupSidebarLayout,
  splitPane,
}));

vi.mock('../../src/utils/aumxConfigMutation.js', () => ({
  updateAumxControlFields,
}));

import {
  allocateTmuxPane,
  resolveControlPane,
} from '../../src/utils/paneCreationTmux.js';

const logger = {
  error: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
};
const fixtureRoots: string[] = [];

function writeConfig(controlPaneId: string): string {
  const root = mkdtempSync(join(tmpdir(), 'aumx-pane-creation-tmux-'));
  const configPath = join(root, 'aumx.config.json');
  fixtureRoots.push(root);
  writeFileSync(configPath, JSON.stringify({ controlPaneId }));
  return configPath;
}

function makeTmux() {
  return {
    getPaneSessionName: vi.fn(async () => 'aumx-project'),
    newWindowPane: vi.fn(async () => '%window'),
    paneExists: vi.fn(async () => true),
  };
}

describe('pane creation tmux allocation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupSidebarLayout.mockReturnValue('%2');
    splitPane.mockReturnValue('%3');
  });

  afterEach(() => {
    for (const root of fixtureRoots.splice(0)) {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it('replaces a stale configured control pane with the current pane', async () => {
    const tmux = makeTmux();
    tmux.paneExists.mockResolvedValue(false);
    const configPath = writeConfig('%stale');

    const controlPaneId = await resolveControlPane({
      configPath,
      originalPaneId: '%1',
      tmuxService: tmux,
      log: logger,
    });

    expect(controlPaneId).toBe('%1');
    expect(updateAumxControlFields).toHaveBeenCalledWith(
      configPath,
      { controlPaneId: '%1', controlPaneSize: 40 },
    );
  });

  it('trusts a caller-validated configured control pane without probing tmux', async () => {
    const tmux = makeTmux();
    const configPath = writeConfig('%configured');

    const controlPaneId = await resolveControlPane({
      configPath,
      originalPaneId: '%1',
      providedControlPaneId: '%1',
      tmuxService: tmux,
      log: logger,
    });

    expect(controlPaneId).toBe('%configured');
    expect(tmux.paneExists).not.toHaveBeenCalled();
    expect(updateAumxControlFields).not.toHaveBeenCalled();
  });

  it('falls back to a new window when a sidebar split has no space', async () => {
    const tmux = makeTmux();
    setupSidebarLayout.mockImplementationOnce(() => {
      throw new Error('no space for new pane');
    });

    const result = await allocateTmuxPane({
      configPath: '/project/.amux/aumx.config.json',
      controlPaneId: '%1',
      existingPaneIds: [],
      isFirstContentPane: true,
      layoutMode: 'sidebar',
      originalPaneId: '%1',
      paneCwd: '/project',
      tmuxService: tmux,
      log: logger,
    });

    expect(result).toEqual({
      controlPaneId: '%1',
      paneId: '%window',
      usedWindowFallback: true,
    });
    expect(tmux.newWindowPane).toHaveBeenCalledWith({
      cwd: '/project',
      sessionName: 'aumx-project',
    });
  });

  it('repairs a stale control pane and retries the sidebar allocation once', async () => {
    const tmux = makeTmux();
    setupSidebarLayout
      .mockImplementationOnce(() => {
        throw new Error("can't find pane: %stale");
      })
      .mockReturnValueOnce('%recovered');

    const result = await allocateTmuxPane({
      configPath: '/project/.amux/aumx.config.json',
      controlPaneId: '%stale',
      existingPaneIds: [],
      isFirstContentPane: true,
      layoutMode: 'sidebar',
      originalPaneId: '%1',
      paneCwd: '/project',
      tmuxService: tmux,
      log: logger,
    });

    expect(result).toEqual({
      controlPaneId: '%1',
      paneId: '%recovered',
      usedWindowFallback: false,
    });
    expect(setupSidebarLayout.mock.calls).toEqual([
      ['%stale', '/project'],
      ['%1', '/project'],
    ]);
    expect(updateAumxControlFields).toHaveBeenCalledWith(
      '/project/.amux/aumx.config.json',
      { controlPaneId: '%1' },
    );
  });

  it('splits after the last managed pane for subsequent sidebar allocations', async () => {
    const tmux = makeTmux();

    const result = await allocateTmuxPane({
      configPath: '/project/.amux/aumx.config.json',
      controlPaneId: '%1',
      existingPaneIds: ['%2', '%7'],
      isFirstContentPane: false,
      layoutMode: 'sidebar',
      originalPaneId: '%1',
      paneCwd: '/project',
      tmuxService: tmux,
      log: logger,
    });

    expect(ensureMinimumWindowSize).toHaveBeenCalledWith('%7');
    expect(splitPane).toHaveBeenCalledWith({ cwd: '/project', targetPane: '%7' });
    expect(result.paneId).toBe('%3');
  });
});
