import { describe, expect, it } from 'vitest';
import { STATUS_REASSERT_CAPTURES } from '../../../src/constants/timing';
import { PaneStatusAnalyzer } from '../../../src/services/PaneStatusAnalyzer';
import { PaneActivityProjection } from '../../src/main/services/PaneActivityProjection';
import { PaneActivityService } from '../../src/main/services/PaneActivityService';

const paneId = 'pane-1';
const paneIncarnationId = 'incarnation-1';
const WORKING_FRAME = '· Germinating… (esc to interrupt · 42s)';
const IDLE_FRAME = '│ > ';

/**
 * Composed integration harness: real `PaneStatusAnalyzer` -> real
 * `PaneActivityProjection` -> real `PaneActivityService`, fed the frame text
 * tmux would capture. It deliberately stops short of tmux itself, PaneMonitor,
 * IPC and the DOM, so it proves the resolution path, not the rendered spinner.
 */
class PollHarness {
  readonly service: PaneActivityService;
  private readonly analyzer = new PaneStatusAnalyzer('claude');
  private readonly projection: PaneActivityProjection;
  private monotonic = 0;

  constructor() {
    this.service = new PaneActivityService({
      epochId: 'test-epoch',
      monotonicNow: () => this.monotonic,
      wallNow: () => 1_000_000 + this.monotonic,
    });
    this.projection = new PaneActivityProjection(() => this.service);
    this.service.registerPane(paneId, paneIncarnationId, { starting: true });
    this.service.setLiveness(paneId, 'running');
  }

  capture(frame: string, count = 1): void {
    for (let i = 0; i < count; i += 1) {
      this.monotonic += 1_000;
      const { statusChange } = this.analyzer.analyzeCapture(frame, frame);
      if (statusChange) this.projection.recordPollActivity(paneId, statusChange.status);
      this.service.sweep();
    }
  }

  get state(): string {
    return this.service.getSnapshot(paneId).activity.state;
  }
}

describe('sidebar indicator stays synced with tmux-observed agent status', () => {
  it('lights up on a working frame and clears once the agent returns to its prompt', () => {
    // Arrange
    const harness = new PollHarness();

    // Act + Assert
    harness.capture(WORKING_FRAME);
    expect(harness.state).toBe('working');

    harness.capture(IDLE_FRAME, 3);
    expect(harness.state).toBe('idle');
  });

  it('lights up again for every later turn, not just the first', () => {
    // Arrange
    const harness = new PollHarness();
    harness.capture(WORKING_FRAME);
    harness.capture(IDLE_FRAME, 3);

    // Act + Assert
    for (let turn = 0; turn < 3; turn += 1) {
      harness.capture(WORKING_FRAME);
      expect(harness.state).toBe('working');
      harness.capture(IDLE_FRAME, 3);
      expect(harness.state).toBe('idle');
    }
  });

  it('holds working through a long turn that produces no status change', () => {
    // Arrange
    const harness = new PollHarness();
    harness.capture(WORKING_FRAME);

    // Act: 60 unchanged working captures, far past the evidence lease
    harness.capture(WORKING_FRAME, 60);

    // Assert
    expect(harness.state).toBe('working');
  });

  it('needs no more than one reassert cadence to survive the lease', () => {
    // Arrange
    const harness = new PollHarness();
    harness.capture(WORKING_FRAME);

    // Act
    harness.capture(WORKING_FRAME, STATUS_REASSERT_CAPTURES);

    // Assert
    expect(harness.state).toBe('working');
  });
});

describe('a status restatement is freshness, not a transition', () => {
  it('renews the evidence lease without re-running transition-only discovery', () => {
    // Arrange
    const analyzer = new PaneStatusAnalyzer('claude');
    const transitions: Array<{ status: string; reasserted: boolean }> = [];

    // Act
    for (let capture = 0; capture < STATUS_REASSERT_CAPTURES * 2; capture += 1) {
      const { statusChange } = analyzer.analyzeCapture(WORKING_FRAME, WORKING_FRAME);
      if (statusChange && !statusChange.reasserted) {
        transitions.push({ reasserted: false, status: statusChange.status });
      }
    }

    // Assert — one real transition, however many freshness ticks followed
    expect(transitions).toEqual([{ reasserted: false, status: 'working' }]);
  });
});
