import { execAsync } from 'muxbase/core';
import type { MuxBasePane } from 'muxbase/core';
import type { NormalizedSession } from '../../shared/agent-session-types.js';
import { IPC_EVENT } from '../../shared/ipc-channels.js';
import type { ActivitySnapshot } from '../../shared/pane-activity.js';
import type {
  PaneSummary,
  PaneSummaryGitActivity,
  PaneSummaryRecapStatus,
  PaneSummaryRemovedEvent,
  PaneSummaryUpdatedEvent,
} from '../../shared/pane-summary-types.js';
import { log } from './Logger.js';
import { PaneSummaryPersistence } from './paneSummaryPersistence.js';
import { generateRecap } from './recapGenerator.js';

const TTL_MS = 10 * 60 * 1000;
const RECAP_TTL_MS = 10 * 60 * 1000;
const MAX_MESSAGES_FOR_RECAP = 40;

interface PaneSummaryBridgePort {
  getAgentSession(paneId: string): NormalizedSession | null;
  getPaneActivitySnapshot(): ActivitySnapshot;
  getPanes(): MuxBasePane[];
}

interface PaneSummaryServiceOpts {
  projectRoot: string;
  bridge: PaneSummaryBridgePort;
  emit: (channel: string, payload: unknown) => void;
}

export class PaneSummaryService {
  private readonly persistence: PaneSummaryPersistence;
  private readonly cache = new Map<string, PaneSummary>();
  private readonly inFlight = new Set<string>();
  private readonly recapInFlight = new Set<string>();

  constructor(private readonly opts: PaneSummaryServiceOpts) {
    this.persistence = new PaneSummaryPersistence(opts.projectRoot);
  }

  async loadAll(): Promise<PaneSummary[]> {
    const items = await this.persistence.load();
    for (const item of items) this.cache.set(item.paneId, item);
    return items;
  }

  /**
   * Refresh the fast fields of a pane summary (branch, git activity, startedAt).
   * Does NOT call the LLM. Recap remains whatever was previously cached.
   */
  async refreshOne(paneId: string, force: boolean): Promise<PaneSummary | null> {
    if (this.inFlight.has(paneId)) return this.cache.get(paneId) ?? null;
    const existing = this.cache.get(paneId);
    if (!force && existing && Date.now() - existing.generatedAt < TTL_MS && existing.status === 'fresh') {
      return existing;
    }
    const pane = this.findPane(paneId);
    if (!pane) return null;

    this.inFlight.add(paneId);
    try {
      const built = await this.buildBaseSummary(pane, existing);
      // A recap may have completed (or started generating) while we were
      // awaiting git work above. Re-read the cache and let the latest recap
      // state win, so we never persist stale recap fields.
      const summary = mergeRecapFromLatest(built, this.cache.get(paneId));
      this.cache.set(paneId, summary);
      await this.persistence.save(summary);
      const event: PaneSummaryUpdatedEvent = { summary };
      this.opts.emit(IPC_EVENT.PANE_SUMMARY_UPDATED, event);
      return summary;
    } catch (error) {
      log.warn('pane-summary', 'refreshOne failed', { paneId, error });
      const fallback: PaneSummary = existing
        ? { ...existing, status: 'error', errorMessage: String(error) }
        : this.errorSummary(pane, String(error));
      this.cache.set(paneId, fallback);
      const event: PaneSummaryUpdatedEvent = { summary: fallback };
      this.opts.emit(IPC_EVENT.PANE_SUMMARY_UPDATED, event);
      return fallback;
    } finally {
      this.inFlight.delete(paneId);
    }
  }

  async refreshMany(paneIds: string[], force: boolean): Promise<PaneSummary[]> {
    const results = await Promise.all(paneIds.map((id) => this.refreshOne(id, force)));
    return results.filter((s): s is PaneSummary => s !== null);
  }

  /**
   * Generate (or regenerate) the LLM recap for a pane. Emits one update with
   * `recapStatus: 'generating'` immediately, then a second update with the
   * resolved recap (or error) when the LLM call returns.
   */
  async generateRecapOne(paneId: string, force: boolean): Promise<PaneSummary | null> {
    if (this.recapInFlight.has(paneId)) return this.cache.get(paneId) ?? null;
    let base = this.cache.get(paneId);
    if (!base) {
      // Ensure a base summary exists before recap generation.
      base = (await this.refreshOne(paneId, false)) ?? undefined;
      if (!base) return null;
    }
    if (
      !force &&
      base.recapStatus === 'ready' &&
      base.recapGeneratedAt &&
      Date.now() - base.recapGeneratedAt < RECAP_TTL_MS
    ) {
      return base;
    }
    const pane = this.findPane(paneId);
    if (!pane) return null;

    this.recapInFlight.add(paneId);
    try {
      const generating: PaneSummary = {
        ...base,
        recapStatus: 'generating',
        recapErrorMessage: undefined,
      };
      this.cache.set(paneId, generating);
      this.opts.emit(IPC_EVENT.PANE_SUMMARY_UPDATED, { summary: generating } as PaneSummaryUpdatedEvent);

      const { text, recapStatus, errorMessage } = await this.computeRecap(pane);
      // A refresh may have landed while we were awaiting the LLM. Take the
      // newest fast fields from the cache and overlay our recap result on top.
      const latest = this.cache.get(paneId) ?? generating;
      const final: PaneSummary = {
        ...latest,
        recap: text,
        recapStatus,
        recapErrorMessage: errorMessage,
        recapGeneratedAt: recapStatus === 'ready' ? Date.now() : generating.recapGeneratedAt,
      };
      this.cache.set(paneId, final);
      await this.persistence.save(final);
      this.opts.emit(IPC_EVENT.PANE_SUMMARY_UPDATED, { summary: final } as PaneSummaryUpdatedEvent);
      return final;
    } finally {
      this.recapInFlight.delete(paneId);
    }
  }

  async generateRecapMany(paneIds: string[], force: boolean): Promise<PaneSummary[]> {
    const results = await Promise.all(paneIds.map((id) => this.generateRecapOne(id, force)));
    return results.filter((s): s is PaneSummary => s !== null);
  }

  async removeForPane(paneId: string): Promise<void> {
    this.cache.delete(paneId);
    await this.persistence.remove(paneId);
    const event: PaneSummaryRemovedEvent = { paneId };
    this.opts.emit(IPC_EVENT.PANE_SUMMARY_REMOVED, event);
  }

  async dispose(): Promise<void> {
    this.cache.clear();
    this.inFlight.clear();
    this.recapInFlight.clear();
  }

  // --- helpers ---

  private findPane(paneId: string): MuxBasePane | undefined {
    return this.opts.bridge.getPanes().find((p) => p.id === paneId);
  }

  private getActivitySinceWallMs(paneId: string): number | undefined {
    try {
      return this.opts.bridge.getPaneActivitySnapshot().panes[paneId]?.sinceWallMs;
    } catch {
      return undefined;
    }
  }

  /** Fast fields only — no LLM call. Preserves prior recap state if any. */
  private async buildBaseSummary(pane: MuxBasePane, prior: PaneSummary | undefined): Promise<PaneSummary> {
    const branch = pane.branchName ?? '';
    const gitActivity = pane.worktreePath ? await this.readGitActivity(pane.worktreePath) : null;

    return {
      paneId: pane.id,
      paneName: pane.title ?? pane.slug,
      agent: (pane.agent ?? 'shell') as PaneSummary['agent'],
      startedAt: this.getActivitySinceWallMs(pane.id)
        ?? prior?.startedAt
        ?? Date.now(),
      branch,
      worktreePath: pane.worktreePath ?? null,
      gitActivity,
      recap: prior?.recap ?? '',
      recapStatus: prior?.recapStatus ?? 'idle',
      recapGeneratedAt: prior?.recapGeneratedAt,
      recapErrorMessage: prior?.recapErrorMessage,
      generatedAt: Date.now(),
      status: 'fresh',
    };
  }

  private async computeRecap(pane: MuxBasePane): Promise<{
    text: string;
    recapStatus: PaneSummaryRecapStatus;
    errorMessage?: string;
  }> {
    const session = this.opts.bridge.getAgentSession(pane.id);
    if (!session || session.messages.length === 0) {
      return { text: 'Pane just started — no activity yet.', recapStatus: 'ready' };
    }
    const tail = session.messages.slice(-MAX_MESSAGES_FOR_RECAP);
    const formatted = tail.map((m) => `[${m.type}] ${m.content}`.trim()).filter(Boolean);
    try {
      const result = await generateRecap(formatted);
      if (result.error || !result.summary) {
        return {
          text: this.cache.get(pane.id)?.recap ?? '',
          recapStatus: 'error',
          errorMessage: result.error ?? 'Recap unavailable',
        };
      }
      return { text: result.summary, recapStatus: 'ready' };
    } catch (error) {
      log.warn('pane-summary', 'computeRecap failed', { paneId: pane.id, error });
      return {
        text: this.cache.get(pane.id)?.recap ?? '',
        recapStatus: 'error',
        errorMessage: String(error),
      };
    }
  }

  private async readGitActivity(worktreePath: string): Promise<PaneSummaryGitActivity | null> {
    try {
      const [ahead, diff, dirty] = await Promise.all([
        execAsync('git rev-list --count @{upstream}..HEAD', { cwd: worktreePath, silent: true }).catch(() => '0'),
        execAsync('git diff --shortstat HEAD', { cwd: worktreePath, silent: true }).catch(() => ''),
        execAsync('git status --porcelain', { cwd: worktreePath, silent: true }).catch(() => ''),
      ]);
      return {
        commitsAhead: Number.parseInt(ahead.trim() || '0', 10),
        additions: Number.parseInt(/(\d+) insertion/.exec(diff)?.[1] ?? '0', 10),
        deletions: Number.parseInt(/(\d+) deletion/.exec(diff)?.[1] ?? '0', 10),
        dirtyFileCount: dirty.trim() ? dirty.trim().split('\n').length : 0,
      };
    } catch (error) {
      log.warn('pane-summary', 'git activity read failed', { worktreePath, error });
      return null;
    }
  }

  private errorSummary(pane: MuxBasePane, message: string): PaneSummary {
    return {
      paneId: pane.id,
      paneName: pane.title ?? pane.slug,
      agent: (pane.agent ?? 'shell') as PaneSummary['agent'],
      startedAt: Date.now(),
      branch: pane.branchName ?? '',
      worktreePath: pane.worktreePath ?? null,
      gitActivity: null,
      recap: '',
      recapStatus: 'idle',
      generatedAt: Date.now(),
      status: 'error',
      errorMessage: message,
    };
  }
}

/**
 * Overlay the latest recap fields onto a freshly-built base summary.
 *
 * `built` carries authoritative branch/git/startedAt and the recap state we
 * inherited at the start of refreshOne. If a recap update landed while we
 * were awaiting git work, `latest` will reflect it — pick whichever entry
 * has the newer recap signal so we never persist stale recap fields.
 */
function mergeRecapFromLatest(
  built: PaneSummary,
  latest: PaneSummary | undefined,
): PaneSummary {
  if (!latest) return built;
  // 'generating' wins instantly — there is an in-flight recap call we must
  // not stomp. For the rest, prefer whichever side has the newer
  // recapGeneratedAt (or any non-empty recap, when timestamps tie/missing).
  if (latest.recapStatus === 'generating') {
    return {
      ...built,
      recap: latest.recap,
      recapStatus: latest.recapStatus,
      recapGeneratedAt: latest.recapGeneratedAt,
      recapErrorMessage: latest.recapErrorMessage,
    };
  }
  const builtTs = built.recapGeneratedAt ?? 0;
  const latestTs = latest.recapGeneratedAt ?? 0;
  if (latestTs > builtTs || (latestTs === builtTs && latest.recap && !built.recap)) {
    return {
      ...built,
      recap: latest.recap,
      recapStatus: latest.recapStatus,
      recapGeneratedAt: latest.recapGeneratedAt,
      recapErrorMessage: latest.recapErrorMessage,
    };
  }
  return built;
}
