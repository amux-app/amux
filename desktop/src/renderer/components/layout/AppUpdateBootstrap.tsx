import { useEffect, useRef } from 'react';
import { useNotificationStore } from '../../stores/notification.store';
import { useUpdateStore } from '../../stores';

export function AppUpdateBootstrap() {
  const initialize = useUpdateStore((state) => state.initialize);
  const snapshot = useUpdateStore((state) => state.snapshot);
  const addToast = useNotificationStore((state) => state.addToast);
  const announcedVersions = useRef(new Set<string>());

  useEffect(() => {
    void initialize();
  }, [initialize]);

  useEffect(() => {
    if (snapshot?.phase !== 'ready' || announcedVersions.current.has(snapshot.availableVersion)) {
      return;
    }
    announcedVersions.current.add(snapshot.availableVersion);
    addToast(`Amux ${snapshot.availableVersion} is ready to install.`, 'info', {
      title: 'Update ready',
    });
  }, [addToast, snapshot]);

  return null;
}
