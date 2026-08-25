import { useState } from 'react';
import type { AppBootState } from '../../../shared/ipc-types';
import { quitApp, relaunchApp } from '../../api/app.api';

export function AppBootOverlay({ state }: { state: AppBootState }) {
  const [actionPending, setActionPending] = useState(false);
  if (state.phase === 'ready') return null;

  if (state.phase === 'starting') {
    return (
      <div
        aria-label="Starting MuxBase"
        aria-live="polite"
        className="fixed inset-0 z-[100] flex items-center justify-center bg-[var(--bg)]"
        data-testid="app-boot-overlay"
        role="status"
      >
        <span
          aria-hidden="true"
          className="h-6 w-6 animate-spin rounded-full border-2 border-[var(--border)] border-t-[var(--accent)] motion-reduce:animate-none"
        />
      </div>
    );
  }

  const blocked = state.phase === 'blocked';
  const failed = state.phase === 'failed';
  const title = blocked ? 'Startup check needs attention' : 'MuxBase could not finish starting';

  return (
    <div
      aria-live="assertive"
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 backdrop-blur-sm"
      data-testid="app-boot-overlay"
      role="alert"
    >
      <div className="mx-6 w-full max-w-lg rounded-xl border border-[var(--border)] bg-[var(--surface)] p-6 shadow-2xl">
        <div className="flex items-start gap-4">
          <div className="min-w-0">
            <h1 className="text-base font-semibold text-[var(--text)]">{title}</h1>
            {blocked && (
              <>
                <p className="mt-2 text-sm text-[var(--text-secondary)]">
                  Resolve the issue below, then retry startup.
                </p>
                <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-[var(--danger)]">
                  {state.errors.map((error) => <li key={error}>{error}</li>)}
                </ul>
              </>
            )}
            {failed && (
              <p className="mt-2 break-words text-sm text-[var(--danger)]">{state.message}</p>
            )}
            {(blocked || failed) && (
              <div className="mt-5 flex gap-2">
                <button
                  className="rounded-md bg-[var(--accent)] px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
                  disabled={actionPending}
                  onClick={() => {
                    setActionPending(true);
                    void relaunchApp().catch(() => setActionPending(false));
                  }}
                  type="button"
                >
                  Retry startup
                </button>
                <button
                  className="rounded-md border border-[var(--border)] px-3 py-2 text-sm text-[var(--text-secondary)] disabled:opacity-50"
                  disabled={actionPending}
                  onClick={() => {
                    setActionPending(true);
                    void quitApp().catch(() => setActionPending(false));
                  }}
                  type="button"
                >
                  Quit
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
