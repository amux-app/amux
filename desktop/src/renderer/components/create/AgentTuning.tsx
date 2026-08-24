import type { AgentName } from 'aumx/core';
import { Cpu, Gauge, Info } from 'lucide-react';
import type { AgentDefaultSlice, OpencodeDefaults } from '../../../shared/ipc-types';
import { AGENT_TUNING, isValidOption, type AgentOption } from '../../lib/agent-models';
import { cn } from '../../lib/cn';
import { AgentOptionDropdown } from '../shared/AgentOptionDropdown';
import { HoverTooltip } from '../shared/HoverTooltip';

interface AgentTuningProps {
  agent: AgentName | undefined;
  model: string | undefined;
  effort: string | undefined;
  onModelChange: (value: string | undefined) => void;
  onEffortChange: (value: string | undefined) => void;
  defaults?: AgentDefaultSlice;
  opencodeDefaults?: OpencodeDefaults;
  /** True when AGENT_DEFAULTS_GET has not resolved yet — render a placeholder for opencode rather than flashing the static chip */
  defaultsLoading?: boolean;
}

const OPENCODE_FALLBACK_TOOLTIP = 'OpenCode reads its model from ~/.config/opencode/opencode.json. Add models there to populate this dropdown.';

// Mirrors modelSchema in ipc-request-validation.ts so we never offer a value
// the IPC layer would reject. Defense-in-depth on the renderer side.
const SAFE_MODEL_REGEX = /^[A-Za-z0-9._\-/]+$/;

function resolveHint(value: string | undefined, options: AgentOption[]): string | undefined {
  if (!value) return undefined;
  return options.find((opt) => opt.value === value)?.label ?? value;
}

function buildOpencodeModelOptions(opencodeDefaults: OpencodeDefaults | undefined): AgentOption[] {
  const ids = opencodeDefaults?.availableModels ?? [];
  return ids
    .filter((id) => typeof id === 'string' && SAFE_MODEL_REGEX.test(id))
    .map((id) => ({ value: id, label: id }));
}

function buildOpencodeFallbackChip(opencodeDefaults: OpencodeDefaults | undefined): { label: string; tooltip: string } {
  if (!opencodeDefaults?.model) {
    return { label: 'Default from opencode.json', tooltip: OPENCODE_FALLBACK_TOOLTIP };
  }
  const effortSuffix = opencodeDefaults.effort ? ` · ${opencodeDefaults.effort}` : '';
  const label = `${opencodeDefaults.model}${effortSuffix}`;
  const overrides = opencodeDefaults.modelByMode;
  const overridesLine = overrides && Object.keys(overrides).length > 0
    ? `\nPer-mode overrides: ${Object.entries(overrides).map(([m, v]) => `${m} → ${v}`).join(', ')}`
    : '';
  const tooltip = `Currently uses ${opencodeDefaults.model}${effortSuffix}.\nReads from ~/.config/opencode/opencode.json. Edit that file to change the default.${overridesLine}`;
  return { label, tooltip };
}

export function AgentTuning({
  agent,
  model,
  effort,
  onModelChange,
  onEffortChange,
  defaults,
  opencodeDefaults,
  defaultsLoading,
}: AgentTuningProps) {
  if (!agent) return null;
  const catalog = AGENT_TUNING[agent];
  const isOpencode = agent === 'opencode';
  const opencodeModels = isOpencode ? buildOpencodeModelOptions(opencodeDefaults) : [];
  const modelOptions = isOpencode ? opencodeModels : catalog.models;
  const hasModel = modelOptions.length > 0;
  const hasEffort = catalog.efforts.length > 0;
  const showOpencodeSkeleton = isOpencode && !hasModel && Boolean(defaultsLoading);
  const hasModelChip = !hasModel && !showOpencodeSkeleton && (isOpencode || catalog.modelDisabledChip !== undefined);
  if (!hasModel && !hasEffort && !hasModelChip && !showOpencodeSkeleton) return null;

  const safeModel = isValidOption(modelOptions, model) ? model : undefined;
  const safeEffort = isValidOption(catalog.efforts, effort) ? effort : undefined;
  const modelHintRaw = isOpencode ? opencodeDefaults?.model : defaults?.model;
  const effortHintRaw = isOpencode ? opencodeDefaults?.effort : defaults?.effort;
  const modelHintIsAvailable = !isOpencode || (modelHintRaw !== undefined && modelOptions.some((opt) => opt.value === modelHintRaw));
  const modelHint = modelHintIsAvailable ? resolveHint(modelHintRaw, modelOptions) : undefined;
  const effortHint = resolveHint(effortHintRaw, catalog.efforts);

  const fallbackChip = hasModelChip
    ? isOpencode
      ? buildOpencodeFallbackChip(opencodeDefaults)
      : catalog.modelDisabledChip
    : undefined;
  const showSingleChipFullWidth = (hasModelChip || showOpencodeSkeleton) && !hasEffort;

  return (
    <div className="grid grid-cols-2 gap-2">
      {hasModel && (
        <AgentOptionDropdown
          label="Model"
          icon={<Cpu className="h-3.5 w-3.5" />}
          options={modelOptions}
          value={safeModel}
          onChange={onModelChange}
          placeholder="Default"
          placeholderHint={modelHint}
        />
      )}
      {showOpencodeSkeleton && <ModelLoadingSkeleton fullWidth={showSingleChipFullWidth} />}
      {hasModelChip && fallbackChip && (
        <ModelDefaultChip
          label={fallbackChip.label}
          tooltip={fallbackChip.tooltip}
          fullWidth={showSingleChipFullWidth}
        />
      )}
      {hasEffort && (
        <AgentOptionDropdown
          label={catalog.effortLabel ?? 'Effort'}
          icon={<Gauge className="h-3.5 w-3.5" />}
          options={catalog.efforts}
          value={safeEffort}
          onChange={onEffortChange}
          placeholder={catalog.effortPlaceholder ?? 'Default'}
          placeholderHint={effortHint}
        />
      )}
    </div>
  );
}

function ModelLoadingSkeleton({ fullWidth }: { fullWidth?: boolean }) {
  return (
    <div
      className={cn(
        'flex min-h-[58px] items-center gap-2.5 rounded-xl px-3 py-2.5 opacity-60',
        'border border-[var(--divider)] bg-[color-mix(in_srgb,var(--text)_3%,transparent)]',
        fullWidth && 'col-span-2',
      )}
    >
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] border border-[var(--divider)] bg-[color-mix(in_srgb,var(--text)_4%,transparent)]">
        <Cpu className="h-3.5 w-3.5 text-[var(--text-secondary)]" />
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="text-[10px] font-medium uppercase tracking-wider text-[var(--text-secondary)] leading-none">
          Model
        </span>
        <span
          aria-hidden
          className="block truncate text-[11px] font-medium leading-[1.3] text-[var(--text-muted)] animate-pulse"
        >
          Loading models from opencode.json…
        </span>
      </div>
    </div>
  );
}

function ModelDefaultChip({ label, tooltip, fullWidth }: { label: string; tooltip: string; fullWidth?: boolean }) {
  return (
    <HoverTooltip label={tooltip} enabled>
      <div
        className={cn(
          'flex min-h-[58px] items-center gap-2.5 rounded-xl px-3 py-2.5 cursor-default',
          'border border-[var(--divider)] bg-[color-mix(in_srgb,var(--text)_3%,transparent)]',
          fullWidth && 'col-span-2',
        )}
      >
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] border border-[var(--divider)] bg-[color-mix(in_srgb,var(--text)_4%,transparent)]">
          <Info className="h-3.5 w-3.5 text-[var(--text-secondary)]" />
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="text-[10px] font-medium uppercase tracking-wider text-[var(--text-secondary)] leading-none">
            Model
          </span>
          <span className="block truncate text-[11px] font-semibold leading-[1.3] text-[var(--text)]">
            {label}
          </span>
        </div>
      </div>
    </HoverTooltip>
  );
}
