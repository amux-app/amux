export interface ManagedWindowState<TWindow> {
  manage(window: TWindow): void;
}

export interface DestroyableWindow {
  destroy(): void;
}

export interface PersistableWindowState<TWindow> {
  saveState(window: TWindow): void;
}

export function configureWindowStatePersistence<TWindow>(
  targetWindow: TWindow,
  windowState: ManagedWindowState<TWindow>,
): void {
  // BrowserWindow is already constructed with the saved normal bounds. Do not
  // restore presentation state here: macOS fullscreen transitions can leave a
  // stale flag behind, which would override those bounds on every launch.
  windowState.manage(targetWindow);
}

export function destroyWindowWithPersistedState<TWindow extends DestroyableWindow>(
  targetWindow: TWindow,
  windowState: PersistableWindowState<TWindow>,
): void {
  windowState.saveState(targetWindow);
  targetWindow.destroy();
}
