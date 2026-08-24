import type { AumxPane } from 'aumx/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  __test__,
  ProjectSearchService,
} from '../../src/main/services/ProjectSearchService';

function makePane(overrides: Partial<AumxPane> = {}): AumxPane {
  return {
    id: 'pane-1',
    paneId: '%1',
    prompt: 'search scope',
    slug: 'pane-1',
    ...overrides,
  };
}

describe('ProjectSearchService helpers', () => {
  it('parses null-delimited git file output', () => {
    expect(__test__.parseGitFileListOutput('src/app.ts\0README.md\0\0')).toEqual([
      'src/app.ts',
      'README.md',
    ]);
  });

  it('parses git grep -z output (path NUL line NUL content) and keeps colons in filenames and content', () => {
    const stdout = 'src/app.ts\x0042\x00const value = 1\nweird:name.ts\x007\x00const ratio = a:b\n';
    const results = __test__.parseGitGrepOutput('/repo', 'value', stdout);

    expect(results).toEqual([
      expect.objectContaining({ path: 'src/app.ts', lineNumber: 42, lineContent: 'const value = 1' }),
      expect.objectContaining({ path: 'weird:name.ts', lineNumber: 7, lineContent: 'const ratio = a:b' }),
    ]);
  });

  it('tolerates a truncated final record from a killed streaming search', () => {
    const stdout = 'src/app.ts\x0042\x00const value = 1\nsrc/par';
    const results = __test__.parseGitGrepOutput('/repo', 'value', stdout);

    expect(results).toEqual([
      expect.objectContaining({ path: 'src/app.ts', lineNumber: 42, lineContent: 'const value = 1' }),
    ]);
  });

  it('resolves only allowed pane or project roots', () => {
    const panes = [
      makePane({ projectRoot: '/repo', worktreePath: '/repo/.aumx/worktrees/pane-1' }),
      makePane({ id: 'pane-2', paneId: '%2', projectRoot: '/repo', slug: 'pane-2', worktreePath: '/repo/.aumx/worktrees/pane-2' }),
    ];

    expect(__test__.resolveProjectSearchRoot('/repo', panes, '/repo/.aumx/worktrees/pane-2')).toBe('/repo/.aumx/worktrees/pane-2');
    expect(__test__.resolveProjectSearchRoot('/repo', panes, '/tmp/not-allowed')).toBe('/repo');
  });

  it('prefers exact filename matches over broader path matches', () => {
    const cache = __test__.createFileSearchIndex([
      'src/features/app-shell.ts',
      'src/app.ts',
      'src/platform/application-state.ts',
    ]);

    const results = __test__.searchFileIndex(cache, '/repo/.aumx/worktrees/pane-1', 'app');

    expect(results[0]).toEqual({
      rootPath: '/repo/.aumx/worktrees/pane-1',
      path: 'src/app.ts',
      filename: 'app.ts',
    });
  });

  it('supports multi-token path queries within the scoped root', () => {
    const cache = __test__.createFileSearchIndex([
      'docs/renderer-overview.md',
      'src/renderer/components/file-browser/FileViewer.tsx',
      'src/shared/ipc-types.ts',
    ]);

    const results = __test__.searchFileIndex(cache, '/repo/.aumx/worktrees/pane-7', 'renderer file viewer');

    expect(results[0]).toEqual({
      rootPath: '/repo/.aumx/worktrees/pane-7',
      path: 'src/renderer/components/file-browser/FileViewer.tsx',
      filename: 'FileViewer.tsx',
    });
  });

  it('supports camel-case acronym file queries', () => {
    const cache = __test__.createFileSearchIndex([
      'src/renderer/components/command-palette/CommandPalette.tsx',
      'src/renderer/components/file-browser/FileViewer.tsx',
      'src/renderer/components/file-browser/FileTree.tsx',
    ]);

    const results = __test__.searchFileIndex(cache, '/repo', 'fv');

    expect(results[0]).toEqual({
      rootPath: '/repo',
      path: 'src/renderer/components/file-browser/FileViewer.tsx',
      filename: 'FileViewer.tsx',
    });
  });
});

type TestFileIndex = ReturnType<typeof __test__.createFileSearchIndex>;

function getFileIndex(
  service: ProjectSearchService,
  rootPath: string,
  forceRefresh = false,
): Promise<TestFileIndex> {
  const access = service as unknown as {
    getFileIndex(root: string, force?: boolean): Promise<TestFileIndex>;
  };
  return access.getFileIndex(rootPath, forceRefresh);
}

function getRetainedRoots(service: ProjectSearchService): string[] {
  const indexes = Reflect.get(service, 'fileIndexes') as Map<string, {
    cache?: TestFileIndex;
    pending?: Promise<TestFileIndex>;
  }>;
  return [...indexes]
    .filter(([, state]) => state.cache && !state.pending)
    .map(([rootPath]) => rootPath);
}

function createCache(rootPath: string): TestFileIndex {
  return __test__.createFileSearchIndex([`${rootPath.slice(1)}-searchable.ts`]);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ProjectSearchService file-index retention', () => {
  it('expires settled roots opportunistically and rebuilds on next use', async () => {
    let now = 10_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const build = vi.fn(async (rootPath: string) => createCache(rootPath));
    const service = new ProjectSearchService(build);

    const original = await getFileIndex(service, '/root-one');
    now += __test__.FILE_INDEX_TTL_MS + 1;
    await getFileIndex(service, '/root-two');

    expect(getRetainedRoots(service)).toEqual(['/root-two']);

    const rebuilt = await getFileIndex(service, '/root-one');
    expect(rebuilt).not.toBe(original);
    expect(build).toHaveBeenCalledTimes(3);
  });

  it('moves a fresh hit to the newest LRU position', async () => {
    const build = vi.fn(async (rootPath: string) => createCache(rootPath));
    const service = new ProjectSearchService(build);
    for (let index = 1; index <= 4; index++) {
      await getFileIndex(service, `/root-${index}`);
    }

    await getFileIndex(service, '/root-1');
    await getFileIndex(service, '/root-5');

    expect(getRetainedRoots(service)).toEqual([
      '/root-3',
      '/root-4',
      '/root-1',
      '/root-5',
    ]);
  });

  it('moves a rebuilt root to the newest LRU position', async () => {
    const build = vi.fn(async (rootPath: string) => createCache(rootPath));
    const service = new ProjectSearchService(build);
    for (let index = 1; index <= 4; index++) {
      await getFileIndex(service, `/root-${index}`);
    }

    await getFileIndex(service, '/root-1', true);
    await getFileIndex(service, '/root-5');

    expect(getRetainedRoots(service)).toEqual([
      '/root-3',
      '/root-4',
      '/root-1',
      '/root-5',
    ]);
  });

  it('keeps at most four roots when concurrent builds settle', async () => {
    const releases = new Map<string, (cache: TestFileIndex) => void>();
    const build = vi.fn((rootPath: string) => new Promise<TestFileIndex>((resolve) => {
      releases.set(rootPath, resolve);
    }));
    const service = new ProjectSearchService(build);
    const pending = Array.from({ length: 6 }, (_, index) =>
      getFileIndex(service, `/root-${index + 1}`));

    expect(getRetainedRoots(service)).toEqual([]);

    for (let index = 1; index <= 6; index++) {
      releases.get(`/root-${index}`)?.(createCache(`/root-${index}`));
      await Promise.resolve();
    }
    await Promise.all(pending);

    expect(getRetainedRoots(service)).toEqual([
      '/root-3',
      '/root-4',
      '/root-5',
      '/root-6',
    ]);
  });

  it('deduplicates and protects an in-flight build', async () => {
    let release: (cache: TestFileIndex) => void = () => {};
    const build = vi.fn((_rootPath: string) => new Promise<TestFileIndex>((resolve) => {
      release = resolve;
    }));
    const service = new ProjectSearchService(build);

    const first = getFileIndex(service, '/pending');
    const second = getFileIndex(service, '/pending');

    expect(build).toHaveBeenCalledTimes(1);
    release(createCache('/pending'));
    const [firstCache, secondCache] = await Promise.all([first, second]);

    expect(firstCache).toBe(secondCache);
  });

  it('keeps a settled cache when a forced refresh fails', async () => {
    const cached = createCache('/stable');
    const build = vi.fn()
      .mockResolvedValueOnce(cached)
      .mockRejectedValueOnce(new Error('refresh failed'));
    const service = new ProjectSearchService(build);
    await getFileIndex(service, '/stable');

    await expect(getFileIndex(service, '/stable', true)).resolves.toBe(cached);
    expect(getRetainedRoots(service)).toEqual(['/stable']);
  });

  it('keeps an expired cache when its natural refresh fails', async () => {
    let now = 10_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const cached = createCache('/stable');
    const build = vi.fn()
      .mockResolvedValueOnce(cached)
      .mockRejectedValueOnce(new Error('refresh failed'));
    const service = new ProjectSearchService(build);
    await getFileIndex(service, '/stable');
    now += __test__.FILE_INDEX_TTL_MS + 1;

    await expect(getFileIndex(service, '/stable')).resolves.toBe(cached);
    expect(getRetainedRoots(service)).toEqual(['/stable']);
  });

  it('does not let an invalidated pending build reinsert itself', async () => {
    let release: (cache: TestFileIndex) => void = () => {};
    const build = vi.fn(() => new Promise<TestFileIndex>((resolve) => {
      release = resolve;
    }));
    const service = new ProjectSearchService(build);
    const pending = getFileIndex(service, '/invalidated');

    service.invalidate('/invalidated');
    release(createCache('/invalidated'));
    await pending;

    expect(getRetainedRoots(service)).toEqual([]);
  });

  it('rebuilds a settled root after explicit invalidation', async () => {
    const build = vi.fn(async (rootPath: string) => createCache(rootPath));
    const service = new ProjectSearchService(build);
    const original = await getFileIndex(service, '/invalidated');

    service.invalidate('/invalidated');
    const rebuilt = await getFileIndex(service, '/invalidated');

    expect(rebuilt).not.toBe(original);
    expect(build).toHaveBeenCalledTimes(2);
    expect(getRetainedRoots(service)).toEqual(['/invalidated']);
  });

  it('returns identical results after LRU eviction and rebuild', async () => {
    const build = vi.fn(async (_rootPath: string) =>
      __test__.createFileSearchIndex(['src/SearchablePanel.tsx']));
    const service = new ProjectSearchService(build);
    const before = await service.searchFiles('/root-1', 'searchable');
    for (let index = 2; index <= 6; index++) {
      await service.searchFiles(`/root-${index}`, 'searchable');
    }

    const after = await service.searchFiles('/root-1', 'searchable');

    expect(after).toEqual(before);
    expect(build.mock.calls.filter(([rootPath]) => rootPath === '/root-1')).toHaveLength(2);
  });
});
