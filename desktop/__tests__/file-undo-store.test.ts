import { beforeEach, describe, expect, it } from 'vitest';
import { groupUndoMoves, useFileUndoStore } from '../src/renderer/stores/file-undo.store';

const ROOT = '/repo';

describe('file move undo stack', () => {
  beforeEach(() => {
    useFileUndoStore.setState({ stacks: {} });
  });

  it('pops the most recent entry for a root and leaves other roots alone', () => {
    // Arrange
    const store = useFileUndoStore.getState();
    store.pushMove({ moves: [{ from: 'a.ts', to: 'dest/a.ts' }], rootPath: ROOT });
    store.pushMove({ moves: [{ from: 'b.ts', to: 'dest/b.ts' }], rootPath: ROOT });
    store.pushMove({ moves: [{ from: 'c.ts', to: 'dest/c.ts' }], rootPath: '/other' });

    // Act
    const popped = useFileUndoStore.getState().popMove(ROOT);

    // Assert
    expect(popped?.moves).toEqual([{ from: 'b.ts', to: 'dest/b.ts' }]);
    expect(useFileUndoStore.getState().stacks[ROOT]).toHaveLength(1);
    expect(useFileUndoStore.getState().stacks['/other']).toHaveLength(1);
  });

  it('returns null once a root has nothing left to undo', () => {
    expect(useFileUndoStore.getState().popMove(ROOT)).toBeNull();
  });

  it('ignores an entry that moved nothing', () => {
    useFileUndoStore.getState().pushMove({ moves: [], rootPath: ROOT });

    expect(useFileUndoStore.getState().stacks[ROOT]).toBeUndefined();
  });

  it('bounds the stack so a long session cannot grow it without limit', () => {
    for (let index = 0; index < 40; index += 1) {
      useFileUndoStore.getState().pushMove({
        moves: [{ from: `a${index}.ts`, to: `dest/a${index}.ts` }],
        rootPath: ROOT,
      });
    }

    const stack = useFileUndoStore.getState().stacks[ROOT];
    expect(stack).toHaveLength(25);
    expect(stack.at(-1)?.moves[0].from).toBe('a39.ts');
  });
});

describe('groupUndoMoves', () => {
  it('sends each entry back to the parent it came from', () => {
    expect(groupUndoMoves([
      { from: 'src/a.ts', to: 'dest/a.ts' },
      { from: 'lib/b.ts', to: 'dest/b.ts' },
      { from: 'src/c.ts', to: 'dest/c.ts' },
    ])).toEqual([
      { destDir: 'src', sourcePaths: ['dest/a.ts', 'dest/c.ts'] },
      { destDir: 'lib', sourcePaths: ['dest/b.ts'] },
    ]);
  });

  it('restores a root-level entry to the root', () => {
    expect(groupUndoMoves([{ from: 'notes.md', to: 'dest/notes.md' }]))
      .toEqual([{ destDir: '', sourcePaths: ['dest/notes.md'] }]);
  });
});
