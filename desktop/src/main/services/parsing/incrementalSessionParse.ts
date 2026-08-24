import type { NormalizedSession } from '../../../shared/agent-session-types.js';
import { readJsonlTail, type JsonlCheckpoint } from './JsonlTailReader.js';
import type { SessionParseFn } from './SessionParseCache.js';

/** Line-at-a-time session builder whose state survives between parses. */
export interface JsonlSessionAccumulator<TState> {
  create(filePath: string): TState;
  apply(state: TState, line: string): void;
  /** `state` is reused by the next incremental parse, so this must stay repeatable. */
  finalize(state: TState): NormalizedSession;
}

export interface IncrementalParseState<TState> {
  checkpoint: JsonlCheckpoint | null;
  state: TState;
}

export function createIncrementalJsonlParser<TState>(
  accumulator: JsonlSessionAccumulator<TState>,
): SessionParseFn<IncrementalParseState<TState>> {
  return async ({ filePath, previous }) => {
    const retained = previous?.state ?? null;
    const resumePoint = retained?.checkpoint ?? null;
    // `apply` advances the retained state line by line, so a state whose parse is
    // still running — or whose parse threw partway — can no longer be resumed
    // from. Clearing the checkpoint up front makes the next reader reparse fully.
    if (retained) retained.checkpoint = null;

    // The accumulator state is only built once the reader has decided whether the
    // retained one can be resumed, so a resumed parse allocates nothing.
    let target: IncrementalParseState<TState> | null = null;
    const resolveTarget = (resumed: boolean): IncrementalParseState<TState> => {
      target = resumed && retained ? retained : { checkpoint: null, state: accumulator.create(filePath) };
      return target;
    };

    const checkpoint = await readJsonlTail(filePath, resumePoint, (resumed) => {
      const { state } = resolveTarget(resumed);
      return (line) => accumulator.apply(state, line);
    });

    const parsed = target ?? resolveTarget(false);
    parsed.checkpoint = checkpoint;
    return { session: accumulator.finalize(parsed.state), state: parsed };
  };
}
