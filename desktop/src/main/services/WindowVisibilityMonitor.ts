import type { App, BrowserWindow } from 'electron';

export function monitorWindowVisibility(
  app: App,
  browserWindow: BrowserWindow,
  onVisibilityChange: (visible: boolean) => void,
): () => void {
  let visibilityRecheck: ReturnType<typeof setTimeout> | null = null;
  let visibilityRecheckDeadline = 0;
  let visibilityPoll: ReturnType<typeof setInterval> | null = null;
  let observedVisibility: boolean | null = null;
  let stopped = false;

  const sync = (): void => {
    if (stopped || browserWindow.isDestroyed()) return;
    const visible = browserWindow.isVisible() && !browserWindow.isMinimized();
    if (visible === observedVisibility) return;
    observedVisibility = visible;
    onVisibilityChange(visible);
  };

  const scheduleAppRecheck = (): void => {
    if (stopped) return;
    visibilityRecheckDeadline = Date.now() + 250;
    if (visibilityRecheck) return;

    const recheck = (): void => {
      visibilityRecheck = null;
      sync();
      if (!stopped && Date.now() < visibilityRecheckDeadline) {
        visibilityRecheck = setTimeout(recheck, 50);
      }
    };
    visibilityRecheck = setTimeout(recheck, 0);
  };

  const syncWindowEvent = (): void => {
    sync();
    scheduleAppRecheck();
  };

  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    browserWindow.off('focus', syncWindowEvent);
    browserWindow.off('hide', syncWindowEvent);
    browserWindow.off('minimize', syncWindowEvent);
    browserWindow.off('restore', syncWindowEvent);
    browserWindow.off('show', syncWindowEvent);
    app.off('did-become-active', scheduleAppRecheck);
    app.off('did-resign-active', scheduleAppRecheck);
    browserWindow.off('closed', stop);
    if (visibilityRecheck) clearTimeout(visibilityRecheck);
    if (visibilityPoll) clearInterval(visibilityPoll);
    visibilityRecheck = null;
    visibilityPoll = null;
  };

  browserWindow.on('focus', syncWindowEvent);
  browserWindow.on('hide', syncWindowEvent);
  browserWindow.on('minimize', syncWindowEvent);
  browserWindow.on('restore', syncWindowEvent);
  browserWindow.on('show', syncWindowEvent);
  app.on('did-become-active', scheduleAppRecheck);
  app.on('did-resign-active', scheduleAppRecheck);
  browserWindow.once('closed', stop);
  // macOS can change BrowserWindow.isVisible() through app.hide()/show()
  // without emitting a BrowserWindow or activation event. Keep the observed
  // state authoritative even across those native lifecycle gaps.
  visibilityPoll = setInterval(sync, 250);
  sync();
  return stop;
}
