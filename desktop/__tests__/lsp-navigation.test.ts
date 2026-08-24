import { describe, expect, it } from 'vitest';
import {
  consumePendingLspNavigation,
  markPendingLspNavigation,
  relativePathFromFileUri,
  toFileUri,
} from '../src/renderer/components/file-browser/lspNavigation';

describe('LSP file navigation', () => {
  it('maps only file URIs contained by the canonical root', () => {
    expect(toFileUri('/repo with spaces', 'src/app.ts')).toBe('file:///repo%20with%20spaces/src/app.ts');
    expect(relativePathFromFileUri('/repo with spaces', 'file:///repo%20with%20spaces/src/app.ts')).toBe('src/app.ts');
    expect(relativePathFromFileUri('/repo', 'file:///repo-other/app.ts')).toBeNull();
    expect(relativePathFromFileUri('/repo', 'https://example.com/app.ts')).toBeNull();
  });

  it('consumes an explicit navigation activation exactly once', () => {
    const uri = 'file:///repo/src/app.ts';
    markPendingLspNavigation(uri);
    expect(consumePendingLspNavigation(uri)).toBe(true);
    expect(consumePendingLspNavigation(uri)).toBe(false);
  });
});
