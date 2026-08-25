import type { MuxBasePane } from 'muxbase/core';
import { Loader2, SendHorizontal, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { extractReviewFindings, type ReviewFindingsResult } from '../../../shared/review-findings';
import { REVIEW_FINDINGS_PREVIEW_MAX_CHARS } from '../../../shared/review-constants';
import { useAgentSessionStore } from '../../stores/agent-session.store';
import { usePaneActions } from '../../hooks/usePaneActions';

interface SendFixesConfirmDialogProps {
  reviewPane: MuxBasePane;
  onClose: () => void;
}

export function SendFixesConfirmDialog({ reviewPane, onClose }: SendFixesConfirmDialogProps) {
  const { sendFixesToAuthor } = usePaneActions();
  const session = useAgentSessionStore((s) => s.sessions[reviewPane.id]);
  const [submitting, setSubmitting] = useState(false);

  const result = useMemo(() => extractReviewFindings(session ?? null), [session]);

  const tryClose = useCallback(() => {
    if (submitting) return;
    onClose();
  }, [submitting, onClose]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') tryClose();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [tryClose]);

  const handleSend = useCallback(async () => {
    if (submitting) return;
    setSubmitting(true);
    try {
      const response = await sendFixesToAuthor(reviewPane.id);
      if (response?.success) onClose();
    } finally {
      setSubmitting(false);
    }
  }, [submitting, sendFixesToAuthor, reviewPane.id, onClose]);

  const sourceSlug = reviewPane.review?.sourceSlug ?? '(unknown)';
  const reviewer = reviewPane.agent ?? 'reviewer';
  const sendDisabled = submitting || !result || result.kind === 'no-issues';

  return (
    <div
      data-testid="send-fixes-confirm-dialog"
      className="fixed inset-0 z-50 flex items-start justify-center pt-[10vh] bg-black/50 backdrop-blur-sm"
      onClick={tryClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="send-fixes-title"
        className="w-full max-w-2xl mx-4 rounded-xl border border-[var(--border)] bg-[var(--surface)] shadow-2xl overflow-hidden flex flex-col max-h-[80vh]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-4 py-3 border-b border-[var(--border)] shrink-0">
          <span id="send-fixes-title" className="text-[13px] font-semibold text-[var(--text)] flex-1">
            Send review findings to <span className="font-mono text-[var(--accent)]">{sourceSlug}</span>
          </span>
          <button
            onClick={tryClose}
            disabled={submitting}
            aria-label="Close"
            className="p-1 rounded text-[var(--text-muted)] hover:text-[var(--text)] hover:bg-[var(--surface-raised)] transition-colors disabled:opacity-50"
          >
            <X size={14} />
          </button>
        </div>

        <div className="px-4 py-3 border-b border-[var(--border)] text-[11.5px] text-[var(--text-muted)] shrink-0">
          The author's agent will read these findings and may start editing files.
          Review what will be sent before confirming.
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3">
          <PreviewBody session={!!session} result={result} reviewer={reviewer} />
        </div>

        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-[var(--border)] bg-[var(--chrome)] shrink-0">
          <button
            onClick={tryClose}
            disabled={submitting}
            className="px-3 py-1.5 rounded-md border border-[var(--border)] text-[12px] text-[var(--text)] hover:bg-[var(--surface-raised)] disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={handleSend}
            disabled={sendDisabled}
            aria-label="Confirm send fixes"
            className="px-3 py-1.5 rounded-md bg-[var(--accent)] text-[12px] font-semibold text-[var(--accent-contrast)] hover:brightness-110 disabled:opacity-50 disabled:hover:brightness-100 flex items-center gap-1.5"
          >
            {submitting
              ? <><Loader2 size={12} className="animate-spin" /> Sending…</>
              : <><SendHorizontal size={12} /> Send to author</>
            }
          </button>
        </div>
      </div>
    </div>
  );
}

interface PreviewBodyProps {
  session: boolean;
  result: ReviewFindingsResult | undefined;
  reviewer: string;
}

function PreviewBody({ session, result, reviewer }: PreviewBodyProps) {
  if (!session) {
    return (
      <p className="text-[12px] text-[var(--text-muted)] italic">
        Reviewer session preview is not available — findings will be read by the backend when you confirm.
      </p>
    );
  }
  if (!result) {
    return (
      <p className="text-[12px] text-[var(--text-muted)] italic">
        Reviewer is still working — no findings to preview yet.
      </p>
    );
  }

  const isClean = result.kind === 'no-issues';
  const heading = isClean
    ? <>
      <p className="mb-2 font-medium text-[var(--accent)]">Reviewer found no actionable issues.</p>
      <p className="mb-3 text-[12px] text-[var(--text-muted)]">Nothing will be sent to the author.</p>
    </>
    : <p className="mb-2 text-[11px] uppercase tracking-wide font-semibold text-[var(--text-muted)]">Findings from {reviewer}</p>;

  return (
    <div className="text-[12px] text-[var(--text)]">
      {heading}
      <pre className="whitespace-pre-wrap break-words rounded-md border border-[var(--border)] bg-[var(--chrome)] px-3 py-2 font-mono text-[11px] leading-relaxed max-h-[50vh] overflow-y-auto">
        {previewText(result)}
      </pre>
    </div>
  );
}

function previewText(result: ReviewFindingsResult): string {
  const text = result.text;
  if (text.length <= REVIEW_FINDINGS_PREVIEW_MAX_CHARS) return text;
  return `${text.slice(0, REVIEW_FINDINGS_PREVIEW_MAX_CHARS)}\n\n…(${text.length - REVIEW_FINDINGS_PREVIEW_MAX_CHARS} more characters truncated in preview — the full review is sent to the author)`;
}
