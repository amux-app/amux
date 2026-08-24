import type { NormalizedSession } from '../../../shared/agent-session-types.js';
import { BoundedCache } from '../boundedCache.js';

// An entry holds a whole parsed session plus the state its next parse resumes from,
// so retention is capped rather than left to grow with every path the app has seen.
// The cap sits above any realistic pane count: evicting a live pane's entry costs it
// a full re-parse of its log, which is the cost this cache exists to avoid.
const DEFAULT_MAX_ENTRIES = 32;

/** Last successful parse of a key. Incremental parsers resume from `state`. */
export interface SessionParseSnapshot<TState> {
  session: NormalizedSession;
  state: TState | undefined;
}

interface SessionParseInput<TState> {
  filePath: string;
  previous: SessionParseSnapshot<TState> | null;
}

interface SessionParseResult<TState> {
  session: NormalizedSession;
  state?: TState;
}

export type SessionParseFn<TState> = (input: SessionParseInput<TState>) => Promise<SessionParseResult<TState>>;

export interface SessionParseRequest {
  filePath: string;
  /** Content identity of the bytes. Null is "unidentifiable": parse, never store. */
  fingerprint: string | null;
  /** Defaults to `filePath`. Override to fold parse inputs outside the file into the identity. */
  key?: string;
}

interface CacheEntry<TState> {
  fingerprint: string;
  session: NormalizedSession;
  state: TState | undefined;
}

/**
 * Memoizes agent session parses on an exact content fingerprint, so watcher-driven
 * re-reads of an unchanged log cost one stat instead of a full file scan. The
 * caller owns the identity: only it knows which sidecar files and which non-file
 * inputs its parse depends on.
 */
export class SessionParseCache<TState = never> {
  private readonly entries: BoundedCache<CacheEntry<TState>>;

  constructor(maxEntries: number = DEFAULT_MAX_ENTRIES) {
    this.entries = new BoundedCache(maxEntries);
  }

  async read(request: SessionParseRequest, parse: SessionParseFn<TState>): Promise<NormalizedSession> {
    const { filePath, fingerprint, key = request.filePath } = request;
    const cached = this.entries.get(key) ?? null;
    if (cached && fingerprint !== null && cached.fingerprint === fingerprint) return cached.session;

    // Dropped up front so a parse that throws cannot leave a snapshot behind that
    // no longer describes anything on disk.
    this.entries.delete(key);
    const previous = cached ? { session: cached.session, state: cached.state } : null;
    const result = await parse({ filePath, previous });
    if (fingerprint !== null) {
      this.entries.set(key, { fingerprint, session: result.session, state: result.state });
    }
    return result.session;
  }
}
