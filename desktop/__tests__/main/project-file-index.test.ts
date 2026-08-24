import { chmod, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildFileIndex } from '../../src/main/services/project-search/ProjectFileIndex';

const originalPath = process.env.PATH;

afterEach(() => {
  process.env.PATH = originalPath;
});

describe('buildFileIndex', () => {
  it('bounds git discovery and falls back to the filesystem walk', async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), 'aumx-file-index-'));
    const projectRoot = join(temporaryRoot, 'project');
    const binRoot = join(temporaryRoot, 'bin');

    try {
      await mkdir(projectRoot);
      await mkdir(binRoot);
      await writeFile(join(projectRoot, 'fallback-result.ts'), 'export {};\n');
      const fakeGit = join(binRoot, 'git');
      await writeFile(fakeGit, '#!/bin/sh\nexec /bin/sleep 1\n');
      await chmod(fakeGit, 0o755);
      process.env.PATH = binRoot;

      const startedAt = performance.now();
      const cache = await buildFileIndex(projectRoot, { gitTimeoutMs: 25 });

      expect(performance.now() - startedAt).toBeLessThan(500);
      expect(cache.entries.map((entry) => entry.path)).toEqual(['fallback-result.ts']);
    } finally {
      await rm(temporaryRoot, { force: true, recursive: true });
    }
  });

  it('rejects rather than caching an incomplete file-limited fallback walk', async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), 'aumx-file-index-'));
    const projectRoot = join(temporaryRoot, 'project');
    const binRoot = join(temporaryRoot, 'bin');

    try {
      await mkdir(projectRoot);
      await mkdir(binRoot);
      await Promise.all([
        writeFile(join(projectRoot, 'alpha.ts'), 'export {};\n'),
        writeFile(join(projectRoot, 'bravo.ts'), 'export {};\n'),
        writeFile(join(projectRoot, 'charlie.ts'), 'export {};\n'),
      ]);
      const fakeGit = join(binRoot, 'git');
      await writeFile(fakeGit, '#!/bin/sh\nexit 1\n');
      await chmod(fakeGit, 0o755);
      process.env.PATH = binRoot;

      await expect(buildFileIndex(projectRoot, {
        gitTimeoutMs: 25,
        maxFallbackFiles: 2,
      })).rejects.toThrow('file limit');
    } finally {
      await rm(temporaryRoot, { force: true, recursive: true });
    }
  });

  it('rejects rather than caching an incomplete time-limited fallback walk', async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), 'aumx-file-index-'));
    const projectRoot = join(temporaryRoot, 'project');
    const binRoot = join(temporaryRoot, 'bin');

    try {
      await mkdir(projectRoot);
      await mkdir(binRoot);
      await writeFile(join(projectRoot, 'too-late.ts'), 'export {};\n');
      const fakeGit = join(binRoot, 'git');
      await writeFile(fakeGit, '#!/bin/sh\nexit 1\n');
      await chmod(fakeGit, 0o755);
      process.env.PATH = binRoot;

      await expect(buildFileIndex(projectRoot, {
        fallbackTimeoutMs: 0,
        gitTimeoutMs: 25,
      })).rejects.toThrow('time limit');
    } finally {
      await rm(temporaryRoot, { force: true, recursive: true });
    }
  });
});
