import { ExternalLink, Minus, TrendingDown, TrendingUp } from 'lucide-react';
import type { MouseEvent as ReactMouseEvent, ReactNode } from 'react';
import type {
  AgentHealthAgent,
  AgentHealthSnapshot,
  ProviderHealthLevel,
  ProviderId,
  ProviderModelScore,
  ProviderStatus,
} from '../../../shared/ipc-types';
import { openExternal } from '../../api/system.api';
import { PROVIDER_HEALTH } from '../../lib/constants';
import { formatRelativeTime } from '../../lib/formatters';
import { useAgentHealthStore } from '../../stores/agent-health.store';
import { useElectronSettingsStore } from '../../stores/electron-settings.store';
import { useProviderStatusStore } from '../../stores/provider-status.store';
import { HoverCard } from './HoverCard';
import { HoverTooltip } from './HoverTooltip';
import { Sparkline } from './Sparkline';

const PROVIDER_LABELS: Partial<Record<ProviderId, string>> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  google: 'Google',
  deepseek: 'DeepSeek',
  kimi: 'Kimi',
  glm: 'GLM',
};

const CARD_WIDTH = 296;
const AISTUPIDLEVEL_DOMAIN = 'aistupidlevel.info';
const AISTUPIDLEVEL_HOME = `https://${AISTUPIDLEVEL_DOMAIN}`;
const ARENA_HOME = 'https://arena.ai/leaderboard/text';

function providerLabel(provider: ProviderId): string {
  return PROVIDER_LABELS[provider] ?? provider.charAt(0).toUpperCase() + provider.slice(1);
}

function softColor(color: string): string {
  return `color-mix(in srgb, ${color} 78%, transparent)`;
}

function modelStatusToLevel(status: ProviderModelScore['status']): ProviderHealthLevel {
  if (status === 'good') return 'ok';
  if (status === 'warning') return 'degraded';
  return 'down';
}

function trendToLevel(trend: ProviderModelScore['trend'] | null): ProviderHealthLevel {
  if (trend === 'up') return 'ok';
  if (trend === 'down') return 'down';
  return 'unknown';
}

const MIN_FUZZY_MATCH_LENGTH = 8;
const LATEST_ALIAS_PATTERN = /^claude-(opus|sonnet|haiku|fable)-latest$/i;

// Resolve aliases like `claude-opus-latest` to the newest dated sibling in the
// benchmark catalog (`claude-opus-4-8` over `4-6` over `4-5`). Names follow
// `claude-<family>-<major>-<minor>[-YYYYMMDD]`, so lexicographic compare equals
// version compare for any single-digit minor — which is what Anthropic ships.
function resolveLatestAlias(
  models: ProviderModelScore[],
  modelId: string,
): ProviderModelScore | null {
  const match = LATEST_ALIAS_PATTERN.exec(modelId);
  if (!match) return null;
  const familyPrefix = `claude-${match[1].toLowerCase()}-`;
  let best: ProviderModelScore | null = null;
  let bestKey = '';
  for (const model of models) {
    const name = model.name.toLowerCase();
    if (!name.startsWith(familyPrefix)) continue;
    if (name === modelId.toLowerCase()) continue;
    if (name > bestKey) {
      bestKey = name;
      best = model;
    }
  }
  return best;
}

function findActiveModel(
  models: ProviderModelScore[],
  modelId: string | undefined,
): ProviderModelScore | null {
  if (!modelId) return null;
  const exact = models.find((m) => m.name === modelId || m.id === modelId);
  if (exact) return exact;

  const lower = modelId.toLowerCase();
  const caseInsensitive = models.find((m) => m.name.toLowerCase() === lower);
  if (caseInsensitive) return caseInsensitive;

  const latest = resolveLatestAlias(models, modelId);
  if (latest) return latest;

  if (lower.length < MIN_FUZZY_MATCH_LENGTH) return null;

  // Pick the longest model name that is a prefix of the requested id, OR vice versa —
  // covers Claude reporting 'claude-opus-4-5-20251101' while the API lists 'claude-opus-4-5'
  // and the symmetric case. Longest-match prevents 'claude' from matching the first listed
  // Anthropic model.
  let best: ProviderModelScore | null = null;
  let bestPrefixLength = MIN_FUZZY_MATCH_LENGTH - 1;
  for (const model of models) {
    const candidate = model.name.toLowerCase();
    if (candidate.length < MIN_FUZZY_MATCH_LENGTH) continue;
    if (lower.startsWith(candidate) || candidate.startsWith(lower)) {
      const sharedLength = Math.min(lower.length, candidate.length);
      if (sharedLength > bestPrefixLength) {
        bestPrefixLength = sharedLength;
        best = model;
      }
    }
  }
  return best;
}

function modelExternalUrl(model: ProviderModelScore): string {
  if (model.id && /^\d+$/.test(model.id)) {
    return `${AISTUPIDLEVEL_HOME}/models/${model.id}`;
  }
  return AISTUPIDLEVEL_HOME;
}

function toAgentHealthAgent(agent: string | undefined): AgentHealthAgent | null {
  if (!agent) return null;
  const normalized = agent.toLowerCase();
  if (normalized === 'claude') return 'claude';
  if (normalized === 'codex') return 'codex';
  return null;
}

function safeOpenExternal(url: string): void {
  void openExternal(url).catch(() => undefined);
}

interface ProviderHealthIndicatorProps {
  provider?: ProviderId;
  modelId?: string;
  agent?: string;
}

export function ProviderHealthIndicator({ provider, modelId, agent }: ProviderHealthIndicatorProps) {
  const status = useProviderStatusStore((s) => (provider ? s.statuses[provider] : undefined));
  const showArena = useElectronSettingsStore((s) => s.settings?.showArenaScores ?? false);
  const showAgentTracker = useElectronSettingsStore((s) => s.settings?.showAgentHealthTracker ?? false);
  const agentHealthKey = toAgentHealthAgent(agent);
  const agentTracker = useAgentHealthStore((s) => (agentHealthKey ? s.snapshots[agentHealthKey] : undefined));
  const tracker = showAgentTracker ? agentTracker : undefined;

  if (!provider) return null;

  const activeModel = status ? findActiveModel(status.quality.models, modelId) : null;

  const headlineLevel: ProviderHealthLevel = activeModel
    ? modelStatusToLevel(activeModel.status)
    : status?.level ?? 'unknown';
  const headlineColor = PROVIDER_HEALTH[headlineLevel].color;
  const headlineScore = activeModel?.score ?? status?.quality.score ?? null;
  const triggerSparkline = activeModel?.history?.length
    ? activeModel.history
    : status?.sparkline ?? [];

  return (
    <HoverCard
      ariaLabel={`${providerLabel(provider)} model quality details`}
      width={CARD_WIDTH}
      align="right"
      triggerClassName="inline-flex items-center gap-1 shrink-0 outline-none focus-visible:ring-1 focus-visible:ring-[color:var(--accent)] rounded-sm"
      cardClassName="fixed z-[60] rounded-xl border border-[var(--border)] bg-[var(--surface)] shadow-2xl overflow-hidden animate-[dropdown-in_140ms_cubic-bezier(0.16,1,0.3,1)_forwards]"
      trigger={
        <>
          <Sparkline
            points={triggerSparkline}
            color={softColor(headlineColor)}
            dotColor={headlineColor}
            showEndDot
          />
          {headlineScore !== null && (
            <span
              className="text-[10px] font-semibold tabular-nums"
              style={{ color: headlineColor }}
            >
              {headlineScore}
            </span>
          )}
        </>
      }
    >
      {() => (
        <ProviderHealthCardBody
          provider={provider}
          status={status}
          activeModel={activeModel}
          showArena={showArena}
          tracker={tracker}
        />
      )}
    </HoverCard>
  );
}

function ProviderHealthCardBody({
  provider,
  status,
  activeModel,
  showArena,
  tracker,
}: {
  provider: ProviderId;
  status: ProviderStatus | undefined;
  activeModel: ProviderModelScore | null;
  showArena: boolean;
  tracker: AgentHealthSnapshot | undefined;
}) {
  if (!status) {
    return (
      <div className="px-3 py-5 text-center text-[11px] text-[var(--text-secondary)] animate-pulse">
        Checking model status…
      </div>
    );
  }

  return (
    <>
      <CardHeader provider={provider} status={status} activeModel={activeModel} />
      <CardScore status={status} activeModel={activeModel} showArena={showArena} />
      {tracker && <AgentTrackerRow tracker={tracker} />}
      <CardModels models={status.quality.models} activeModel={activeModel} showArena={showArena} />
      <CardFooter provider={provider} status={status} activeModel={activeModel} showArena={showArena} tracker={tracker} />
    </>
  );
}

function AgentTrackerRow({ tracker }: { tracker: AgentHealthSnapshot }) {
  const tone = trackerTone(tracker.passRate);
  const onClick = () => safeOpenExternal(tracker.trackerUrl);
  return (
    <HoverTooltip
      label={`SWE-Bench-Pro pass rate · ${tracker.passed}/${tracker.displayRunsCount} · 95% CI ${tracker.ciLower.toFixed(1)}–${tracker.ciUpper.toFixed(1)}% · ${tracker.date}`}
    >
      <button
        type="button"
        onClick={onClick}
        className="group flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors border-b border-[var(--border)] hover:bg-[var(--surface-raised)] focus-visible:bg-[var(--surface-raised)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[color:var(--accent)]"
      >
        <span className="inline-flex items-center gap-1.5 text-[8.5px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">
          <span className="h-1 w-1 rounded-full" style={{ backgroundColor: 'var(--accent)' }} aria-hidden />
          Agent CLI
        </span>
        <span className="inline-flex items-baseline gap-1 ml-1">
          <span className="text-[12px] font-semibold tabular-nums leading-none" style={{ color: tone }}>
            {tracker.passRate.toFixed(0)}%
          </span>
          <span className="text-[9px] text-[var(--text-secondary)]">SWE-Bench-Pro</span>
        </span>
        <span className="ml-auto text-[9px] text-[var(--text-muted)] truncate">Margin Lab</span>
      </button>
    </HoverTooltip>
  );
}

function trackerTone(passRate: number): string {
  if (passRate >= 60) return 'var(--success)';
  if (passRate >= 40) return 'var(--warning)';
  return 'var(--error)';
}

function CardHeader({
  provider,
  status,
  activeModel,
}: {
  provider: ProviderId;
  status: ProviderStatus;
  activeModel: ProviderModelScore | null;
}) {
  const headlineLevel = activeModel ? modelStatusToLevel(activeModel.status) : status.level;
  const meta = PROVIDER_HEALTH[headlineLevel];
  const modelLabel = activeModel?.name ?? (status.quality.score === null ? 'No data' : 'Provider average');

  return (
    <div className="flex items-center justify-between gap-2 px-3 pt-2.5 pb-2 border-b border-[var(--border)]">
      <span className="min-w-0 flex items-baseline gap-1.5">
        <span className="text-[11px] font-semibold text-[var(--text)] leading-none">
          {providerLabel(provider)}
        </span>
        <HoverTooltip label={modelLabel} className="min-w-0">
          <span className="block text-[10px] text-[var(--text-secondary)] truncate">{modelLabel}</span>
        </HoverTooltip>
      </span>
      <span
        className="shrink-0 inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[9px] font-semibold leading-none"
        style={{
          color: meta.color,
          backgroundColor: `color-mix(in srgb, ${meta.color} 14%, transparent)`,
        }}
      >
        <span className="h-1 w-1 rounded-full" style={{ backgroundColor: meta.color }} />
        {meta.label}
      </span>
    </div>
  );
}

function CardScore({
  status,
  activeModel,
  showArena,
}: {
  status: ProviderStatus;
  activeModel: ProviderModelScore | null;
  showArena: boolean;
}) {
  const benchScore = activeModel?.score ?? status.quality.score;
  const trend = activeModel?.trend ?? status.quality.trend;
  const headlineLevel = activeModel ? modelStatusToLevel(activeModel.status) : status.level;
  const benchColor = PROVIDER_HEALTH[headlineLevel].color;

  const arena = activeModel?.arena;
  const arenaTotal = status.quality.arenaTotal;
  const arenaTooltip = arena
    ? `ELO ${arena.elo} ±${arena.ci} · ${arena.votes.toLocaleString()} blind votes`
    : 'Bradley-Terry rating from blind A/B votes on arena.ai';

  return (
    <div className={`grid ${showArena ? 'grid-cols-2' : 'grid-cols-1'} border-b border-[var(--border)]`}>
      <KpiCell
        sourceDotColor={PROVIDER_HEALTH.degraded.color}
        sourceLabel="Benchmark"
        tooltip="Synthetic capability index — coding, reasoning, IF — re-run hourly by aistupidlevel.info"
        valueNode={
          benchScore !== null ? (
            <span className="inline-flex items-baseline gap-1">
              <span
                className="text-[16px] font-semibold leading-none tabular-nums"
                style={{ color: benchColor }}
              >
                {benchScore}
              </span>
              <span className="text-[9.5px] font-medium text-[var(--text-secondary)]">/100</span>
              {trend && <TrendIcon trend={trend} />}
            </span>
          ) : (
            <span className="text-[10.5px] text-[var(--text-secondary)]">No data</span>
          )
        }
      />
      {showArena && (
        <KpiCell
          sourceDotColor="var(--accent)"
          sourceLabel="Arena"
          tooltip={arenaTooltip}
          leftBorder
          valueNode={
            arena ? (
              <span className="inline-flex items-baseline gap-1">
                <span className="text-[16px] font-semibold leading-none tabular-nums text-[var(--text)]">
                  #{arena.rank}
                </span>
                {arenaTotal && (
                  <span className="text-[9.5px] font-medium text-[var(--text-secondary)]">
                    of {arenaTotal}
                  </span>
                )}
              </span>
            ) : (
              <span className="text-[10.5px] text-[var(--text-secondary)]">Not ranked</span>
            )
          }
        />
      )}
    </div>
  );
}

function KpiCell({
  sourceDotColor,
  sourceLabel,
  valueNode,
  tooltip,
  leftBorder = false,
}: {
  sourceDotColor: string;
  sourceLabel: string;
  valueNode: ReactNode;
  tooltip: string;
  leftBorder?: boolean;
}) {
  return (
    <HoverTooltip
      label={tooltip}
      className={`flex flex-col gap-0.5 px-3 py-2${leftBorder ? ' border-l border-[var(--divider)]' : ''}`}
    >
      <span className="inline-flex items-center gap-1.5 text-[8.5px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">
        <span
          className="h-1 w-1 rounded-full"
          style={{ backgroundColor: sourceDotColor }}
          aria-hidden
        />
        {sourceLabel}
      </span>
      {valueNode}
    </HoverTooltip>
  );
}

function CardModels({
  models,
  activeModel,
  showArena,
}: {
  models: ProviderModelScore[];
  activeModel: ProviderModelScore | null;
  showArena: boolean;
}) {
  if (models.length === 0) return null;
  const ordered = activeModel
    ? [activeModel, ...models.filter((m) => m !== activeModel)]
    : models;
  const visible = ordered.slice(0, 4);
  const showArenaColumn = showArena && visible.some((m) => m.arena);

  return (
    <div className="border-b border-[var(--border)]">
      <ModelColumnHeaders showArena={showArenaColumn} />
      <div className="px-1.5 pb-1.5 flex flex-col">
        {visible.map((model) => (
          <ModelRow
            key={`${model.id ?? ''}:${model.name}`}
            model={model}
            isActive={model === activeModel}
            showArena={showArenaColumn}
          />
        ))}
      </div>
    </div>
  );
}

function ModelColumnHeaders({ showArena }: { showArena: boolean }) {
  return (
    <div className="flex items-center gap-2 px-3 pt-1.5 pb-0.5 text-[8.5px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">
      <span className="flex-1">Model</span>
      <span className="w-8 text-right">Bench</span>
      {showArena && <span className="w-7 text-right">Arena</span>}
    </div>
  );
}

function ModelRow({
  model,
  isActive,
  showArena,
}: {
  model: ProviderModelScore;
  isActive: boolean;
  showArena: boolean;
}) {
  const level = modelStatusToLevel(model.status);
  const dotColor = PROVIDER_HEALTH[level].color;
  const onClick = () => safeOpenExternal(modelExternalUrl(model));
  const accentBorder = isActive
    ? { boxShadow: `inset 2px 0 0 0 ${dotColor}` }
    : undefined;

  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`Open ${model.name} on ${AISTUPIDLEVEL_DOMAIN}`}
      className="group flex items-center gap-2 rounded-md px-2 py-1 text-left transition-colors hover:bg-[var(--surface-raised)] focus-visible:bg-[var(--surface-raised)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[color:var(--accent)]"
      style={accentBorder}
    >
      <span
        className="h-1.5 w-1.5 rounded-full shrink-0"
        style={{ backgroundColor: dotColor }}
        aria-hidden
      />
      <HoverTooltip label={model.name} className="flex-1 min-w-0">
        <span
          className={`block truncate text-[10px] ${isActive ? 'font-semibold text-[var(--text)]' : 'text-[var(--text-secondary)]'}`}
        >
          {model.name}
        </span>
      </HoverTooltip>
      {isActive && (
        <span
          className="shrink-0 rounded-full px-1.5 py-px text-[8px] font-semibold uppercase tracking-wide"
          style={{
            color: dotColor,
            backgroundColor: `color-mix(in srgb, ${dotColor} 14%, transparent)`,
          }}
        >
          Active
        </span>
      )}
      <span className={`w-8 shrink-0 text-right text-[10px] font-semibold tabular-nums ${isActive ? 'text-[var(--text)]' : 'text-[var(--text-secondary)]'}`}>
        {model.score}
      </span>
      {showArena && (
        <span className="w-7 shrink-0 text-right">
          {model.arena ? (
            <HoverTooltip
              label={`ELO ${model.arena.elo} ±${model.arena.ci} · ${model.arena.votes.toLocaleString()} votes`}
            >
              <span
                className="inline-block rounded px-1 py-px text-[9px] font-bold tabular-nums"
                style={{
                  color: 'var(--accent)',
                  backgroundColor: 'color-mix(in srgb, var(--accent) 14%, transparent)',
                }}
              >
                #{model.arena.rank}
              </span>
            </HoverTooltip>
          ) : (
            <span className="text-[10px] text-[var(--text-muted)]">—</span>
          )}
        </span>
      )}
    </button>
  );
}

function CardFooter({
  provider,
  status,
  activeModel,
  showArena,
  tracker,
}: {
  provider: ProviderId;
  status: ProviderStatus;
  activeModel: ProviderModelScore | null;
  showArena: boolean;
  tracker: AgentHealthSnapshot | undefined;
}) {
  const measuredAt = activeModel?.measuredAt ?? status.quality.measuredAt ?? status.updatedAt;
  const operationalMeta = PROVIDER_HEALTH[status.operational.level];
  const operationalLabel = status.operational.description ?? operationalMeta.label;
  const onClick = () => safeOpenExternal(AISTUPIDLEVEL_HOME);
  const onArenaClick = (event: ReactMouseEvent) => {
    event.stopPropagation();
    safeOpenExternal(ARENA_HOME);
  };
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onClick();
        }
      }}
      aria-label={`Open AI Stupid Level dashboard for ${providerLabel(provider)}`}
      className="group flex items-center gap-2 px-3 py-1.5 cursor-pointer transition-colors hover:bg-[var(--surface-raised)] focus-visible:bg-[var(--surface-raised)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[color:var(--accent)]"
    >
      <HoverTooltip label={`Status from ${operationalLabel}. Updated ${formatRelativeTime(measuredAt)}.`}>
        <span className="inline-flex items-center gap-1.5 text-[9.5px] text-[var(--text-secondary)]">
          <span
            className="h-1.5 w-1.5 rounded-full shrink-0"
            style={{ backgroundColor: operationalMeta.color }}
            aria-hidden
          />
          API {operationalLabel.toLowerCase()}
        </span>
      </HoverTooltip>
      <span className="ml-auto inline-flex items-center gap-1.5 text-[9.5px] text-[var(--text-muted)]">
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onClick();
          }}
          className="hover:text-[var(--text-secondary)] transition-colors"
        >
          aistupidlevel
        </button>
        {showArena && (
          <>
            <span aria-hidden>·</span>
            <button
              type="button"
              onClick={onArenaClick}
              className="hover:text-[var(--text-secondary)] transition-colors"
            >
              Arena
            </button>
          </>
        )}
        {tracker && (
          <>
            <span aria-hidden>·</span>
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                safeOpenExternal(tracker.trackerUrl);
              }}
              className="hover:text-[var(--text-secondary)] transition-colors"
            >
              Margin Lab
            </button>
          </>
        )}
        <ExternalLink
          size={10}
          className="shrink-0 text-[var(--text-muted)] transition-colors group-hover:text-[var(--text-secondary)]"
          aria-hidden
        />
      </span>
    </div>
  );
}

function TrendIcon({ trend }: { trend: NonNullable<ProviderStatus['quality']['trend']> }): ReactNode {
  const level = trendToLevel(trend);
  const tone = level === 'ok'
    ? 'text-[var(--success)]'
    : level === 'down'
      ? 'text-[var(--error)]'
      : 'text-[var(--text-secondary)]';
  if (trend === 'up') return <TrendingUp size={11} className={tone} aria-label="trending up" />;
  if (trend === 'down') return <TrendingDown size={11} className={tone} aria-label="trending down" />;
  return <Minus size={11} className={tone} aria-label="stable" />;
}
