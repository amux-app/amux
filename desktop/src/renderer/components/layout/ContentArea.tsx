import type { ReactElement } from 'react';
import { useEffect } from 'react';
import type { ActiveView } from '../../stores/ui.store';
import { useElectronSettingsStore, useUiStore } from '../../stores';
import { isConversationTopicsEnabled } from '../../lib/feature-flags';
import { DashboardView } from '../dashboard/DashboardView';
import { SettingsView } from '../settings/SettingsView';
import { ConversationTopicsView } from '../topics/ConversationTopicsView';

const VIEWS: Record<ActiveView, () => ReactElement> = {
  dashboard: () => <DashboardView />,
  topics: () => <ConversationTopicsView />,
  settings: () => <SettingsView />,
};

export function ContentArea() {
  const activeView = useUiStore((s) => s.activeView);
  const setActiveView = useUiStore((s) => s.setActiveView);
  const electronSettings = useElectronSettingsStore((s) => s.settings);
  const topicsEnabled = isConversationTopicsEnabled(electronSettings);

  useEffect(() => {
    if (activeView === 'topics' && !topicsEnabled) {
      setActiveView('dashboard');
    }
  }, [activeView, topicsEnabled, setActiveView]);

  const safeView: ActiveView = activeView === 'topics' && !topicsEnabled ? 'dashboard' : activeView;
  return <main className="h-full overflow-hidden">{VIEWS[safeView]()}</main>;
}
