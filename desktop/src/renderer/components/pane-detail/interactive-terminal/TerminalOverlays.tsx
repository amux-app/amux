import { RefreshCw, WifiOff } from 'lucide-react';
import { cn } from '../../../lib/cn';
import {
  getTerminalFailureTitle,
  type TerminalFailure,
  type TerminalOverlayPalette,
} from './terminal-model';

interface TerminalOverlaysProps {
  agent?: string;
  agentLabel: string;
  bootPhase: number;
  branchName?: string;
  failure: TerminalFailure | null;
  onReconnect: () => void;
  overlayPalette: TerminalOverlayPalette;
  showBootOverlay: boolean;
  showEmptyState: boolean;
}

export function TerminalOverlays({
  agent,
  agentLabel,
  bootPhase,
  branchName,
  failure,
  onReconnect,
  overlayPalette,
  showBootOverlay,
  showEmptyState,
}: TerminalOverlaysProps) {
  const phaseText =
    bootPhase === 0 ? 'Initializing workspace...'
    : bootPhase === 1 ? `Starting ${agentLabel}...`
    : bootPhase === 2 ? (agent === 'claude' ? 'Loading MCP servers...' : `Waiting for ${agentLabel}...`)
    : `${agentLabel} is taking longer than usual...`;
  const isReconnecting = failure?.kind === 'reconnecting';

  return (
    <>
      <div
        aria-atomic={showBootOverlay ? 'true' : undefined}
        aria-hidden={!showBootOverlay}
        aria-live={showBootOverlay ? 'polite' : undefined}
        data-testid="terminal-boot-overlay"
        data-booting={showBootOverlay ? 'true' : 'false'}
        role={showBootOverlay ? 'status' : undefined}
        className={[
          'pointer-events-none absolute inset-0 flex flex-col items-center justify-center transition-opacity duration-300 motion-reduce:transition-none',
          showBootOverlay ? 'opacity-100' : 'opacity-0',
        ].join(' ')}
      >
        <div className="relative mb-3" style={{ width: 30, height: 30 }}>
          <div
            className="absolute inset-0 rounded-full border-2 border-transparent animate-spin motion-reduce:animate-none"
            style={{
              borderTopColor: overlayPalette.accent,
              animationDuration: '1.2s',
            }}
          />
          <div
            className="absolute rounded-full border-2 border-transparent animate-spin motion-reduce:animate-none"
            style={{
              inset: 4,
              borderTopColor: overlayPalette.muted,
              animationDuration: '2s',
              animationDirection: 'reverse',
            }}
          />
        </div>

        <div className="text-xs font-medium" style={{ color: overlayPalette.foreground }}>{agentLabel}</div>
        <div className="mt-0.5 text-[11px]" style={{ color: overlayPalette.muted }}>{phaseText}</div>

        <div
          className="mt-2.5 h-0.5 w-24 overflow-hidden rounded-full"
          style={{ backgroundColor: overlayPalette.track }}
        >
          <div
            className="terminal-boot-shimmer h-full w-1/3 rounded-full motion-reduce:animate-none"
            style={{
              background: `linear-gradient(90deg, transparent, ${overlayPalette.accent}, transparent)`,
              animation: 'boot-shimmer 1.8s ease-in-out infinite',
            }}
          />
        </div>
      </div>

      {showEmptyState && (
        <div
          data-testid="terminal-empty-state"
          className="pointer-events-none absolute inset-x-0 top-1/2 flex -translate-y-1/2 flex-col items-center gap-1 px-6 text-center opacity-70"
        >
          <div className="text-[11px] font-medium" style={{ color: overlayPalette.muted }}>
            {branchName || 'Ready'}
          </div>
          <div className="text-[11px]" style={{ color: overlayPalette.muted }}>
            Send your first prompt to get started
          </div>
        </div>
      )}

      {failure && (
        <div
          // Remount on kind change: screen readers may not re-announce a live
          // region whose role flips on an existing node.
          key={failure.kind}
          className={cn(
            'absolute right-3 top-3 z-30 max-w-[min(320px,calc(100%-24px))] rounded-lg border border-[var(--border)] bg-[var(--surface-raised)] p-3 shadow-xl',
            isReconnecting && 'pointer-events-none',
          )}
          data-testid="terminal-failure-card"
          role={isReconnecting ? 'status' : 'alert'}
        >
          <div className="flex items-start gap-2">
            {isReconnecting ? (
              <RefreshCw
                size={14}
                className="mt-0.5 shrink-0 animate-spin text-[var(--text-secondary)] motion-reduce:animate-none"
              />
            ) : (
              <WifiOff size={14} className="mt-0.5 shrink-0 text-[var(--text-secondary)]" />
            )}
            <div className="min-w-0">
              <div className="text-xs font-semibold text-[var(--text)]">
                {getTerminalFailureTitle(failure.kind)}
              </div>
              <div className="mt-1 line-clamp-2 break-words text-[11px] text-[var(--text-secondary)]">
                {failure.message}
              </div>
            </div>
          </div>
          {!isReconnecting && (
            <div className="mt-2 flex justify-end">
              <button
                aria-label="Reconnect terminal"
                onClick={onReconnect}
                className="inline-flex items-center gap-1.5 rounded-md bg-[var(--accent)] px-2.5 py-1 text-[11px] font-medium text-[var(--accent-contrast)] transition-opacity hover:opacity-90"
              >
                <RefreshCw size={12} />
                Reconnect
              </button>
            </div>
          )}
        </div>
      )}
    </>
  );
}
