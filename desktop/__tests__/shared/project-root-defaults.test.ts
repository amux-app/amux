import { describe, expect, it } from 'vitest';
import { resolveDefaultTaskProjectRoot } from '../../src/renderer/lib/project-root-defaults';

describe('resolveDefaultTaskProjectRoot', () => {
  it('defaults to current project when persisted root points elsewhere', () => {
    const result = resolveDefaultTaskProjectRoot({
      activeProjectRoot: '/Users/me/projects/proj-16',
      sessionProjectRoot: '/Users/me/projects/proj-16',
      lastTaskProjectRoot: '/Users/me/projects/test_project_3',
    });

    expect(result).toBeUndefined();
  });

  it('keeps persisted root when it matches current project', () => {
    const result = resolveDefaultTaskProjectRoot({
      activeProjectRoot: '/Users/me/projects/proj-16',
      lastTaskProjectRoot: '/Users/me/projects/proj-16/',
    });

    expect(result).toBe('/Users/me/projects/proj-16/');
  });

  it('falls back to persisted root when current root is unavailable', () => {
    const result = resolveDefaultTaskProjectRoot({
      lastTaskProjectRoot: '/Users/me/projects/test_project_3',
    });

    expect(result).toBe('/Users/me/projects/test_project_3');
  });
});
