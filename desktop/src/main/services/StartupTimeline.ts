import { performance } from 'node:perf_hooks';

export type StartupPhase =
  | 'windowCreated'
  | 'rendererRequested'
  | 'preflightComplete'
  | 'bridgeReady'
  | 'ready';

export class StartupTimeline {
  private readonly marks = new Map<StartupPhase, number>();
  private readonly origin: number;

  constructor(private readonly now: () => number = () => performance.now()) {
    this.origin = now();
  }

  mark(phase: StartupPhase): void {
    if (this.marks.has(phase)) return;
    this.marks.set(phase, Math.max(0, Math.round(this.now() - this.origin)));
  }

  snapshot(): Partial<Record<StartupPhase, number>> {
    return Object.fromEntries(this.marks) as Partial<Record<StartupPhase, number>>;
  }
}
