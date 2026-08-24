// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useFileTreeSelection } from '../src/renderer/components/file-browser/file-tree/useFileTreeSelection';
import type { FileTreeRowData } from '../src/renderer/components/file-browser/file-tree/fileTreeModel';

function row(path: string, isDirectory = false): FileTreeRowData {
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

const ROWS = ['a.ts', 'b.ts', 'c.ts', 'd.ts'].map((path) => row(path));

const PLAIN = { extend: false, toggle: false };
const EXTEND = { extend: true, toggle: false };
const TOGGLE = { extend: false, toggle: true };

function renderSelection(rows: FileTreeRowData[] = ROWS) {
  return renderHook(
    ({ navigableRows }) => useFileTreeSelection(navigableRows, '/repo'),
    { initialProps: { navigableRows: rows } },
  );
}

/** Mirrors FileTree.handleRowSelect, where the focus ring and the selection are updated together. */
function renderTreeSelection(rows: FileTreeRowData[] = ROWS) {
  return renderHook(
    ({ navigableRows, rootPath }) => {
      const selection = useFileTreeSelection(navigableRows, rootPath);
      return { select: selection.selectRow, selection };
    },
    { initialProps: { navigableRows: rows, rootPath: '/repo' } },
  );
}

describe('useFileTreeSelection', () => {
  it('replaces the selection on a plain click', () => {
    const { result } = renderSelection();

    act(() => result.current.selectRow('a.ts', PLAIN));
    act(() => result.current.selectRow('c.ts', PLAIN));

    expect([...result.current.selectedPaths]).toEqual(['c.ts']);
  });

  it('takes the whole range between the anchor and a shift click', () => {
    const { result } = renderSelection();

    act(() => result.current.selectRow('b.ts', PLAIN));
    act(() => result.current.selectRow('d.ts', EXTEND));

    expect(result.current.pathsFor('c.ts')).toEqual(['b.ts', 'c.ts', 'd.ts']);
  });

  it('extends upwards from the anchor just as well as downwards', () => {
    const { result } = renderSelection();

    act(() => result.current.selectRow('c.ts', PLAIN));
    act(() => result.current.selectRow('a.ts', EXTEND));

    expect(result.current.pathsFor('a.ts')).toEqual(['a.ts', 'b.ts', 'c.ts']);
  });

  it('re-anchors so a second shift click reshapes the range instead of growing it', () => {
    const { result } = renderSelection();

    act(() => result.current.selectRow('a.ts', PLAIN));
    act(() => result.current.selectRow('d.ts', EXTEND));
    act(() => result.current.selectRow('b.ts', EXTEND));

    expect(result.current.pathsFor('a.ts')).toEqual(['a.ts', 'b.ts']);
  });

  it('adds and removes a single row on a toggle click', () => {
    const { result } = renderSelection();

    act(() => result.current.selectRow('a.ts', PLAIN));
    act(() => result.current.selectRow('c.ts', TOGGLE));
    expect(result.current.pathsFor('a.ts')).toEqual(['a.ts', 'c.ts']);

    act(() => result.current.selectRow('a.ts', TOGGLE));
    expect([...result.current.selectedPaths]).toEqual(['c.ts']);
  });

  it('acts on the clicked row alone when it sits outside the selection', () => {
    const { result } = renderSelection();

    act(() => result.current.selectRow('a.ts', PLAIN));
    act(() => result.current.selectRow('b.ts', TOGGLE));

    expect(result.current.pathsFor('d.ts')).toEqual(['d.ts']);
  });

  it('returns selected paths in tree order, not click order', () => {
    const { result } = renderSelection();

    act(() => result.current.selectRow('d.ts', PLAIN));
    act(() => result.current.selectRow('a.ts', TOGGLE));

    expect(result.current.pathsFor('a.ts')).toEqual(['a.ts', 'd.ts']);
  });

  it('removes only the toggled row when it is not the focused one', () => {
    // Arrange — the focus ring lands on c.ts, then a.ts is toggled off from a three-row selection.
    const { result } = renderTreeSelection();
    act(() => result.current.select('a.ts', PLAIN));
    act(() => result.current.select('c.ts', EXTEND));

    // Act
    act(() => result.current.select('a.ts', TOGGLE));

    // Assert
    expect(result.current.selection.pathsFor('b.ts')).toEqual(['b.ts', 'c.ts']);
  });

  it('keeps the rest of the selection when the focused row is toggled off', () => {
    // Arrange
    const { result } = renderTreeSelection();
    act(() => result.current.select('a.ts', PLAIN));
    act(() => result.current.select('c.ts', TOGGLE));

    // Act
    act(() => result.current.select('c.ts', TOGGLE));

    // Assert
    expect([...result.current.selection.selectedPaths]).toEqual(['a.ts']);
  });

  it('abandons the selection when the tree switches to another root', () => {
    // Arrange — paths are root-relative, so the same names mean different files elsewhere.
    const { rerender, result } = renderTreeSelection();
    act(() => result.current.select('a.ts', PLAIN));
    act(() => result.current.select('c.ts', EXTEND));

    // Act
    rerender({ navigableRows: ROWS, rootPath: '/other-worktree' });

    // Assert
    expect(result.current.selection.pathsFor('a.ts')).toEqual(['a.ts']);
  });

  it('does not re-select an arbitrary row after a batch takes the whole selection', () => {
    // Arrange
    const { rerender, result } = renderSelection();
    act(() => result.current.selectRow('a.ts', PLAIN));
    act(() => result.current.selectRow('b.ts', EXTEND));

    // Act — a.ts and b.ts are gone; only rows the user never picked survive.
    rerender({ navigableRows: [row('c.ts'), row('d.ts')] });

    // Assert — nothing is selected, so no batch verb sweeps up a survivor silently.
    expect([...result.current.selectedPaths]).toEqual([]);
  });

  it('drops selected paths that no longer exist after a reload', () => {
    const { rerender, result } = renderSelection();

    act(() => result.current.selectRow('a.ts', PLAIN));
    act(() => result.current.selectRow('d.ts', EXTEND));
    rerender({ navigableRows: [row('a.ts'), row('b.ts')] });

    expect([...result.current.selectedPaths]).toEqual(['a.ts', 'b.ts']);
  });
});
