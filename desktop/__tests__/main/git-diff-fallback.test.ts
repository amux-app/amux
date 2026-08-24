import { describe, expect, it } from 'vitest';
import { __test__ } from '../../src/main/services/git/gitDiff';

describe('git diff fallback metadata parsing', () => {
  it('parses renamed files from diff headers', () => {
    const patch = [
      'diff --git a/src/old-name.ts b/src/new-name.ts',
      'similarity index 98%',
      'rename from src/old-name.ts',
      'rename to src/new-name.ts',
      'index 1234567..89abcde 100644',
      '--- a/src/old-name.ts',
      '+++ b/src/new-name.ts',
      '@@ -1,1 +1,1 @@',
      '-export const a = 1;',
      '+export const a = 2;',
      '',
    ].join('\n');

    expect(__test__.extractDiffHeaderInfo('src/new-name.ts', patch)).toEqual({
      path: 'src/new-name.ts',
      oldPath: 'src/old-name.ts',
      status: 'renamed',
    });
  });

  it('parses added and deleted files from mode headers', () => {
    const addedPatch = [
      'diff --git a/src/new-file.ts b/src/new-file.ts',
      'new file mode 100644',
      'index 0000000..1234567',
      '--- /dev/null',
      '+++ b/src/new-file.ts',
      '@@ -0,0 +1 @@',
      '+export const hello = true;',
      '',
    ].join('\n');

    const deletedPatch = [
      'diff --git a/src/old-file.ts b/src/old-file.ts',
      'deleted file mode 100644',
      'index 1234567..0000000',
      '--- a/src/old-file.ts',
      '+++ /dev/null',
      '@@ -1 +0,0 @@',
      '-export const stale = true;',
      '',
    ].join('\n');

    expect(__test__.extractDiffHeaderInfo('src/new-file.ts', addedPatch).status).toBe('added');
    expect(__test__.extractDiffHeaderInfo('src/old-file.ts', deletedPatch).status).toBe('deleted');
  });

  it('parses type changes when file mode changes', () => {
    const typeChangePatch = [
      'diff --git a/scripts/tool b/scripts/tool',
      'old mode 100644',
      'new mode 100755',
      'index 1234567..1234567',
      '--- a/scripts/tool',
      '+++ b/scripts/tool',
      '',
    ].join('\n');

    expect(__test__.extractDiffHeaderInfo('scripts/tool', typeChangePatch)).toEqual({
      path: 'scripts/tool',
      oldPath: undefined,
      status: 'typechange',
    });
  });

  it('marks synthesized entries as staged-only', () => {
    const patch = [
      'diff --git a/src/app.ts b/src/app.ts',
      'index 1234567..7654321 100644',
      '--- a/src/app.ts',
      '+++ b/src/app.ts',
      '@@ -1 +1 @@',
      '-export const v = 1;',
      '+export const v = 2;',
      '',
    ].join('\n');

    expect(__test__.toParsedStatusFromPatch('src/app.ts', patch)).toEqual({
      path: 'src/app.ts',
      oldPath: undefined,
      status: 'modified',
      staged: true,
      unstaged: false,
    });
  });

  it('parses raw plus numstat rename output', () => {
    const raw = [
      ':100644 100644 1234567 89abcde R100',
      'src/old-name.ts',
      'src/new-name.ts',
      '3\t1\t',
      'src/old-name.ts',
      'src/new-name.ts',
      '',
    ].join('\0');

    expect(Array.from(__test__.parseRawDiffWithNumstat(raw).values())).toEqual([
      {
        path: 'src/new-name.ts',
        oldPath: 'src/old-name.ts',
        status: 'renamed',
        additions: 3,
        deletions: 1,
      },
    ]);
  });

  it('keeps repeated diff chunks for the same file', () => {
    const diff = [
      'diff --git a/src/app.ts b/src/app.ts',
      'index 1111111..2222222 100644',
      '--- a/src/app.ts',
      '+++ b/src/app.ts',
      '@@ -1 +1 @@',
      '-export const step = 1;',
      '+export const step = 2;',
      '',
      'diff --git a/src/app.ts b/src/app.ts',
      'index 2222222..3333333 100644',
      '--- a/src/app.ts',
      '+++ b/src/app.ts',
      '@@ -3 +3 @@',
      '-export const done = false;',
      '+export const done = true;',
      '',
    ].join('\n');

    const patch = __test__.splitDiffByFile(diff).get('src/app.ts');

    expect(patch).toBeTruthy();
    expect(patch?.match(/diff --git/g)?.length).toBe(2);
    expect(patch).toContain('+export const done = true;');
  });

  it('includes untracked additions in repo totals', () => {
    expect(__test__.summarizeGitDiffFiles([
      {
        path: 'src/app.ts',
        status: 'modified',
        staged: false,
        unstaged: true,
        additions: 5,
        deletions: 2,
      },
      {
        path: 'src/new-file.ts',
        status: 'untracked',
        staged: false,
        unstaged: true,
        additions: 7,
        deletions: 0,
      },
    ])).toEqual({
      filesChanged: 2,
      insertions: 12,
      deletions: 2,
      changedFiles: ['src/app.ts', 'src/new-file.ts'],
      untrackedFiles: ['src/new-file.ts'],
    });
  });
});
