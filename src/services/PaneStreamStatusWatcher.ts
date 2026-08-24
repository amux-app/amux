import type { AgentName } from '../agents/agent-contract.js';
import { classifyTailStatus } from './paneStatusHeuristics.js';

const MIN_OBSERVATION_INTERVAL_MS = 100;
const MAX_TAIL_CHARS = 8 * 1024;

/** Positive-only activity inference for terminal byte streams. */
export class PaneStreamStatusWatcher {
  private lastEvidenceAt = Number.NEGATIVE_INFINITY;
  private rawTail = '';

  constructor(
    private readonly agent: AgentName | undefined,
    private readonly now: () => number = Date.now,
  ) {}

  observe(data: string): boolean {
    this.rawTail = `${this.rawTail}${data}`.slice(-MAX_TAIL_CHARS);
    if (classifyTailStatus(stripAnsi(this.rawTail), this.agent) !== 'working') return false;

    // Consume the detected marker even while emission is rate-limited. A
    // historical marker in the raw transcript must not be re-emitted later
    // when unrelated bytes arrive.
    this.rawTail = '';
    const now = this.now();
    if (now - this.lastEvidenceAt < MIN_OBSERVATION_INTERVAL_MS) return false;
    this.lastEvidenceAt = now;
    return true;
  }
}

function stripAnsi(value: string): string {
  return value
    // Screen-control sequences separate visual regions. Replacing them with a
    // newline prevents adjacent text writes from being merged into one token.
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '\n')
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '\n');
}
