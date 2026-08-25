import { describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FileChangedEvent } from '../../src/shared/ipc-types';
import { __test__, FileBrowserWatchService } from '../../src/main/services/FileBrowserWatchService';

async function waitForEvent(
  events: FileChangedEvent[],
  changeType: FileChangedEvent['changeType'],
  timeoutMs = 5_000,
): Promise<FileChangedEvent> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const event = events.find((candidate) => candidate.changeType === changeType);
    if (event) return event;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${changeType} event`);
}

describe('FileBrowserWatchService watcher close', () => {
  it('does not block shutdown on a stuck watcher close promise', async () => {
    let closeCalled = false;
    const stuckWatcher = {
      close: () => {
        closeCalled = true;
        return new Promise<void>(() => {});
      },
    };

    await expect(__test__.closeWatcher(stuckWatcher, 1)).resolves.toBeUndefined();
    expect(closeCalled).toBe(true);
  });
});

describe('FileBrowserWatchService helpers', () => {
  it('creates a root-scoped event payload for files inside the watched root', () => {
    expect(__test__.createFileChangedEvent('/repo', '/repo/src/app.ts', 'change')).toEqual({
      changeType: 'change',
      relativePath: 'src/app.ts',
      rootPath: '/repo',
    });
  });

  it('maps a root-level change to an empty relative path', () => {
    expect(__test__.createFileChangedEvent('/repo', '/repo', 'addDir')).toEqual({
      changeType: 'addDir',
      relativePath: '',
      rootPath: '/repo',
    });
  });

  it('preserves the renderer root identity while watching its canonical path', () => {
    expect(__test__.createFileChangedEvent(
      '/private/var/project',
      '/private/var/project/README.md',
      'change',
      '/var/project',
    )).toEqual({
      changeType: 'change',
      relativePath: 'README.md',
      rootPath: '/var/project',
    });
  });

  it('ignores changes outside the watched root', () => {
    expect(__test__.createFileChangedEvent('/repo', '/tmp/other.ts', 'change')).toBeNull();
  });
});

describe('FileBrowserWatchService ignored predicate', () => {
  const isIgnored = __test__.createIgnoredPredicate('/repo');

  it('ignores heavy directories at any depth', () => {
    expect(isIgnored('/repo/node_modules/react/index.js')).toBe(true);
    expect(isIgnored('/repo/packages/app/node_modules/dep/x.js')).toBe(true);
    expect(isIgnored('/repo/dist/bundle.js')).toBe(true);
    expect(isIgnored('/repo/.muxbase/worktrees/pane-1/file.ts')).toBe(true);
  });

  it('does not ignore regular source files or the root itself', () => {
    expect(isIgnored('/repo')).toBe(false);
    expect(isIgnored('/repo/src/app.ts')).toBe(false);
    expect(isIgnored('/repo/src/node_modules.ts')).toBe(false);
  });

  it('does not ignore paths outside the watched root', () => {
    expect(isIgnored('/other/node_modules/react/index.js')).toBe(false);
  });
});

describe('FileBrowserWatchService watch scope', () => {
  it('watches only the root and requested visible directories', () => {
    const dirPaths = __test__.normalizeWatchDirPaths('/repo', [
      '',
      '../outside',
      'node_modules',
      'packages/app',
      'src',
      'src',
    ]);

    expect(dirPaths).toEqual(['', 'packages/app', 'src']);
    expect(__test__.createWatchTargets('/repo', dirPaths)).toEqual([
      '/repo',
      '/repo/packages/app',
      '/repo/src',
    ]);
  });

  it('uses a non-recursive watcher for bounded file-browser updates', () => {
    const options = __test__.createWatchOptions('/repo');

    expect(options.depth).toBe(0);
    expect(options.ignoreInitial).toBe(true);
  });
});

describe('FileBrowserWatchService real filesystem events', () => {
  it('continues watching a root file after it is deleted and recreated', async () => {
    const rootPath = await mkdtemp(join(tmpdir(), 'muxbase-file-watch-'));
    const filePath = join(rootPath, 'README.md');
    const eventRootPath = '/logical/project';
    const events: FileChangedEvent[] = [];
    const service = new FileBrowserWatchService({
      webContents: {
        send: (_channel: string, event: FileChangedEvent) => events.push(event),
      },
    } as never);

    try {
      await writeFile(filePath, 'original');
      await service.watchRoot(rootPath, [], eventRootPath);
      await new Promise((resolve) => setTimeout(resolve, 250));

      await rm(filePath);
      await expect(waitForEvent(events, 'unlink')).resolves.toMatchObject({
        relativePath: 'README.md',
        rootPath: eventRootPath,
      });

      await writeFile(filePath, 'recreated');
      await expect(waitForEvent(events, 'add')).resolves.toMatchObject({
        relativePath: 'README.md',
        rootPath: eventRootPath,
      });
    } finally {
      await service.stop();
      await rm(rootPath, { force: true, recursive: true });
    }
  });
});
