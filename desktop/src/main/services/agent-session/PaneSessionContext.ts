import { existsSync, watch } from 'fs';
import { basename, dirname, join } from 'path';
import type { FSWatcher } from 'fs';
import type { AumxPane } from 'aumx/core';
import type { AgentLogParser, SessionDiscoveryMode } from '../parsing/AgentLogParser.js';
import type { NormalizedSession } from '../../../shared/agent-session-types.js';
import {
  JSONL_EXTENSION,
  fileFingerprint,
  listDirectoryEntries,
  readSessionFileTime,
} from '../parsing/session-files.js';
import { SessionFileWatcher } from './SessionFileWatcher.js';
import { log } from '../Logger.js';

const MAX_WAIT_MS = 10 * 60 * 1000; // Give up after 10 minutes
const FAST_FALLBACK_POLL_MS = 1_500;
const SLOW_FALLBACK_POLL_MS = 30_000;
// New agent sessions normally create their store immediately. Keep discovery
// responsive through startup, then stop repeatedly walking a shared session tree
// for a pane that never produced a session (for example an exited Codex pane).
const FAST_INITIAL_DISCOVERY_WINDOW_MS = 30_000;
// A parser whose session file is shared has no cheap liveness proof, so every poll
// pays the full discovery cost. 5s keeps a manual session switch under half the time
// it takes a user to look away, at a fifth of the discovery work of the fast poll.
const SHARED_SESSION_FILE_POLL_MS = 5_000;
// A per-session file can suppress discovery while it is growing. Once quiet it
// cannot prove that no replacement exists, so keep the cheap 1.5s stat cadence
// but cap the expensive shared-tree discovery pass at the same 5s cadence.
const EXCLUSIVE_TREE_DISCOVERY_MIN_MS = 5_000;
const REPLACEMENT_CHECK_DEBOUNCE_MS = 1_500;
const DISCOVERY_ROOT_RECHECK_MS = 30_000;
// SQLite writes land as a burst across the db and its -wal/-shm sidecars; one
// coalesced discovery pass per burst is enough to bind on the first write.
const DISCOVERY_EVENT_DEBOUNCE_MS = 150;

export class PaneSessionContext {
  private watcher: SessionFileWatcher | null = null;
  private dirWatcher: FSWatcher | null = null;
  private parentWatcher: FSWatcher | null = null;
  private replacementWatcher: FSWatcher | null = null;
  private fallbackTimer: ReturnType<typeof setTimeout> | null = null;
  private replacementPollTimer: ReturnType<typeof setTimeout> | null = null;
  private replacementDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private replacementCheck: Promise<void> | null = null;
  private replacementScanPending = false;
  private boundFileSignature: string | null = null;
  private filePath: string | null = null;
  private cachedSession: NormalizedSession | null = null;
  private parsing = false;
  private pendingReparse = false;
  private stopped = false;
  private startTime = 0;
  private discoveryRoot: string;
  private discoveryRootCheckedAt = 0;
  private lastReplacementDiscoveryAt = 0;
  private watchedSessionDir: string | null = null;
  private replacementWatchedSessionDir: string | null = null;
  private sessionDirCache: { root: string; dir: string | null } | null = null;
  private lastDiscoveryError: string | null = null;
  private discoveryWatcher: FSWatcher | null = null;
  private discoveryEventTimer: ReturnType<typeof setTimeout> | null = null;
  private discoveryWatchFailed = false;

  constructor(
    private readonly pane: AumxPane,
    private readonly parser: AgentLogParser,
    projectRoot: string,
    private readonly onSessionUpdated: (paneId: string, session: NormalizedSession) => void,
    private readonly resolveDiscoveryRoot?: () => Promise<string>,
    private readonly claimedFiles?: Set<string>,
  ) {
    this.discoveryRoot = projectRoot;
  }

  getFilePath(): string | null {
    return this.filePath;
  }

  async start(): Promise<void> {
    this.startTime = Date.now();
    await this.refreshDiscoveryRoot();
    if (this.stopped) return;

    const found = await this.discoverSessionFile();
    if (this.stopped) return;
    this.filePath = found;

    if (this.filePath) {
      this.claimFile(this.filePath);
      this.onFileFound();
      return;
    }

    log.info('pane-session', 'No session file found yet, watching for it', {
      paneId: this.pane.id,
      agent: this.pane.agent,
      projectRoot: this.discoveryRoot,
    });

    const sessionDir = this.sessionDirectory();
    if (sessionDir) {
      this.watchForSession(sessionDir);
    } else {
      // No watchable session directory (Codex trees, OpenCode databases) — take an
      // event source if the parser can name one, and keep the poll as the backstop.
      this.watchDiscoveryDirectory();
      this.scheduleFallbackPoll();
    }
  }

  // Discovery reaches an agent's store over a subprocess, a SQLite file or a
  // directory scan, so a failure is a transient condition, not a dead pane: report
  // it once per distinct cause and let the caller keep the retry machinery running.
  private async discoverSessionFile(mode: SessionDiscoveryMode = 'initial'): Promise<string | null> {
    try {
      const found = await this.parser.findSessionFile(this.pane, this.discoveryRoot, this.claimedFiles, mode);
      this.lastDiscoveryError = null;
      return found;
    } catch (err) {
      this.logDiscoveryFailureOnce(err);
      return null;
    }
  }

  private logDiscoveryFailureOnce(err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    if (this.lastDiscoveryError === message) return;
    this.lastDiscoveryError = message;
    log.warn('pane-session', 'Session discovery failed, will retry', {
      paneId: this.pane.id,
      agent: this.pane.agent,
      projectRoot: this.discoveryRoot,
      error: err instanceof Error ? err.stack ?? err.message : String(err),
    });
  }

  // Degrades to the poll on any failure, reported once so a permanently unwatchable
  // directory cannot fill the log on every retry.
  private watchDiscoveryDirectory(): void {
    if (this.stopped || this.filePath || this.discoveryWatcher || this.discoveryWatchFailed) return;
    const dir = this.parser.getDiscoveryWatchDirectory?.(this.pane, this.discoveryRoot);
    if (!dir || !existsSync(dir)) return;

    try {
      this.discoveryWatcher = watch(dir, (_event, filename) => {
        if (this.stopped || this.filePath || !filename) return;
        if (this.parser.isDiscoveryFileName?.(filename) !== true) return;
        this.scheduleDiscoveryEvent();
      });
      log.debug('pane-session', 'Watching discovery directory', { paneId: this.pane.id, dir });
    } catch (err) {
      this.discoveryWatchFailed = true;
      log.warn('pane-session', 'Cannot watch discovery directory, polling only', {
        paneId: this.pane.id,
        dir,
        error: String(err),
      });
    }
  }

  private scheduleDiscoveryEvent(): void {
    if (this.discoveryEventTimer || this.stopped || this.filePath) return;
    this.discoveryEventTimer = setTimeout(() => {
      this.discoveryEventTimer = null;
      void this.bindFromDiscoveryEvent();
    }, DISCOVERY_EVENT_DEBOUNCE_MS);
  }

  private async bindFromDiscoveryEvent(): Promise<void> {
    if (this.stopped || this.filePath) return;
    const found = await this.discoverSessionFile();
    if (this.stopped || this.filePath || !found) return;
    this.filePath = found;
    this.claimFile(found);
    this.closeSessionDirectoryWatchers();
    this.clearFallbackTimer();
    this.onFileFound();
  }

  /** Memoized per discovery root: resolving it stats and lists the agent's log tree. */
  private sessionDirectory(): string | null {
    if (this.sessionDirCache?.root !== this.discoveryRoot) {
      this.sessionDirCache = {
        root: this.discoveryRoot,
        dir: this.parser.getSessionDirectory(this.pane, this.discoveryRoot),
      };
    }
    return this.sessionDirCache.dir;
  }

  private watchForSession(sessionDir: string): void {
    if (this.stopped) return;
    this.watchedSessionDir = sessionDir;

    if (!existsSync(sessionDir)) {
      // Directory doesn't exist yet — watch parent for its creation
      const parentDir = dirname(sessionDir);
      log.debug('pane-session', 'Session dir not found, watching parent', {
        paneId: this.pane.id,
        sessionDir,
        parentDir,
      });

      try {
        this.parentWatcher = watch(parentDir, async (event, filename) => {
          if (this.stopped || this.filePath) return;
          // filename may be null on some platforms; fall back to checking existence
          if (filename && !sessionDir.endsWith(filename)) return;
          if (existsSync(sessionDir)) {
            log.debug('pane-session', 'Session dir appeared', { paneId: this.pane.id, sessionDir });
            this.parentWatcher?.close();
            this.parentWatcher = null;
            this.watchForSession(sessionDir);
          }
        });
      } catch (err) {
        log.debug('pane-session', 'Cannot watch parent dir, falling back to poll', {
          paneId: this.pane.id,
          parentDir,
          error: String(err),
        });
      }

      this.scheduleFallbackPoll();
      return;
    }

    // Directory exists — watch it directly for new .jsonl files
    log.debug('pane-session', 'Watching session directory', { paneId: this.pane.id, sessionDir });

    try {
      this.dirWatcher = watch(sessionDir, async (event, filename) => {
        if (this.stopped || this.filePath) return;
        if (event !== 'rename' || !filename?.endsWith(JSONL_EXTENSION)) return;

        log.debug('pane-session', 'New .jsonl file detected', { paneId: this.pane.id, filename });
        const found = await this.discoverSessionFile();
        if (this.stopped || this.filePath) return;
        if (found) {
          this.filePath = found;
          this.claimFile(found);
          this.closeSessionDirectoryWatchers();
          this.clearFallbackTimer();
          this.onFileFound();
        }
      });
    } catch (err) {
      log.debug('pane-session', 'Cannot watch session dir, falling back to poll', {
        paneId: this.pane.id,
        sessionDir,
        error: String(err),
      });
    }

    // Always run fallback poll alongside the watcher as a safety net
    this.scheduleFallbackPoll();
  }

  private onFileFound(): void {
    if (this.stopped || !this.filePath) return;
    log.info('pane-session', 'Session file found', { paneId: this.pane.id, file: this.filePath });
    // Baseline for the liveness gate, so the first check compares against the file as
    // it was at bind time rather than treating it as unseen.
    this.boundFileSignature = fileFingerprint(this.filePath);
    this.lastReplacementDiscoveryAt = Date.now();
    this.watchForReplacementSession();
    const watchPaths = this.parser.getSessionWatchPaths?.(this.filePath) ?? [this.filePath];
    this.watcher = new SessionFileWatcher(
      this.filePath,
      () => this.parseAndEmit(),
      watchPaths,
    );
    this.watcher.start();
    void this.parseAndEmit();
  }

  private scheduleFallbackPoll(): void {
    if (this.stopped || this.filePath) return;
    if (this.fallbackTimer) return;
    if (Date.now() - this.startTime > MAX_WAIT_MS) {
      log.warn('pane-session', 'Max wait time reached, giving up session file discovery', {
        paneId: this.pane.id,
        agent: this.pane.agent,
        elapsedMs: Date.now() - this.startTime,
      });
      return;
    }

    this.fallbackTimer = setTimeout(async () => {
      this.fallbackTimer = null;
      if (this.stopped || this.filePath) return;

      await this.refreshDiscoveryRoot();
      this.rebindSessionDirectoryWatcherIfNeeded();
      this.watchDiscoveryDirectory();

      log.debug('pane-session', 'Fallback poll for session file', { paneId: this.pane.id });
      const found = await this.discoverSessionFile();
      if (this.stopped || this.filePath) return;
      if (found) {
        this.filePath = found;
        this.claimFile(found);
        this.closeSessionDirectoryWatchers();
        this.onFileFound();
      } else {
        this.scheduleFallbackPoll();
      }
    }, this.getFallbackPollMs());
  }

  private async parseAndEmit(): Promise<void> {
    if (!this.filePath) return;
    if (this.parsing) {
      this.pendingReparse = true;
      return;
    }
    this.parsing = true;
    try {
      do {
        this.pendingReparse = false;
        const parsingPath: string | null = this.filePath;
        if (!parsingPath) return;
        const session = await this.parser.parseSession(parsingPath);
        if (this.stopped || !this.filePath) return;
        if (this.filePath !== parsingPath) {
          // A replacement was bound while the old file was parsing. Never emit
          // the stale session after announcing the new binding; the rebind's
          // parse request is folded into the next loop iteration.
          this.pendingReparse = true;
          continue;
        }
        this.cachedSession = session;
        this.onSessionUpdated(this.pane.id, session);
      } while (this.pendingReparse && !this.stopped && !!this.filePath);
    } catch (err) {
      log.error('pane-session', 'Parse failed', { paneId: this.pane.id, error: String(err) });
    } finally {
      this.parsing = false;
    }
  }

  getSession(): NormalizedSession | null {
    return this.cachedSession;
  }

  stop(): void {
    this.stopped = true;
    this.clearFallbackTimer();
    this.closeSessionDirectoryWatchers();
    this.closeReplacementWatcher();
    this.watcher?.stop();
    this.watcher = null;
    this.unclaimFile();
  }

  private claimFile(path: string): void {
    this.claimedFiles?.add(path);
  }

  private unclaimFile(): void {
    if (this.filePath) {
      this.claimedFiles?.delete(this.filePath);
    }
  }

  private clearFallbackTimer(): void {
    if (this.fallbackTimer) {
      clearTimeout(this.fallbackTimer);
      this.fallbackTimer = null;
    }
  }

  private closeSessionDirectoryWatchers(): void {
    if (this.discoveryEventTimer) {
      clearTimeout(this.discoveryEventTimer);
      this.discoveryEventTimer = null;
    }
    this.discoveryWatcher?.close();
    this.discoveryWatcher = null;
    this.dirWatcher?.close();
    this.dirWatcher = null;
    this.parentWatcher?.close();
    this.parentWatcher = null;
    this.watchedSessionDir = null;
  }

  private closeReplacementWatcher(): void {
    this.replacementWatcher?.close();
    this.replacementWatcher = null;
    this.replacementWatchedSessionDir = null;
    this.clearReplacementTimers();
  }

  private watchForReplacementSession(): void {
    if (this.stopped || !this.filePath) return;

    const sessionDir = this.sessionDirectory();
    if (!sessionDir) {
      this.scheduleReplacementPoll();
      return;
    }
    if (!existsSync(sessionDir)) return;
    if (this.replacementWatcher && this.replacementWatchedSessionDir === sessionDir) return;

    this.closeReplacementWatcher();

    try {
      // Deliberately reacts to every event kind: a session replaced in place
      // surfaces as `change` on Linux, and macOS labels every directory event
      // `rename`, so filtering by event kind would drop real replacements.
      this.replacementWatcher = watch(sessionDir, (_event, filename) => {
        if (this.stopped || !this.filePath) return;
        if (!filename?.endsWith(JSONL_EXTENSION)) return;
        // An append to the bound file cannot have produced a newer sibling, so it
        // still runs the check but without the directory scan.
        this.scheduleReplacementCheck(filename !== basename(this.filePath));
      });
      this.replacementWatchedSessionDir = sessionDir;
    } catch (err) {
      log.debug('pane-session', 'Cannot watch session dir for replacement files', {
        paneId: this.pane.id,
        sessionDir,
        error: String(err),
      });
      this.scheduleReplacementPoll();
    }
  }

  private scheduleReplacementPoll(): void {
    if (this.stopped || !this.filePath || this.replacementPollTimer) return;

    this.replacementPollTimer = setTimeout(async () => {
      this.replacementPollTimer = null;
      if (this.stopped || !this.filePath) return;

      await this.runReplacementCheck(true);
      this.scheduleReplacementPoll();
    }, this.getReplacementPollMs());
  }

  /**
   * A parser with a directory only reaches the poll when watching it failed, and its
   * directory scan already gates the work. Without one, the poll is the only chance to
   * notice a switch, so it stays responsive: an exclusive session file is gated for
   * free by `boundSessionProvablyLive`, a shared one has to pay for every pass.
   */
  private getReplacementPollMs(): number {
    if (this.sessionDirectory() !== null) return SLOW_FALLBACK_POLL_MS;
    return this.parser.boundFileIsExclusive ? FAST_FALLBACK_POLL_MS : SHARED_SESSION_FILE_POLL_MS;
  }

  // Coalesces a burst of directory events into a single check. The timer is not
  // restarted per event on purpose: a continuously appended session would
  // otherwise starve the check forever.
  private scheduleReplacementCheck(scanDirectory: boolean): void {
    if (this.stopped || !this.filePath) return;
    this.replacementScanPending ||= scanDirectory;
    if (this.replacementDebounceTimer) return;

    this.replacementDebounceTimer = setTimeout(() => {
      this.replacementDebounceTimer = null;
      const scan = this.replacementScanPending;
      this.replacementScanPending = false;
      void this.runReplacementCheck(scan);
    }, REPLACEMENT_CHECK_DEBOUNCE_MS);
  }

  private runReplacementCheck(scanDirectory: boolean): Promise<void> {
    if (this.stopped || !this.filePath) return Promise.resolve();
    // A check already in flight cannot have seen this event, so it is re-debounced
    // behind the running one instead of starting a second discovery pass.
    if (this.replacementCheck) {
      this.scheduleReplacementCheck(scanDirectory);
      return this.replacementCheck;
    }

    this.replacementCheck = this.rebindToReplacementSessionFile(scanDirectory)
      .finally(() => { this.replacementCheck = null; });
    return this.replacementCheck;
  }

  private clearReplacementTimers(): void {
    if (this.replacementPollTimer) {
      clearTimeout(this.replacementPollTimer);
      this.replacementPollTimer = null;
    }
    if (this.replacementDebounceTimer) {
      clearTimeout(this.replacementDebounceTimer);
      this.replacementDebounceTimer = null;
    }
  }

  private async rebindToReplacementSessionFile(scanDirectory: boolean): Promise<void> {
    const currentFilePath = this.filePath;
    if (!currentFilePath) return;
    if (!await this.shouldAttemptRebind(currentFilePath, scanDirectory)) return;
    if (this.stopped || this.filePath !== currentFilePath) return;

    await this.refreshDiscoveryRoot();
    if (this.stopped || this.filePath !== currentFilePath) return;
    this.lastReplacementDiscoveryAt = Date.now();
    const found = await this.discoverSessionFile('replacement');
    if (this.stopped || this.filePath !== currentFilePath) return;
    if (!found || found === currentFilePath) return;
    if (!this.shouldRebindSessionFile(found, currentFilePath)) return;

    log.info('pane-session', 'Rebinding to replacement session file', {
      paneId: this.pane.id,
      from: currentFilePath,
      to: found,
    });

    this.watcher?.stop();
    this.watcher = null;
    this.unclaimFile();
    this.filePath = found;
    this.claimFile(found);
    this.onFileFound();
  }

  // Rebinding is only meaningful once the bound file is gone, is no longer the one
  // being written, or another session file in the same directory has overtaken it.
  // Everything else is an append to the live session, so the whole discovery pass
  // (tmux round-trip + directory scan or subprocess) is skipped. A pane that moved to
  // another project looks the same to that check, so a closed gate re-resolves the
  // discovery root — rate limited, since that is the tmux round-trip the check exists
  // to avoid — and asks again against the directory the pane is really in now.
  private async shouldAttemptRebind(currentFilePath: string, scanDirectory: boolean): Promise<boolean> {
    const currentTime = readSessionFileTime(currentFilePath);
    if (currentTime === null) return true;
    if (this.boundSessionProvablyLive(currentFilePath)) return false;
    if (this.expensiveReplacementDiscoveryIsRateLimited()) return false;
    if (scanDirectory && this.hasNewerSessionFileInDiscoveryDir(currentFilePath, currentTime)) return true;
    if (!await this.recheckDiscoveryRoot()) return false;
    return this.hasNewerSessionFileInDiscoveryDir(currentFilePath, currentTime);
  }

  /**
   * Only asked where discovery is expensive and there is no directory to scan. A file
   * that grew since the previous check is still being written by this pane's agent, so
   * nothing can have replaced it. A shared store cannot answer this: its writes may
   * belong to any session in the project.
   */
  private boundSessionProvablyLive(currentFilePath: string): boolean {
    if (this.sessionDirectory() !== null || !this.parser.boundFileIsExclusive) return false;

    const signature = fileFingerprint(currentFilePath);
    const stillBeingWritten = signature !== null && signature !== this.boundFileSignature;
    this.boundFileSignature = signature;
    return stillBeingWritten;
  }

  private expensiveReplacementDiscoveryIsRateLimited(): boolean {
    return this.sessionDirectory() === null
      && this.parser.boundFileIsExclusive
      && Date.now() - this.lastReplacementDiscoveryAt < EXCLUSIVE_TREE_DISCOVERY_MIN_MS;
  }

  private hasNewerSessionFileInDiscoveryDir(currentFilePath: string, currentTime: number): boolean {
    const sessionDir = this.sessionDirectory();
    if (!sessionDir) return true;
    return this.hasNewerSessionFile(sessionDir, currentFilePath, currentTime);
  }

  /** Re-resolves the discovery root at most once per interval; true when it moved. */
  private async recheckDiscoveryRoot(): Promise<boolean> {
    if (Date.now() - this.discoveryRootCheckedAt < DISCOVERY_ROOT_RECHECK_MS) return false;

    const previousRoot = this.discoveryRoot;
    await this.refreshDiscoveryRoot();
    return this.discoveryRoot !== previousRoot;
  }

  private hasNewerSessionFile(sessionDir: string, currentPath: string, currentTime: number): boolean {
    for (const entry of listDirectoryEntries(sessionDir)) {
      if (!entry.endsWith(JSONL_EXTENSION)) continue;

      const candidatePath = join(sessionDir, entry);
      if (candidatePath === currentPath || this.claimedFiles?.has(candidatePath)) continue;

      const candidateTime = readSessionFileTime(candidatePath);
      if (candidateTime !== null && candidateTime > currentTime) return true;
    }
    return false;
  }

  private shouldRebindSessionFile(candidatePath: string, currentPath: string): boolean {
    return this.isNewerSessionFile(candidatePath, currentPath);
  }

  private isNewerSessionFile(candidatePath: string, currentPath: string): boolean {
    const candidateTime = readSessionFileTime(candidatePath);
    const currentTime = readSessionFileTime(currentPath);
    if (candidateTime === null || currentTime === null) return false;
    return candidateTime > currentTime;
  }

  private async refreshDiscoveryRoot(): Promise<void> {
    if (!this.resolveDiscoveryRoot) return;
    this.discoveryRootCheckedAt = Date.now();

    try {
      const nextRoot = (await this.resolveDiscoveryRoot())?.trim();
      if (!nextRoot || nextRoot === this.discoveryRoot) return;

      const previousRoot = this.discoveryRoot;
      this.discoveryRoot = nextRoot;
      log.info('pane-session', 'Session discovery root updated', {
        paneId: this.pane.id,
        from: previousRoot,
        to: nextRoot,
      });
    } catch (err) {
      log.debug('pane-session', 'Failed to refresh session discovery root', {
        paneId: this.pane.id,
        error: String(err),
      });
    }
  }

  private rebindSessionDirectoryWatcherIfNeeded(): void {
    if (this.filePath || this.stopped) return;

    const nextSessionDir = this.sessionDirectory();
    if (nextSessionDir === this.watchedSessionDir) return;

    this.closeSessionDirectoryWatchers();

    if (nextSessionDir) {
      log.debug('pane-session', 'Rebinding session directory watcher', {
        paneId: this.pane.id,
        sessionDir: nextSessionDir,
      });
      this.watchForSession(nextSessionDir);
    }
  }

  // Pre-binding only: an agent without a watchable directory gets a responsive
  // startup window, then uses the safety-net cadence. The terminal remains live;
  // only transcript metadata discovery is delayed after an abnormal startup.
  private getFallbackPollMs(): number {
    if (this.sessionDirectory() !== null) return SLOW_FALLBACK_POLL_MS;
    return Date.now() - this.startTime < FAST_INITIAL_DISCOVERY_WINDOW_MS
      ? FAST_FALLBACK_POLL_MS
      : SLOW_FALLBACK_POLL_MS;
  }
}
