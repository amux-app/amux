import { lazy, Suspense } from 'react';

interface AgentDevtoolsPanelProps {
  paneId: string;
}

const AgentActivityPanel = lazy(async () => {
  const module = await import('./AgentActivityPanel');
  return { default: module.AgentActivityPanel };
});

const TokenUsageDashboard = lazy(async () => {
  const module = await import('./TokenUsageDashboard');
  return { default: module.TokenUsageDashboard };
});

function PanelLoadingState() {
  return (
    <div
      aria-label="Loading panel"
      className="flex h-full items-center justify-center text-xs text-[var(--text-muted)]"
      role="status"
    >
      Loading…
    </div>
  );
}

export function LazyAgentActivityPanel(props: AgentDevtoolsPanelProps) {
  return (
    <Suspense fallback={<PanelLoadingState />}>
      <AgentActivityPanel {...props} />
    </Suspense>
  );
}

export function LazyTokenUsageDashboard(props: AgentDevtoolsPanelProps) {
  return (
    <Suspense fallback={<PanelLoadingState />}>
      <TokenUsageDashboard {...props} />
    </Suspense>
  );
}
