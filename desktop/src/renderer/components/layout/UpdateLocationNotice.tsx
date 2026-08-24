import { useState } from 'react';
import { useUpdateStore } from '../../stores';

const DISMISSAL_KEY = 'amux:update-location-notice-dismissed';

function wasDismissed(): boolean {
  try {
    return window.localStorage.getItem(DISMISSAL_KEY) === 'true';
  } catch {
    return false;
  }
}

function persistDismissal(): void {
  try {
    window.localStorage.setItem(DISMISSAL_KEY, 'true');
  } catch {
    // A restricted storage context should not make the notice unusable.
  }
}

export function UpdateLocationNotice() {
  const snapshot = useUpdateStore((state) => state.snapshot);
  const [dismissed, setDismissed] = useState(wasDismissed);
  const wrongLocation = snapshot?.phase === 'disabled'
    && snapshot.disabledReason === 'not-in-applications';

  if (!wrongLocation || dismissed) return null;

  const dismiss = (): void => {
    persistDismissal();
    setDismissed(true);
  };

  return (
    <aside
      aria-label="Automatic update setup"
      className="fixed left-1/2 top-14 z-40 w-[min(560px,calc(100vw-2rem))] -translate-x-1/2 rounded-lg border border-[var(--border)] bg-[var(--surface-raised)] px-4 py-3 shadow-xl [-webkit-app-region:no-drag]"
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-sm font-semibold text-[var(--text)]">
            Move Amux to Applications to enable automatic updates.
          </p>
          <p className="mt-1 text-xs leading-relaxed text-[var(--text-muted)]">
            Quit Amux, drag it to the DMG’s Applications shortcut, eject the DMG, and relaunch Amux.
          </p>
        </div>
        <button
          type="button"
          className="shrink-0 rounded-md px-2 py-1 text-xs font-medium text-[var(--text-secondary)] hover:bg-[var(--surface)] hover:text-[var(--text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
          onClick={dismiss}
        >
          Not now
        </button>
      </div>
    </aside>
  );
}
