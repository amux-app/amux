import { useEffect } from 'react';
import type { Theme } from '../../stores';
import { useElectronSettingsStore, useUiStore } from '../../stores';
import { formatPercent } from '../../lib/formatters';
import { ElectronSettingRow } from './ElectronSettingRow';
import { TerminalFontFamilySetting } from './TerminalFontFamilySetting';

export function AppearanceSettings() {
  const theme = useElectronSettingsStore((s) => s.settings?.theme);
  const setUiTheme = useUiStore((s) => s.setTheme);

  useEffect(() => {
    if (theme) {
      setUiTheme(theme as Theme);
    }
  }, [theme, setUiTheme]);

  return (
    <div>
      <h3 className="text-xs font-medium text-[var(--text-muted)] uppercase tracking-wider mb-2">
        Appearance
      </h3>
      <div className="divide-y divide-[var(--border)]">
        <ElectronSettingRow
          settingKey="theme"
          label="Theme"
          description="Color theme for the application"
          type="select"
          options={[
            { value: 'dark', label: 'Dark' },
            { value: 'light', label: 'Light' },
            { value: 'colorful', label: 'Colorful' },
            { value: 'dark-colorful', label: 'Dark Colorful' },
            { value: 'system', label: 'System' },
          ]}
        />
        <TerminalFontFamilySetting />
        <ElectronSettingRow
          settingKey="terminalTheme"
          label="Terminal Theme"
          description="Terminal palette source. Always dark keeps panes dark on light themes"
          type="select"
          options={[
            { value: 'follow', label: 'Follow app theme' },
            { value: 'dark', label: 'Always dark' },
          ]}
        />
        <ElectronSettingRow
          settingKey="terminalFontSize"
          label="Font Size"
          description="Terminal font size in pixels"
          type="number"
          min={8}
          max={24}
          step={1}
        />
        <ElectronSettingRow
          settingKey="uiZoom"
          label="Zoom Level"
          description="Scale the entire UI"
          type="range"
          min={0.8}
          max={1.5}
          step={0.1}
          formatValue={formatPercent}
        />
        <ElectronSettingRow
          settingKey="compactMode"
          label="Compact Mode"
          description="Reduce spacing and padding throughout the UI"
          type="boolean"
        />
      </div>
    </div>
  );
}
