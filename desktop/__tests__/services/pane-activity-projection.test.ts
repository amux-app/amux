import { describe, expect, it } from 'vitest';
import { PaneActivityProjection } from '../../src/main/services/PaneActivityProjection';
import { PaneActivityService } from '../../src/main/services/PaneActivityService';
import { createEmptySession } from '../../src/shared/agent-session-types';

describe('PaneActivityProjection.recordSessionActivity', () => {
  it('does not fabricate working from an empty session with unknown turn state', () => {
    // Arrange
    const service = new PaneActivityService({ epochId: 'test-epoch', now: () => 100 });
    service.registerPane('pane-1', 'incarnation-1');
    const projection = new PaneActivityProjection(() => service);

    // Act
    projection.recordSessionActivity('pane-1', createEmptySession('claude', 'session-1'));

    // Assert
    expect(service.getSnapshot('pane-1').activity.state).toBe('unknown');
  });
});

describe('PaneActivityProjection.recordPollActivity', () => {
  it('gives each delivery a distinct id so same-tick observations are not deduped away', () => {
    // Arrange
    const service = new PaneActivityService({ epochId: 'test-epoch', now: () => 100 });
    service.registerPane('pane-1', 'incarnation-1');
    service.setLiveness('pane-1', 'running');
    const projection = new PaneActivityProjection(() => service);

    // Act
    projection.recordPollActivity('pane-1', 'working');
    projection.recordPollActivity('pane-1', 'idle');
    projection.recordPollActivity('pane-1', 'working');

    // Assert
    expect(service.getSnapshot('pane-1').activity.state).toBe('working');
  });
});
