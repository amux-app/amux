import { useEffect, useRef, useState } from 'react';
import type { ElectronSettings } from '../../../shared/ipc-types';
import { cn } from '../../lib/cn';
import { useElectronSettingsStore } from '../../stores';
import { ToggleSwitch } from '../shared/ToggleSwitch';

const CONTROL_CHROME =
  'bg-[var(--surface)] border border-[var(--border)] rounded-md px-2 py-1.5 text-xs text-[var(--text)] outline-none focus:border-[var(--accent)]';

interface ElectronSettingRowProps {
  settingKey: keyof ElectronSettings;
  label: string;
  description: string;
  type: 'boolean' | 'select' | 'number' | 'text' | 'range';
  badge?: string;
  options?: Array<{ value: string; label: string }>;
  min?: number;
  max?: number;
  step?: number;
  formatValue?: (value: number) => string;
}

export function ElectronSettingRow({ settingKey, label, description, type, badge, options, min, max, step, formatValue }: ElectronSettingRowProps) {
  const settings = useElectronSettingsStore((s) => s.settings);
  const update = useElectronSettingsStore((s) => s.update);

  if (!settings) return null;
  const value = settings[settingKey];

  return (
    <div className="flex items-center justify-between py-3 gap-4">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm text-[var(--text)]">{label}</span>
          {badge && (
            <span className="rounded border border-[var(--border)] px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-[var(--accent)]">
              {badge}
            </span>
          )}
        </div>
        <div className="text-xs text-[var(--text-muted)] mt-0.5">{description}</div>
      </div>
      <div className="shrink-0">
        {type === 'boolean' && (
          <ToggleSwitch
            ariaLabel={label}
            checked={Boolean(value)}
            onChange={(v) => update(settingKey, v as ElectronSettings[typeof settingKey])}
          />
        )}
        {type === 'select' && options && (
          <select
            aria-label={label}
            value={String(value ?? '')}
            onChange={(e) => update(settingKey, e.target.value as ElectronSettings[typeof settingKey])}
            className={cn(CONTROL_CHROME, 'min-w-[140px]')}
          >
            {options.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        )}
        {type === 'text' && (
          <input
            aria-label={label}
            type="text"
            value={String(value ?? '')}
            onChange={(e) => update(settingKey, e.target.value as ElectronSettings[typeof settingKey])}
            className={cn(CONTROL_CHROME, 'w-[200px]')}
          />
        )}
        {type === 'number' && (
          <NumberField
            ariaLabel={label}
            value={Number(value)}
            min={min}
            max={max}
            step={step}
            onCommit={(v) => update(settingKey, v as ElectronSettings[typeof settingKey])}
          />
        )}
        {type === 'range' && (
          <RangeField
            ariaLabel={label}
            value={Number(value)}
            min={min}
            max={max}
            step={step}
            formatValue={formatValue}
            onCommit={(nextValue) => update(
              settingKey,
              nextValue as ElectronSettings[typeof settingKey],
            )}
          />
        )}
      </div>
    </div>
  );
}

interface RangeFieldProps {
  ariaLabel: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  formatValue?: (value: number) => string;
  onCommit: (value: number) => void;
}

function RangeField({ ariaLabel, value, min, max, step, formatValue, onCommit }: RangeFieldProps) {
  const [draft, setDraft] = useState(value);
  const lastCommittedRef = useRef(value);

  useEffect(() => {
    setDraft(value);
    lastCommittedRef.current = value;
  }, [value]);

  const commit = (nextValue: number): void => {
    if (!Number.isFinite(nextValue) || nextValue === lastCommittedRef.current) return;
    lastCommittedRef.current = nextValue;
    onCommit(nextValue);
  };

  return (
    <div className="flex items-center gap-2">
      <input
        aria-label={ariaLabel}
        type="range"
        value={draft}
        min={min}
        max={max}
        step={step}
        onChange={(event) => setDraft(Number(event.currentTarget.value))}
        onBlur={(event) => commit(Number(event.currentTarget.value))}
        onKeyUp={(event) => commit(Number(event.currentTarget.value))}
        onPointerUp={(event) => commit(Number(event.currentTarget.value))}
        className="w-[100px] accent-[var(--accent)]"
      />
      <span className="text-xs text-[var(--text-muted)] min-w-[44px] text-right">
        {formatValue ? formatValue(draft) : draft.toFixed(decimalsForStep(step))}
      </span>
    </div>
  );
}

function decimalsForStep(step?: number): number {
  if (!step || Number.isInteger(step)) return 0;
  return String(step).split('.')[1]?.length ?? 0;
}

interface NumberFieldProps {
  ariaLabel: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  onCommit: (value: number) => void;
}

function NumberField({ ariaLabel, value, min, max, step, onCommit }: NumberFieldProps) {
  const [draft, setDraft] = useState(String(value));

  useEffect(() => {
    setDraft(String(value));
  }, [value]);

  const commit = () => {
    const parsed = Number(draft);
    if (!Number.isFinite(parsed) || parsed === value) {
      setDraft(String(value));
      return;
    }
    onCommit(parsed);
  };

  return (
    <input
      aria-label={ariaLabel}
      type="number"
      value={draft}
      min={min}
      max={max}
      step={step}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
      }}
      className={cn(CONTROL_CHROME, 'w-[80px]')}
    />
  );
}
