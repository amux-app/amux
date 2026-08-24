import { useEffect, useState } from 'react';
import {
  TERMINAL_FONT_FAMILY_OPTIONS,
  type TerminalFontFamilyOption,
} from '../../../shared/terminal-profile';
import { useElectronSettingsStore } from '../../stores';

const CUSTOM_FONT_FAMILY_VALUE = '__custom__';

function hasPresetValue(options: TerminalFontFamilyOption[], value: string): boolean {
  return options.some((option) => option.value === value);
}

export function TerminalFontFamilySetting() {
  const settings = useElectronSettingsStore((s) => s.settings);
  const update = useElectronSettingsStore((s) => s.update);
  const fontFamily = settings?.terminalFontFamily ?? '';
  const isPreset = hasPresetValue(TERMINAL_FONT_FAMILY_OPTIONS, fontFamily);
  const [customMode, setCustomMode] = useState(!isPreset);

  useEffect(() => {
    setCustomMode(!isPreset);
  }, [isPreset]);

  if (!settings) return null;

  const selectedValue = customMode ? CUSTOM_FONT_FAMILY_VALUE : fontFamily;

  return (
    <div className="flex items-start justify-between py-3 gap-4">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm text-[var(--text)]">Font Family</span>
        </div>
        <div className="text-xs text-[var(--text-muted)] mt-0.5">Font used in terminal panes</div>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-2">
        <select
          aria-label="Font Family"
          value={selectedValue}
          onChange={(event) => {
            const value = event.target.value;
            if (value === CUSTOM_FONT_FAMILY_VALUE) {
              setCustomMode(true);
              return;
            }
            setCustomMode(false);
            update('terminalFontFamily', value);
          }}
          className="bg-[var(--surface)] border border-[var(--border)] rounded-md px-2 py-1.5 text-xs text-[var(--text)] outline-none focus:border-[var(--accent)] w-[240px]"
        >
          {TERMINAL_FONT_FAMILY_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
          <option value={CUSTOM_FONT_FAMILY_VALUE}>Custom...</option>
        </select>
        {customMode && (
          <input
            aria-label="Custom font family"
            type="text"
            value={fontFamily}
            onChange={(event) => update('terminalFontFamily', event.target.value)}
            className="bg-[var(--surface)] border border-[var(--border)] rounded-md px-2 py-1.5 text-xs text-[var(--text)] outline-none focus:border-[var(--accent)] w-[240px]"
          />
        )}
      </div>
    </div>
  );
}
