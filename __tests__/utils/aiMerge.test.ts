import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { getComprehensiveDiff } from '../../src/utils/aiMerge';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'muxbase-ai-merge-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('getComprehensiveDiff', () => {
  it('throws when git diff collection fails instead of returning an empty diff', async () => {
    // Arrange
    const notGitRepo = makeTempDir();

    // Act / Assert
    await expect(getComprehensiveDiff(notGitRepo)).rejects.toThrow(/failed to collect git diff/i);
  });
});
