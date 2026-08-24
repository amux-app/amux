import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import { cn } from '../../lib/cn';
import { rendererLog } from '../../lib/rendererLog';
import { EmptyState } from './EmptyState';

interface RendererErrorBoundaryProps {
  children: ReactNode;
  className?: string;
  compact?: boolean;
  description: string;
  retryLabel?: string;
  scope: string;
  title: string;
}

interface RendererErrorBoundaryState {
  hasError: boolean;
}

export class RendererErrorBoundary extends Component<RendererErrorBoundaryProps, RendererErrorBoundaryState> {
  state: RendererErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): RendererErrorBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(`[renderer:${this.props.scope}] render error`, error, info.componentStack);
    rendererLog.error(`renderer:${this.props.scope}`, 'Render error boundary caught an error', {
      componentStack: info.componentStack,
      error,
    });
  }

  private handleRetry = (): void => {
    this.setState({ hasError: false });
  };

  render() {
    if (!this.state.hasError) {
      return this.props.children;
    }

    if (this.props.compact) {
      return (
        <div
          className={cn(
            'flex h-full w-full flex-col items-center justify-center gap-2 px-4 text-center',
            this.props.className,
          )}
        >
          <span className="text-xs font-medium text-[var(--text-secondary)]">{this.props.title}</span>
          <span className="max-w-sm text-xs text-[var(--text-muted)]">{this.props.description}</span>
          <button
            onClick={this.handleRetry}
            className="rounded-md border border-[var(--border)] px-3 py-1.5 text-[11px] font-medium text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-raised)]"
          >
            {this.props.retryLabel ?? 'Retry'}
          </button>
        </div>
      );
    }

    return (
      <div className={cn('h-screen w-screen bg-[var(--bg)]', this.props.className)}>
        <EmptyState
          title={this.props.title}
          description={this.props.description}
          action={this.props.retryLabel ?? 'Retry'}
          onAction={this.handleRetry}
        />
      </div>
    );
  }
}
