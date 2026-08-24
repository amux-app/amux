import { describe, expect, it } from 'vitest';
import type { FileEntry } from '../src/shared/ipc-types';
import {
  buildVisibleFileTreeRows,
  PLACEHOLDER_ID,
} from '../src/renderer/components/file-browser/file-tree/fileTreeModel';

const ROOT = '/repo';

function entry(name: string, path: string, isDirectory: boolean): FileEntry {
  return { name, path, isDirectory };
}

describe('buildVisibleFileTreeRows', () => {
  it('returns only expanded descendants with stable depth metadata', () => {
    const trees: Record<string, FileEntry[]> = {
      [ROOT]: [entry('src', 'src', true), entry('readme.md', 'readme.md', false)],
      [`${ROOT}::src`]: [entry('app.ts', 'src/app.ts', false)],
    };

    const rows = buildVisibleFileTreeRows(ROOT, trees, new Set(['src']), null);

    expect(rows.map((row) => [row.id, row.depth, row.isOpen])).toEqual([
      ['src', 0, true],
      ['src/app.ts', 1, false],
      ['readme.md', 0, false],
    ]);
  });

  it('keeps collapsed descendants out of the render list', () => {
    const trees: Record<string, FileEntry[]> = {
      [ROOT]: [entry('src', 'src', true), entry('readme.md', 'readme.md', false)],
      [`${ROOT}::src`]: [entry('app.ts', 'src/app.ts', false)],
    };

    const rows = buildVisibleFileTreeRows(ROOT, trees, undefined, null);

    expect(rows.map((row) => row.id)).toEqual(['src', 'readme.md']);
  });

  it('places creation placeholders at the target directory depth', () => {
    const trees: Record<string, FileEntry[]> = {
      [ROOT]: [entry('src', 'src', true)],
      [`${ROOT}::src`]: [entry('app.ts', 'src/app.ts', false)],
    };

    const rows = buildVisibleFileTreeRows(ROOT, trees, new Set(['src']), { dir: 'src', type: 'file' });

    expect(rows[1]).toMatchObject({
      depth: 1,
      id: `${PLACEHOLDER_ID}:src:file`,
      isPlaceholder: true,
      placeholderDir: 'src',
      placeholderKind: 'file',
    });
    expect(rows[2].id).toBe('src/app.ts');
  });
});
