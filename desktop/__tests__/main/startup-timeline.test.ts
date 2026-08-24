import { describe, expect, it } from 'vitest';
import { StartupTimeline } from '../../src/main/services/StartupTimeline';

describe('StartupTimeline', () => {
  it('records deterministic phase durations from one monotonic origin', () => {
    const samples = [100, 109, 287, 304];
    const timeline = new StartupTimeline(() => samples.shift() ?? 304);

    timeline.mark('windowCreated');
    timeline.mark('rendererRequested');
    timeline.mark('ready');

    expect(timeline.snapshot()).toEqual({
      ready: 204,
      rendererRequested: 187,
      windowCreated: 9,
    });
  });

  it('keeps the first observation when a phase is marked twice', () => {
    const samples = [10, 20, 40];
    const timeline = new StartupTimeline(() => samples.shift() ?? 40);

    timeline.mark('rendererRequested');
    timeline.mark('rendererRequested');

    expect(timeline.snapshot()).toEqual({ rendererRequested: 10 });
  });
});
