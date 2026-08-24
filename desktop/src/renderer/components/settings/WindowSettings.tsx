import { formatPercent } from '../../lib/formatters';
import { ElectronSettingRow } from './ElectronSettingRow';

export function WindowSettings() {
  return (
    <div>
      <h3 className="text-xs font-medium text-[var(--text-muted)] uppercase tracking-wider mb-2">
        Window
      </h3>
      <div className="divide-y divide-[var(--border)]">
        <ElectronSettingRow
          settingKey="alwaysOnTop"
          label="Always on Top"
          description="Keep the window above other applications"
          type="boolean"
        />
        <ElectronSettingRow
          settingKey="windowOpacity"
          label="Window Opacity"
          description="Window opacity — 100% is fully opaque, lower values are more transparent"
          type="range"
          min={0.5}
          max={1.0}
          step={0.05}
          formatValue={formatPercent}
        />
      </div>
    </div>
  );
}
