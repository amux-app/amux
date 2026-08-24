import { ExternalLink } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';

interface LinkPromptPosition {
  x: number;
  y: number;
}

interface TerminalLinkPromptProps {
  url: string;
  position: LinkPromptPosition;
  onConfirm: () => void;
  onCancel: () => void;
}

const PROMPT_WIDTH = 280;
const VIEWPORT_MARGIN = 8;

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname || url;
  } catch {
    return url;
  }
}

export function TerminalLinkPrompt({ url, position, onConfirm, onCancel }: TerminalLinkPromptProps) {
  const ref = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const [pos, setPos] = useState({ x: position.x, y: position.y });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const x = Math.min(position.x, window.innerWidth - rect.width - VIEWPORT_MARGIN);
    const y = Math.min(position.y, window.innerHeight - rect.height - VIEWPORT_MARGIN);
    setPos({ x: Math.max(VIEWPORT_MARGIN, x), y: Math.max(VIEWPORT_MARGIN, y) });
  }, [position.x, position.y]);

  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  useEffect(() => {
    const onDown = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) onCancel();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCancel();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [onCancel]);

  return (
    <div
      ref={ref}
      role="dialog"
      aria-label="Open external link"
      onClick={(event) => event.stopPropagation()}
      className="fixed z-50 rounded-lg border border-[var(--border)] bg-[var(--surface-raised)] shadow-xl"
      style={{ left: pos.x, top: pos.y, width: PROMPT_WIDTH, animation: 'link-prompt-in 120ms ease forwards' }}
    >
      <style>{'@keyframes link-prompt-in { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: translateY(0); } }'}</style>
      <div className="flex items-start gap-2 px-3 pt-2.5 pb-2">
        <ExternalLink size={13} className="mt-px shrink-0 text-[var(--text-muted)]" />
        <div className="min-w-0">
          <div className="truncate text-[11px] font-semibold text-[var(--text)]">{hostnameOf(url)}</div>
          <div className="mt-0.5 line-clamp-2 break-all text-[10px] text-[var(--text-muted)]">{url}</div>
        </div>
      </div>
      <div className="flex justify-end gap-1.5 border-t border-[var(--border)] px-2.5 py-1.5">
        <button
          ref={cancelRef}
          onClick={onCancel}
          className="rounded-md px-2.5 py-1 text-[11px] font-medium text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface)]"
        >
          Cancel
        </button>
        <button
          onClick={onConfirm}
          className="rounded-md bg-[var(--accent)] px-2.5 py-1 text-[11px] font-medium text-white transition-opacity hover:opacity-90"
        >
          Open link
        </button>
      </div>
    </div>
  );
}
