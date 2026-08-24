import { describe, expect, it } from 'vitest';
import { ACTIVITY_ADAPTERS } from '../../src/utils/activityAdapters';

describe('activity adapter descriptors', () => {
  it.each([
    ['claude', '2.1.145', 'full'],
    ['claude', '2.1.100', 'partial'],
    ['claude', '1.9.0', 'none'],
    ['codex', '0.0.9', 'none'],
    ['opencode', '1.2.0', 'full'],
    ['pi', '0.0.1', 'none'],
  ] as const)('%s %s is %s supported', (agent, version, expected) => {
    expect(ACTIVITY_ADAPTERS[agent].supports(version)).toBe(expected);
  });

  it('exposes a descriptor for every supported agent with install and removal operations', () => {
    expect(Object.keys(ACTIVITY_ADAPTERS).sort()).toEqual(['claude', 'codex', 'opencode', 'pi']);
    for (const adapter of Object.values(ACTIVITY_ADAPTERS)) {
      expect(adapter.agent).toBeTruthy();
      expect(adapter.capabilities.length).toBeGreaterThan(0);
      expect(typeof adapter.install).toBe('function');
      expect(typeof adapter.remove).toBe('function');
    }
  });
});
