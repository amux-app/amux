import type { ReactNode } from 'react';
import { RendererErrorBoundary } from '../shared/RendererErrorBoundary';

interface Props {
  children: ReactNode;
}

export function ActivityErrorBoundary({ children }: Props) {
  return (
    <RendererErrorBoundary
      compact
      description="Retry to remount the activity panel."
      scope="activity-panel"
      title="Activity panel encountered an error"
    >
      {children}
    </RendererErrorBoundary>
  );
}
