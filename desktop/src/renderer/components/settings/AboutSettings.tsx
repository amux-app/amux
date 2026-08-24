import { useEffect, useState } from 'react';
import type { AppInfoResult } from '../../../shared/ipc-types';
import { getAppInfo } from '../../api/system.api';
import { useUpdateStore } from '../../stores';
import { ReadOnlySettingRow } from './ReadOnlySettingRow';

const VERSION_UNAVAILABLE = 'Unavailable';

function formatAppVersion(info: AppInfoResult): string {
  return info.buildNumber ? `${info.version} (${info.buildNumber})` : info.version;
}

export function AboutSettings() {
  const [version, setVersion] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const snapshot = useUpdateStore((state) => state.snapshot);
  const checkForUpdates = useUpdateStore((state) => state.checkForUpdates);

  useEffect(() => {
    let isMounted = true;

    void getAppInfo()
      .then((info) => {
        if (isMounted) {
          setVersion(formatAppVersion(info));
        }
      })
      .catch(() => {
        if (isMounted) {
          setVersion(VERSION_UNAVAILABLE);
        }
      });

    return () => {
      isMounted = false;
    };
  }, []);

  const checkNow = async (): Promise<void> => {
    if (!snapshot || snapshot.phase === 'disabled' || checking) return;
    setChecking(true);
    await checkForUpdates().finally(() => setChecking(false));
  };

  const updatesDisabled = !snapshot || snapshot.phase === 'disabled';
  const wrongLocation = snapshot?.phase === 'disabled'
    && snapshot.disabledReason === 'not-in-applications';
  const status = wrongLocation
    ? 'Automatic updates unavailable — move Amux to Applications'
    : snapshot?.phase === 'checking'
      ? 'Checking for updates…'
      : snapshot?.phase === 'downloading'
        ? `Downloading ${snapshot.availableVersion} — ${Math.round(snapshot.progress?.percent ?? 0)}%`
        : snapshot?.phase === 'ready'
          ? `Amux ${snapshot.availableVersion} is ready to install`
          : snapshot?.phase === 'error' && snapshot.manualCheck
            ? `Update check failed (${snapshot.error.kind})`
            : snapshot?.phase === 'disabled' && snapshot.disabledReason === 'development'
              ? 'Automatic updates are unavailable in development builds'
              : 'Amux checks for stable updates automatically';

  return (
    <div>
      <h3 className="mb-2 text-xs font-medium uppercase tracking-wider text-[var(--text-muted)]">
        About
      </h3>
      <div className="mb-4">
        <div className="text-lg font-semibold text-[var(--text)]">Amux</div>
        <div className="text-xs text-[var(--text-muted)]">
          Manage multiple AI coding agents in parallel.
        </div>
      </div>
      <div className="divide-y divide-[var(--border)]">
        <ReadOnlySettingRow
          label="Version"
          description="Installed app version"
          value={version ?? 'Loading'}
        />
        <div className="py-3">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0 flex-1">
              <div className="text-sm text-[var(--text)]">Updates</div>
              <div className="mt-0.5 text-xs text-[var(--text-muted)]" role="status" aria-live="polite">
                {status}
              </div>
            </div>
            <button
              type="button"
              aria-label="Check for Updates"
              disabled={updatesDisabled || checking || snapshot?.phase === 'checking'}
              className="shrink-0 rounded-md border border-[var(--border)] bg-[var(--surface)] px-2.5 py-1.5 text-xs font-medium text-[var(--text-secondary)] hover:bg-[var(--surface-raised)] hover:text-[var(--text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-50"
              onClick={() => void checkNow()}
            >
              {checking || snapshot?.phase === 'checking' ? 'Checking…' : 'Check for Updates'}
            </button>
          </div>
          {wrongLocation && (
            <p className="mt-2 max-w-2xl text-xs leading-relaxed text-[var(--text-muted)]">
              Quit Amux, drag it to Applications using the DMG shortcut, eject the DMG, and relaunch Amux.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
