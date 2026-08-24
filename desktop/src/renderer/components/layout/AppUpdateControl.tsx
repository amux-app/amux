import { CircleArrowUp, CloudDownload, LoaderCircle, X } from 'lucide-react';
import { createPortal } from 'react-dom';
import { useMemo, useRef, useState } from 'react';
import type { AppUpdateSnapshot } from '../../../shared/app-update-types';
import { openExternal } from '../../api/system.api';
import { cn } from '../../lib/cn';
import { useUpdateStore } from '../../stores';
import { HoverTooltip } from '../shared/HoverTooltip';
import { ModalSurface } from '../shared/ModalSurface';

const CONTROL_CLASS = cn(
  'group inline-flex h-8 min-w-8 items-center justify-center gap-1.5 rounded-md px-2',
  'border border-[var(--border)] bg-[var(--surface-raised)] text-[var(--text-secondary)]',
  'transition-colors hover:border-[var(--accent)]/50 hover:text-[var(--accent)]',
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]/70',
  'disabled:cursor-default disabled:opacity-60 [-webkit-app-region:no-drag]',
);

function updateStatus(snapshot: AppUpdateSnapshot): string {
  if (snapshot.phase === 'downloading') {
    return `Downloading Amux ${snapshot.availableVersion} — ${Math.round(snapshot.progress?.percent ?? 0)}%`;
  }
  if (snapshot.phase === 'available') return `Downloading Amux ${snapshot.availableVersion}`;
  if (snapshot.phase === 'ready') return `Update Amux to ${snapshot.availableVersion}`;
  if (snapshot.phase === 'installing') return 'Preparing to restart and update Amux';
  return '';
}

function UpdateProgressRing({ percent }: Readonly<{ percent: number }>) {
  const normalized = Math.max(0, Math.min(100, percent));
  const circumference = 2 * Math.PI * 7;
  return (
    <svg aria-hidden className="absolute h-6 w-6 -rotate-90" viewBox="0 0 18 18">
      <circle
        cx="9"
        cy="9"
        r="7"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        className="opacity-20"
      />
      <circle
        cx="9"
        cy="9"
        r="7"
        fill="none"
        stroke="currentColor"
        strokeDasharray={circumference}
        strokeDashoffset={circumference * (1 - normalized / 100)}
        strokeLinecap="round"
        strokeWidth="1.5"
      />
    </svg>
  );
}

export function AppUpdateControl() {
  const snapshot = useUpdateStore((state) => state.snapshot);
  const installUpdate = useUpdateStore((state) => state.installUpdate);
  const [open, setOpen] = useState(false);
  const [installPending, setInstallPending] = useState(false);
  const laterRef = useRef<HTMLButtonElement>(null);

  const status = useMemo(() => snapshot ? updateStatus(snapshot) : '', [snapshot]);
  if (
    !snapshot
    || (snapshot.phase !== 'available'
      && snapshot.phase !== 'downloading'
      && snapshot.phase !== 'ready'
      && snapshot.phase !== 'installing')
    || !status
  ) return null;

  const downloading = snapshot.phase === 'available' || snapshot.phase === 'downloading';
  const ready = snapshot.phase === 'ready';
  const installing = snapshot.phase === 'installing' || installPending;
  const progress = snapshot.phase === 'downloading' ? snapshot.progress?.percent ?? 0 : 0;

  const handleInstall = async (): Promise<void> => {
    if (!ready || installPending) return;
    setInstallPending(true);
    const accepted = await installUpdate().catch(() => false);
    if (!accepted) setInstallPending(false);
  };

  return (
    <>
      <HoverTooltip label={status} align="end" suppressed={open}>
        <button
          type="button"
          aria-label={status}
          className={cn(CONTROL_CLASS, ready && 'app-update-attention')}
          data-testid="app-update-control"
          disabled={snapshot.phase === 'installing'}
          onClick={() => setOpen(true)}
        >
          <span className="relative inline-flex h-5 w-5 items-center justify-center">
            {snapshot.phase === 'installing' ? (
              <LoaderCircle aria-hidden size={16} strokeWidth={1.5} className="animate-spin" />
            ) : downloading ? (
              <>
                <UpdateProgressRing percent={progress} />
                <CloudDownload aria-hidden size={13} strokeWidth={1.5} />
              </>
            ) : (
              <CircleArrowUp aria-hidden size={17} strokeWidth={1.5} />
            )}
          </span>
          {ready && <span className="hidden text-xs font-medium min-[1000px]:inline">Update</span>}
        </button>
      </HoverTooltip>
      <span role="status" aria-live="polite" className="sr-only">{status}</span>

      {createPortal(<ModalSurface
        initialFocusRef={laterRef}
        label={ready ? 'Amux update ready' : 'Amux update'}
        onClose={() => setOpen(false)}
        open={open}
        panelClassName="w-[min(420px,calc(100vw-2rem))] rounded-lg border border-[var(--border)] bg-[var(--surface)] shadow-2xl"
      >
        <div className="flex items-start justify-between gap-4 border-b border-[var(--border)] px-5 py-4">
          <div>
            <h2 className="text-sm font-semibold text-[var(--text)]">Amux update</h2>
            <p className="mt-1 text-xs text-[var(--text-muted)]">
              {snapshot.currentVersion} → {snapshot.availableVersion}
            </p>
          </div>
          <button
            type="button"
            aria-label="Close update"
            className="rounded-md p-1 text-[var(--text-muted)] hover:bg-[var(--surface-raised)] hover:text-[var(--text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
            onClick={() => setOpen(false)}
          >
            <X aria-hidden size={16} />
          </button>
        </div>
        <div className="px-5 py-4">
          <p className="text-sm text-[var(--text-secondary)]">
            {ready
              ? 'Ready to install. Amux will preserve your open work before restarting.'
              : snapshot.phase === 'downloading'
                ? `Downloading in the background — ${Math.round(progress)}% complete.`
                : installing
                  ? 'Preparing to restart and update Amux.'
                  : 'The update is being prepared in the background.'}
          </p>
        </div>
        <div className="flex justify-end gap-2 border-t border-[var(--border)] px-5 py-3">
          {snapshot.releaseNotesUrl && (
            <button
              type="button"
              className="mr-auto rounded-md px-2 py-1.5 text-xs font-medium text-[var(--accent)] hover:bg-[var(--surface-raised)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
              onClick={() => void openExternal(snapshot.releaseNotesUrl!)}
            >
              View release notes
            </button>
          )}
          <button
            ref={laterRef}
            type="button"
            className="rounded-md px-3 py-1.5 text-xs font-medium text-[var(--text-secondary)] hover:bg-[var(--surface-raised)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
            onClick={() => setOpen(false)}
          >
            Later
          </button>
          {ready && (
            <button
              type="button"
              disabled={installing}
              className="rounded-md bg-[var(--accent)] px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 disabled:opacity-60"
              onClick={() => void handleInstall()}
            >
              {installing ? 'Preparing…' : 'Restart and update'}
            </button>
          )}
        </div>
      </ModalSurface>, document.body)}
    </>
  );
}
