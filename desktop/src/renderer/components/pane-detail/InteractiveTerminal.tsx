import { FindOverlay } from '../shared/FindOverlay';
import { TerminalContextMenu } from './TerminalContextMenu';
import { TerminalOverlays } from './interactive-terminal/TerminalOverlays';
import {
  useTerminalSession,
  type InteractiveTerminalProps,
} from './interactive-terminal/useTerminalSession';
import { TerminalLinkPrompt } from './TerminalLinkPrompt';

export {
  ATTACH_REJECTION_BACKOFF_MS,
  RECONNECTING_NOTICE_DELAY_MS,
  TERMINAL_HIDDEN_DETACH_DELAY_MS,
} from './interactive-terminal/useTerminalSession';

export function InteractiveTerminal(props: InteractiveTerminalProps) {
  const { pane } = props;
  const session = useTerminalSession(props);

  return (
    <div
      className="relative h-full w-full overflow-hidden"
      data-pane-id={pane.id}
      data-testid="interactive-terminal"
      style={session.terminalBackgroundStyle}
    >
      <div
        ref={session.containerRef}
        className="h-full w-full overflow-hidden"
        style={session.terminalBackgroundStyle}
      />

      <TerminalOverlays
        agent={pane.agent}
        agentLabel={session.agentLabel}
        bootPhase={session.bootPhase}
        branchName={pane.branchName}
        failure={session.failure}
        onReconnect={session.reconnectTerminal}
        overlayPalette={session.overlayPalette}
        showBootOverlay={session.showBootOverlay}
        showEmptyState={session.showEmptyState}
      />

      {session.contextMenu && (
        <TerminalContextMenu
          position={session.contextMenu}
          onCopy={session.handleCopy}
          onPaste={session.handlePaste}
          onSelectAll={session.handleSelectAll}
          onClose={session.closeContextMenu}
        />
      )}

      {session.pendingLink && (
        <TerminalLinkPrompt
          url={session.pendingLink.url}
          position={session.pendingLink}
          onConfirm={session.confirmOpenLink}
          onCancel={session.closeLinkPrompt}
        />
      )}

      {session.findOpen && (
        <FindOverlay
          query={session.findQuery}
          onQueryChange={session.setFindQuery}
          matchCount={session.findResult.count}
          matchIndex={session.findResult.index}
          onNext={() => session.runFind('next')}
          onPrev={() => session.runFind('prev')}
          onClose={session.closeFind}
          caseSensitive={session.caseSensitive}
          onToggleCase={session.toggleFindCaseSensitive}
          placeholder="Find in terminal"
        />
      )}
    </div>
  );
}
