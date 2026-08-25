import { describe, expect, it } from 'vitest';
import {
  HEAVY_IGNORED_DIRS,
  isBinaryFileName,
  isSelfOrDescendant,
  isValidEntryName,
  normalizeOperationPaths,
  parentDir,
} from '../../src/shared/filePolicy';

describe('filePolicy', () => {
  it('ignores current and legacy metadata directories from heavy scans', () => {
    const legacyMetadataDirs = [
      `.${['a', 'm', 'u', 'x'].join('')}`,
      `.${['a', 'u', 'm', 'x'].join('')}`,
    ];

    expect(legacyMetadataDirs.every((directory) => HEAVY_IGNORED_DIRS.has(directory))).toBe(true);
    expect(HEAVY_IGNORED_DIRS.has('.muxbase')).toBe(true);
  });

  it('detects binary file names by extension', () => {
    expect(isBinaryFileName('logo.png')).toBe(true);
    expect(isBinaryFileName('archive.tar.gz')).toBe(true);
    expect(isBinaryFileName('module.pyc')).toBe(true);
    expect(isBinaryFileName('app.ts')).toBe(false);
    expect(isBinaryFileName('icon.svg')).toBe(false);
    expect(isBinaryFileName('poetry.lock')).toBe(false);
    expect(isBinaryFileName('README')).toBe(false);
  });

  it('accepts plain entry names', () => {
    expect(isValidEntryName('index.ts')).toBe(true);
    expect(isValidEntryName('my-folder')).toBe(true);
    expect(isValidEntryName('  spaced.txt  ')).toBe(true);
  });

  it('rejects names with path semantics', () => {
    expect(isValidEntryName('')).toBe(false);
    expect(isValidEntryName('   ')).toBe(false);
    expect(isValidEntryName('.')).toBe(false);
    expect(isValidEntryName('..')).toBe(false);
    expect(isValidEntryName('foo/bar')).toBe(false);
    expect(isValidEntryName('..\\escape')).toBe(false);
    expect(isValidEntryName('../sibling')).toBe(false);
    expect(isValidEntryName('with\0null')).toBe(false);
  });

  it('resolves the parent directory of a relative path', () => {
    expect(parentDir('a')).toBe('');
    expect(parentDir('a/b/c')).toBe('a/b');
    expect(parentDir('')).toBe('');
  });

  it('treats a path as its own descendant but never a name-prefix sibling', () => {
    expect(isSelfOrDescendant('src', 'src')).toBe(true);
    expect(isSelfOrDescendant('src', 'src/index.ts')).toBe(true);
    expect(isSelfOrDescendant('src/app', 'src/application')).toBe(false);
    expect(isSelfOrDescendant('src/index.ts', 'src')).toBe(false);
  });

  it('drops nested paths and duplicates from an operation set', () => {
    expect(normalizeOperationPaths(['src', 'src/index.ts'])).toEqual(['src']);
    expect(normalizeOperationPaths(['src/index.ts', 'src'])).toEqual(['src']);
    expect(normalizeOperationPaths(['src', 'src/index.ts', 'src'])).toEqual(['src']);
    expect(normalizeOperationPaths(['a', 'a'])).toEqual(['a']);
    expect(normalizeOperationPaths(['src/app', 'src/application'])).toEqual([
      'src/app',
      'src/application',
    ]);
    expect(normalizeOperationPaths(['src', 'src/a/b', 'lib'])).toEqual(['lib', 'src']);
    expect(normalizeOperationPaths([])).toEqual([]);
  });

  it('drops nested paths past a sibling that sorts between a folder and its children', () => {
    // '-' (0x2D) and '.' (0x2E) sort before '/' (0x2F), so these siblings interleave.
    expect(normalizeOperationPaths(['src-b', 'src', 'src/a'])).toEqual(['src', 'src-b']);
    expect(normalizeOperationPaths(['a', 'a.txt', 'a/b'])).toEqual(['a', 'a.txt']);
    expect(normalizeOperationPaths(['src', 'src.d.ts', 'src/x', 'src/y']))
      .toEqual(['src', 'src.d.ts']);
  });

  it('drops a descendant covered by an ancestor several levels up', () => {
    expect(normalizeOperationPaths(['a/b/c/d', 'a'])).toEqual(['a']);
    expect(normalizeOperationPaths(['a/b', 'a/b/c/d'])).toEqual(['a/b']);
  });
});
