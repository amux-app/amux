import { describe, expect, it } from 'vitest';
import { parsePorcelainV1Z } from '../src/main/services/git/gitDiffParser';

describe('parsePorcelainV1Z', () => {
  it('parses a simple modified entry', () => {
    // Arrange
    const input = ' M src/foo.ts\0';

    // Act
    const entries = parsePorcelainV1Z(input);

    // Assert
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      path: 'src/foo.ts',
      oldPath: undefined,
      status: 'modified',
    });
  });

  it('parses rename with porcelain v1 -z order: <newPath>\\0<origPath>\\0', () => {
    // Arrange — git status -z encodes renames as: "R  newPath\0origPath\0"
    const input = 'R  src/new.ts\0src/old.ts\0';

    // Act
    const entries = parsePorcelainV1Z(input);

    // Assert
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      path: 'src/new.ts',
      oldPath: 'src/old.ts',
      status: 'renamed',
    });
  });

  it('parses copy with porcelain v1 -z order: <newPath>\\0<origPath>\\0', () => {
    // Arrange
    const input = 'C  src/copy.ts\0src/orig.ts\0';

    // Act
    const entries = parsePorcelainV1Z(input);

    // Assert
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      path: 'src/copy.ts',
      oldPath: 'src/orig.ts',
      status: 'copied',
    });
  });

  it('parses untracked entries', () => {
    // Arrange
    const input = '?? new-file.txt\0';

    // Act
    const entries = parsePorcelainV1Z(input);

    // Assert
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      path: 'new-file.txt',
      status: 'untracked',
    });
  });

  it('parses multiple mixed entries including a rename', () => {
    // Arrange
    const input = ' M a.ts\0R  b-new.ts\0b-old.ts\0?? c.ts\0';

    // Act
    const entries = parsePorcelainV1Z(input);

    // Assert
    expect(entries).toHaveLength(3);
    expect(entries[0]).toMatchObject({ path: 'a.ts', status: 'modified' });
    expect(entries[1]).toMatchObject({
      path: 'b-new.ts',
      oldPath: 'b-old.ts',
      status: 'renamed',
    });
    expect(entries[2]).toMatchObject({ path: 'c.ts', status: 'untracked' });
  });
});
