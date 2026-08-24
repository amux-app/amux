import { describe, it, expect } from 'vitest';
import { generateSlug, sanitizeSlug } from '../src/utils/slug.js';

describe('slug generation', () => {
  it('falls back to a memorable adjective-noun slug when prompt is empty', async () => {
    const slug = await generateSlug('');
    // adjective-noun (e.g. "swift-otter") — both halves are lowercase a-z words
    expect(slug).toMatch(/^[a-z]+-[a-z]+$/);
  });

  it('returns kebab-ish slug for prompt (or fallback)', async () => {
    const slug = await generateSlug('Refactor Aumx App');
    expect(typeof slug).toBe('string');
    expect(slug.length).toBeGreaterThan(0);
  }, 10000);
});

describe('sanitizeSlug', () => {
  it('replaces spaces with hyphens', () => {
    expect(sanitizeSlug('amux worktree idea')).toBe('amux-worktree-idea');
  });

  it('handles the review-prefix concatenation that caused the worktree bug', () => {
    // Regression: source pane slug contained spaces (paneName was passed
    // through unsanitised), then `review-${slug}` produced an invalid branch
    // name like 'review-amux worktree idea' when git worktree add ran.
    expect(sanitizeSlug('review-amux worktree idea')).toBe('review-amux-worktree-idea');
  });

  it('lowercases mixed case', () => {
    expect(sanitizeSlug('My New Pane')).toBe('my-new-pane');
  });

  it('strips punctuation and special characters', () => {
    expect(sanitizeSlug("don't break: a/b/c?")).toBe('don-t-break-a-b-c');
  });

  it('collapses runs of separators into a single hyphen', () => {
    expect(sanitizeSlug('foo   ---   bar')).toBe('foo-bar');
  });

  it('trims leading and trailing hyphens', () => {
    expect(sanitizeSlug('---weird---')).toBe('weird');
  });

  it('caps length at 30 chars without leaving a trailing hyphen', () => {
    const result = sanitizeSlug('a'.repeat(40));
    expect(result.length).toBeLessThanOrEqual(30);
    expect(result.endsWith('-')).toBe(false);
  });

  it('returns empty string when input has no usable characters', () => {
    expect(sanitizeSlug('!!!')).toBe('');
    expect(sanitizeSlug('   ')).toBe('');
  });

  it('preserves an already-clean slug verbatim', () => {
    expect(sanitizeSlug('fix-auth-bug')).toBe('fix-auth-bug');
  });
});
