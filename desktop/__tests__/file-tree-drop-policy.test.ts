import { describe, expect, it } from 'vitest';
import {
  decideDrop,
  resolveDropDir,
  type DragPayload,
} from '../src/renderer/components/file-browser/file-tree/fileTreeDropPolicy';
import type { FileTreeRowData } from '../src/renderer/components/file-browser/file-tree/fileTreeModel';

const ROOT = '/repo';

function row(path: string, isDirectory: boolean): FileTreeRowData {
  return {
    depth: 0,
    icon: { id: 'fi-file' },
    id: path,
    isDirectory,
    isOpen: false,
    isPlaceholder: false,
    name: path.split('/').pop() ?? path,
    path,
  };
}

function payload(paths: string[], rootPath = ROOT): DragPayload {
  return { paths, rootPath };
}

describe('resolveDropDir', () => {
  it('lands a drop on a directory inside that directory', () => {
    expect(resolveDropDir(row('src/lib', true))).toBe('src/lib');
  });

  it('lands a drop on a file in the shared parent directory', () => {
    expect(resolveDropDir(row('src/index.ts', false))).toBe('src');
    expect(resolveDropDir(row('README.md', false))).toBe('');
  });

  it('lands a drop outside any row at the root', () => {
    expect(resolveDropDir(null)).toBe('');
  });
});

describe('decideDrop', () => {
  it('rejects an empty payload', () => {
    expect(decideDrop(payload([]), 'src', ROOT, 'move')).toEqual({
      allowed: false,
      reason: 'empty',
    });
  });

  it('rejects a payload from another root', () => {
    expect(decideDrop(payload(['a.ts'], '/other'), 'src', ROOT, 'move')).toEqual({
      allowed: false,
      reason: 'cross-root',
    });
  });

  it('rejects a folder dropped onto itself', () => {
    expect(decideDrop(payload(['src']), 'src', ROOT, 'move')).toEqual({
      allowed: false,
      reason: 'into-self',
    });
  });

  it('rejects a folder dropped into its own descendant', () => {
    expect(decideDrop(payload(['src']), 'src/lib', ROOT, 'move')).toEqual({
      allowed: false,
      reason: 'into-descendant',
    });
  });

  it('rejects a move whose sources already live in the destination', () => {
    expect(decideDrop(payload(['src/a.ts', 'src/b.ts']), 'src', ROOT, 'move')).toEqual({
      allowed: false,
      reason: 'same-parent',
    });
  });

  it('allows a copy onto the same parent because it duplicates', () => {
    expect(decideDrop(payload(['src/a.ts']), 'src', ROOT, 'copy')).toEqual({
      allowed: true,
      mode: 'copy',
    });
  });

  it('allows a batch where only one source already shares the destination parent', () => {
    expect(decideDrop(payload(['src/a.ts', 'lib/b.ts']), 'src', ROOT, 'move')).toEqual({
      allowed: true,
      mode: 'move',
    });
  });

  it('does not treat a name-prefix sibling as a descendant', () => {
    expect(decideDrop(payload(['src/app']), 'src/application', ROOT, 'move')).toEqual({
      allowed: true,
      mode: 'move',
    });
  });
});
