import { describe, expect, it } from 'vitest';
import {
  FILE_EDITOR_CAPABILITY_THRESHOLDS,
  getFileEditorCapabilityTier,
} from '../src/renderer/components/file-browser/fileEditorCapabilities';

describe('file editor capability tiers', () => {
  it('keeps normal source files on the full editor tier', () => {
    expect(getFileEditorCapabilityTier('const answer = 42;\n', 19)).toBe('full');
  });

  it('reduces optional completion work for large editable files', () => {
    const content = 'x'.repeat(FILE_EDITOR_CAPABILITY_THRESHOLDS.full.maxBytes + 1);
    expect(getFileEditorCapabilityTier(content, Buffer.byteLength(content))).toBe('reduced');
  });

  it('makes pathological long-line files read-only before CodeMirror mounts', () => {
    const content = 'x'.repeat(FILE_EDITOR_CAPABILITY_THRESHOLDS.reduced.maxLineLength + 1);
    expect(getFileEditorCapabilityTier(content, Buffer.byteLength(content))).toBe('read-only');
  });

  it('makes files beyond the editable byte ceiling read-only', () => {
    expect(getFileEditorCapabilityTier('', FILE_EDITOR_CAPABILITY_THRESHOLDS.reduced.maxBytes + 1))
      .toBe('read-only');
  });
});
