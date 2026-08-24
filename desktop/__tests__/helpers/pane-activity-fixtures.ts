import type { PaneActivity } from '../../src/shared/pane-activity';

export function makeActivity(overrides: Partial<PaneActivity> = {}): PaneActivity {
  return {
    activityRevision: 1,
    adapterHealth: 'healthy',
    certainty: 'confirmed',
    liveness: 'running',
    openBackgroundWork: [],
    origin: 'adapter',
    paneIncarnationId: 'incarnation-1',
    sinceWallMs: Date.now(),
    state: 'idle',
    ...overrides,
  };
}
