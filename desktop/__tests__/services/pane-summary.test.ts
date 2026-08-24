import { promises as fs } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AumxPane } from 'aumx/core';
import { PaneSummaryService } from '../../src/main/services/PaneSummaryService';
import { PaneSummaryPersistence } from '../../src/main/services/paneSummaryPersistence';

const execAsyncMock = vi.hoisted(() => vi.fn());
const generateRecapMock = vi.hoisted(() => vi.fn());

vi.mock('aumx/core', () => ({
  execAsync: execAsyncMock,
  getProjectMetadataPath: (projectRoot: string, ...segments: string[]) => (
    [projectRoot, '.amux', ...segments].join('/')
  ),
}));
vi.mock('../../src/main/services/recapGenerator.js', () => ({ generateRecap: generateRecapMock }));
vi.mock('../../src/main/services/Logger.js', () => ({
  log: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

function makePane(): AumxPane {
  return {
    agent: 'claude',
    agentStatus: 'idle',
    branchName: 'feature/task',
    id: 'pane-1',
    lastAgentCheck: 123,
    paneId: '%1',
    prompt: 'Implement task',
    slug: 'task',
    title: 'Task',
    worktreePath: '/worktree',
  };
}

function makeBridge(pane = makePane(), sinceWallMs = 456) {
  return {
    getAgentSession: vi.fn(() => ({ messages: [{ content: 'done', type: 'assistant' }] })),
    getPaneActivitySnapshot: () => ({ panes: { [pane.id]: { sinceWallMs } } }),
    getPanes: () => [pane],
  };
}

async function makeRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'aumx-pane-summary-'));
}

describe('PaneSummaryService', () => {
  beforeEach(() => {
    execAsyncMock.mockReset();
    execAsyncMock.mockResolvedValue('');
    generateRecapMock.mockReset();
    generateRecapMock.mockResolvedValue({ summary: 'Implemented the task.' });
  });

  it('uses the fresh cache and refreshes it only when forced', async () => {
    const root = await makeRoot();
    try {
      const service = new PaneSummaryService({ bridge: makeBridge(), emit: vi.fn(), projectRoot: root });

      const first = await service.refreshOne('pane-1', false);
      const cached = await service.refreshOne('pane-1', false);
      const forced = await service.refreshOne('pane-1', true);

      expect(first?.status).toBe('fresh');
      expect(cached).toBe(first);
      expect(forced?.generatedAt).toBeGreaterThanOrEqual(first?.generatedAt ?? 0);
      expect(execAsyncMock).toHaveBeenCalledTimes(6);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('uses runtime activity as the authoritative pane start time', async () => {
    const root = await makeRoot();
    try {
      const service = new PaneSummaryService({ bridge: makeBridge(makePane(), 789), emit: vi.fn(), projectRoot: root });

      const summary = await service.refreshOne('pane-1', true);

      expect(summary?.startedAt).toBe(789);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does not duplicate recap generation while one request is in flight', async () => {
    const root = await makeRoot();
    try {
      let resolveRecap!: (value: { summary: string }) => void;
      generateRecapMock.mockReturnValue(new Promise((resolve) => { resolveRecap = resolve; }));
      const service = new PaneSummaryService({ bridge: makeBridge(), emit: vi.fn(), projectRoot: root });
      await service.refreshOne('pane-1', true);

      const first = service.generateRecapOne('pane-1', true);
      await vi.waitFor(() => expect(generateRecapMock).toHaveBeenCalledTimes(1));
      const second = await service.generateRecapOne('pane-1', true);
      resolveRecap({ summary: 'Implemented the task.' });

      expect((await first)?.recapStatus).toBe('ready');
      expect(second?.recapStatus).toBe('generating');
      expect(generateRecapMock).toHaveBeenCalledTimes(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('skips malformed persisted summaries and removes a pane summary safely', async () => {
    const root = await makeRoot();
    try {
      const persistence = new PaneSummaryPersistence(root);
      const directory = join(root, '.amux', 'pane-summaries');
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, 'broken.json'), '{not-json');
      await persistence.save({
        agent: 'claude',
        branch: 'main',
        generatedAt: 1,
        gitActivity: null,
        paneId: 'pane-1',
        paneName: 'Task',
        recap: '',
        recapStatus: 'idle',
        startedAt: 1,
        status: 'fresh',
        worktreePath: null,
      });

      const loaded = await persistence.load();
      await persistence.remove('pane-1');
      const remaining = await fs.readdir(directory);

      expect(loaded).toHaveLength(1);
      expect(loaded[0]?.paneId).toBe('pane-1');
      expect(remaining).toEqual(['broken.json']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('hydrates persisted summaries into the cache and avoids an unnecessary refresh', async () => {
    const root = await makeRoot();
    try {
      const persistence = new PaneSummaryPersistence(root);
      await persistence.save({
        agent: 'claude',
        branch: 'main',
        generatedAt: Date.now(),
        gitActivity: null,
        paneId: 'pane-1',
        paneName: 'Persisted',
        recap: 'already summarized',
        recapGeneratedAt: Date.now(),
        recapStatus: 'ready',
        startedAt: 1,
        status: 'fresh',
        worktreePath: null,
      });
      const service = new PaneSummaryService({
        bridge: makeBridge(),
        emit: vi.fn(),
        projectRoot: root,
      });
      await expect(service.loadAll()).resolves.toHaveLength(1);
      await expect(service.refreshOne('pane-1', false)).resolves.toMatchObject({
        recap: 'already summarized',
      });
      expect(execAsyncMock).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('returns an error summary after persistence failure and clears the refresh lock', async () => {
    const root = await makeRoot();
    const save = vi.spyOn(PaneSummaryPersistence.prototype, 'save').mockRejectedValueOnce(new Error('disk full'));
    try {
      const service = new PaneSummaryService({
        bridge: makeBridge(),
        emit: vi.fn(),
        projectRoot: root,
      });
      await expect(service.refreshOne('pane-1', true)).resolves.toMatchObject({
        status: 'error',
        errorMessage: 'Error: disk full',
      });
      save.mockResolvedValue(undefined);
      await expect(service.refreshOne('pane-1', true)).resolves.toMatchObject({
        status: 'fresh',
      });
    } finally {
      save.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('filters missing panes from batch refreshes and uses fresh recap cache entries', async () => {
    const root = await makeRoot();
    try {
      const service = new PaneSummaryService({
        bridge: makeBridge(),
        emit: vi.fn(),
        projectRoot: root,
      });
      await expect(service.refreshMany(['pane-1', 'missing'], true)).resolves.toHaveLength(1);
      await service.generateRecapOne('pane-1', true);
      generateRecapMock.mockClear();
      await expect(service.generateRecapOne('pane-1', false)).resolves.toMatchObject({ recapStatus: 'ready' });
      expect(generateRecapMock).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('falls back safely when the activity snapshot is unavailable', async () => {
    const root = await makeRoot();
    try {
      const bridge = makeBridge();
      bridge.getPaneActivitySnapshot = () => {
        throw new Error('activity offline');
      };
      const service = new PaneSummaryService({
        bridge,
        emit: vi.fn(),
        projectRoot: root,
      });
      await expect(service.refreshOne('pane-1', true)).resolves.toMatchObject({
        paneId: 'pane-1',
        status: 'fresh',
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('retains the newest recap fields when refresh and recap overlap', async () => {
    const root = await makeRoot();
    try {
      const service = new PaneSummaryService({
        bridge: makeBridge(),
        emit: vi.fn(),
        projectRoot: root,
      });
      await service.refreshOne('pane-1', true);
      let releaseRecap!: (value: { summary: string }) => void;
      generateRecapMock.mockReturnValueOnce(
        new Promise((resolve) => {
          releaseRecap = resolve;
        }),
      );
      const recap = service.generateRecapOne('pane-1', true);
      await vi.waitFor(() => expect(generateRecapMock).toHaveBeenCalledOnce());
      const gitResolvers: Array<(value: string) => void> = [];
      execAsyncMock.mockImplementation(
        () =>
          new Promise((resolve) => {
            gitResolvers.push(resolve);
          }),
      );
      const refresh = service.refreshOne('pane-1', true);
      releaseRecap({ summary: 'newest recap' });
      await expect(recap).resolves.toMatchObject({
        recap: 'newest recap',
        recapStatus: 'ready',
      });
      await vi.waitFor(() => expect(gitResolvers).toHaveLength(3));
      for (const resolve of gitResolvers) resolve('');
      await refresh;
      await expect(service.refreshOne('pane-1', false)).resolves.toMatchObject({
        recap: 'newest recap',
        recapStatus: 'ready',
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
