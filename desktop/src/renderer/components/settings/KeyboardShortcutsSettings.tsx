import { getShortcutGroups } from '../../lib/feature-flags';
import { useElectronSettingsStore } from '../../stores';
import { Kbd } from '../shared/Kbd';

export function KeyboardShortcutsSettings() {
  const electronSettings = useElectronSettingsStore((s) => s.settings);
  const shortcutGroups = getShortcutGroups(electronSettings);

  return (
    <div>
      <h3 className="text-xs font-medium text-[var(--text-muted)] uppercase tracking-wider mb-2">
        Keyboard Shortcuts
      </h3>
      <div className="divide-y divide-[var(--border)]">
        {shortcutGroups.flatMap((g) => g.shortcuts).map((shortcut) => (
          <div key={shortcut.keys} className="flex items-center justify-between py-3 gap-4">
            <span className="text-sm text-[var(--text)]">{shortcut.action}</span>
            <Kbd keys={shortcut.keys} />
          </div>
        ))}
      </div>
    </div>
  );
}
