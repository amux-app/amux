import { useEffect } from 'react';
import * as topicsApi from '../api/topics.api';
import {
  useElectronSettingsStore,
  useProjectStore,
  useTopicsStore,
} from '../stores';

export function useConversationTopicsSync(ready: boolean): void {
  const enabled = useElectronSettingsStore(
    (state) => state.settings?.enableConversationTopics ?? false,
  );
  const activeProject = useProjectStore((state) => state.activeProject);
  const setAll = useTopicsStore((state) => state.setAll);

  useEffect(() => {
    if (!ready) return;
    if (!enabled) {
      setAll([]);
      return;
    }

    setAll([]);
    let cancelled = false;
    void topicsApi.listTopics()
      .then((topics) => {
        if (!cancelled) setAll(topics);
      })
      .catch(() => {
        if (!cancelled) setAll([]);
      });
    return () => {
      cancelled = true;
    };
  }, [activeProject, enabled, ready, setAll]);
}
