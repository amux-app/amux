import { describe, expect, it } from 'vitest';
import { parseGitGutterChanges } from '../src/renderer/components/file-browser/gitGutter';

describe('parseGitGutterChanges', () => {
  it('maps added, modified, and deleted blocks to current document lines', () => {
    const patch = [
      '@@ -1,5 +1,6 @@',
      ' unchanged',
      '-old value',
      '+new value',
      ' context',
      '+added value',
      ' another context',
      '-deleted value',
      ' tail',
    ].join('\n');

    expect(parseGitGutterChanges(patch)).toEqual(new Map([
      [2, 'modified'],
      [4, 'added'],
      [6, 'deleted'],
    ]));
  });

  it('supports multiple hunks and ignores diff metadata', () => {
    const patch = [
      'diff --git a/file.ts b/file.ts',
      '--- a/file.ts',
      '+++ b/file.ts',
      '@@ -2,0 +3,2 @@',
      '+first',
      '+second',
      '@@ -10,1 +12,0 @@',
      '-removed',
    ].join('\n');

    expect(parseGitGutterChanges(patch)).toEqual(new Map([
      [3, 'added'],
      [4, 'added'],
      [12, 'deleted'],
    ]));
  });
});
