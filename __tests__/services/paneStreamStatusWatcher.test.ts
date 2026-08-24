import { describe, expect, it } from 'vitest';
import { PaneStreamStatusWatcher } from '../../src/services/PaneStreamStatusWatcher';

describe('PaneStreamStatusWatcher', () => {
  it('emits positive-only working evidence from a fresh terminal marker', () => {
    const watcher = new PaneStreamStatusWatcher('codex');

    expect(watcher.observe('\u001b[2KEsc to interrupt')).toBe(true);
  });

  it('does not infer idle from stream bytes that lack a working marker', () => {
    const watcher = new PaneStreamStatusWatcher('codex');

    expect(watcher.observe('normal output without a footer')).toBe(false);
  });

  it('detects a working marker split across terminal chunks', () => {
    let now = 0;
    const watcher = new PaneStreamStatusWatcher('codex', () => now);

    expect(watcher.observe('\u001b[2KEsc to')).toBe(false);
    now += 10;
    expect(watcher.observe(' interrupt')).toBe(true);
  });

  it('does not let ordinary output throttle the first working marker', () => {
    let now = 0;
    const watcher = new PaneStreamStatusWatcher('codex', () => now);

    expect(watcher.observe('ordinary output')).toBe(false);
    now += 50;
    expect(watcher.observe('\u001b[2KEsc to interrupt')).toBe(true);
  });

  it('caps duplicate marker evaluation to ten observations per second', () => {
    let now = 0;
    const watcher = new PaneStreamStatusWatcher('codex', () => now);

    expect(watcher.observe('Esc to interrupt')).toBe(true);
    now += 50;
    expect(watcher.observe('Esc to interrupt')).toBe(false);
    now += 100;
    expect(watcher.observe('Esc to interrupt')).toBe(true);
  });
});
