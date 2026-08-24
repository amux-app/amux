import { AlertTriangle, Loader2, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { SupportBundlePreview } from '../../../shared/ipc-types';
import { exportSupportBundle, previewSupportBundle, revealPath } from '../../api/system.api';
import { rendererLog } from '../../lib/rendererLog';

interface SupportBundleDialogProps {
  onClose: () => void;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(1)} ${units[unitIndex]}`;
}

export function SupportBundleDialog({ onClose }: SupportBundleDialogProps) {
  const [includeTranscripts, setIncludeTranscripts] = useState(false);
  const [preview, setPreview] = useState<SupportBundlePreview | null>(null);
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    let mounted = true;
    setPreview(null);
    previewSupportBundle(includeTranscripts)
      .then((result) => {
        if (mounted) setPreview(result);
      })
      .catch((error) => {
        rendererLog.warn('settings', 'Failed to preview support bundle', { error });
      });
    return () => {
      mounted = false;
    };
  }, [includeTranscripts]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !exporting) onClose();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [exporting, onClose]);

  const handleExport = () => {
    if (exporting) return;
    setExporting(true);
    exportSupportBundle(includeTranscripts)
      .then((bundle) => revealPath(bundle.path))
      .then(onClose)
      .catch((error) => {
        rendererLog.warn('settings', 'Failed to export support bundle', { error });
        setExporting(false);
      });
  };

  return (
    <div
      data-testid="support-bundle-dialog"
      className="fixed inset-0 z-50 flex items-start justify-center pt-[10vh] bg-black/50 backdrop-blur-sm"
      onClick={() => !exporting && onClose()}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="support-bundle-title"
        className="w-full max-w-lg mx-4 rounded-xl border border-[var(--border)] bg-[var(--surface)] shadow-2xl overflow-hidden flex flex-col max-h-[80vh]"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-4 py-3 border-b border-[var(--border)] shrink-0">
          <span id="support-bundle-title" className="text-[13px] font-semibold text-[var(--text)] flex-1">
            Export support bundle
          </span>
          <button
            onClick={onClose}
            disabled={exporting}
            aria-label="Close"
            className="p-1 rounded text-[var(--text-muted)] hover:text-[var(--text)] hover:bg-[var(--surface-raised)] transition-colors disabled:opacity-50"
          >
            <X size={14} />
          </button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3 flex flex-col gap-3">
          <PreviewSummary preview={preview} />

          <label className="flex items-start gap-2 text-[12px] text-[var(--text)] cursor-pointer">
            <input
              type="checkbox"
              checked={includeTranscripts}
              onChange={(event) => setIncludeTranscripts(event.target.checked)}
              className="mt-0.5 accent-[var(--accent)]"
            />
            <span>
              Include terminal transcripts
              <span className="block text-[11px] text-[var(--text-muted)]">
                Full agent terminal output. Off by default — transcripts can contain code and secrets.
              </span>
            </span>
          </label>

          <div className="flex items-start gap-2 rounded-md border border-[var(--warning,#b7791f)] bg-[var(--warning-bg,rgba(183,121,31,0.1))] px-3 py-2 text-[11.5px] text-[var(--text)]">
            <AlertTriangle size={14} className="mt-0.5 shrink-0 text-[var(--warning,#b7791f)]" />
            <span>
              Paths and detected credentials are redacted on a best-effort basis. Review the archive before sharing — it may still contain sensitive paths, code, or secrets.
            </span>
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-[var(--border)] bg-[var(--chrome)] shrink-0">
          <button
            onClick={onClose}
            disabled={exporting}
            className="px-3 py-1.5 rounded-md border border-[var(--border)] text-[12px] text-[var(--text)] hover:bg-[var(--surface-raised)] disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={handleExport}
            disabled={exporting || !preview}
            aria-label="Export bundle"
            className="px-3 py-1.5 rounded-md bg-[var(--accent)] text-[12px] font-semibold text-[var(--accent-contrast)] hover:brightness-110 disabled:opacity-50 flex items-center gap-1.5"
          >
            {exporting ? <><Loader2 size={12} className="animate-spin" /> Exporting…</> : 'Export bundle'}
          </button>
        </div>
      </div>
    </div>
  );
}

function PreviewSummary({ preview }: { preview: SupportBundlePreview | null }) {
  if (!preview) {
    return <p className="text-[12px] text-[var(--text-muted)] italic">Preparing preview…</p>;
  }
  return (
    <p className="text-[12px] text-[var(--text)]">
      {preview.files.length} file{preview.files.length === 1 ? '' : 's'} · {formatBytes(preview.totalBytes)} total
    </p>
  );
}
