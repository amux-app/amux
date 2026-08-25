import type { SettingDefinition, SettingsScope } from 'muxbase/core';
import { useSettingsStore } from '../../stores';
import { ToggleSwitch } from '../shared/ToggleSwitch';

interface SettingRowProps {
  definition: SettingDefinition;
  scope: SettingsScope;
}

export function SettingRow({ definition, scope }: SettingRowProps) {
  const settings = useSettingsStore((s) => s.settings);
  const updateSetting = useSettingsStore((s) => s.updateSetting);
  const value = settings[definition.key as keyof typeof settings];

  const handleChange = (newValue: unknown) => {
    updateSetting(definition.key, newValue, scope);
  };

  return (
    <div className="flex items-center justify-between gap-6 py-3.5">
      <div className="flex-1 min-w-0">
        <div className="text-sm leading-tight text-[var(--text)]">{definition.label}</div>
        <div className="text-xs leading-snug text-[var(--text-muted)] mt-1">{definition.description}</div>
      </div>
      <div className="shrink-0 flex items-center justify-end w-[220px]">
        {definition.type === 'boolean' && (
          <ToggleSwitch ariaLabel={definition.label} checked={!!value} onChange={(v) => handleChange(v)} />
        )}
        {definition.type === 'select' && definition.options && (
          <select
            aria-label={definition.label}
            value={String(value ?? '')}
            onChange={(e) => handleChange(e.target.value)}
            className="bg-[var(--surface)] border border-[var(--border)] rounded-md px-2.5 py-1.5 text-xs text-[var(--text)] outline-none focus:border-[var(--accent)] w-full"
          >
            {definition.options.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        )}
        {definition.type === 'text' && (
          <input
            aria-label={definition.label}
            type="text"
            value={String(value ?? '')}
            onChange={(e) => handleChange(e.target.value)}
            className="bg-[var(--surface)] border border-[var(--border)] rounded-md px-2.5 py-1.5 text-xs text-[var(--text)] outline-none focus:border-[var(--accent)] w-full"
          />
        )}
        {definition.type === 'action' && (
          <button
            className="px-3 py-1.5 rounded-md text-xs font-medium border border-[var(--border)] text-[var(--text-secondary)] hover:bg-[var(--surface-raised)] transition-colors"
          >
            Open
          </button>
        )}
      </div>
    </div>
  );
}
