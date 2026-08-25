import type { MuxBasePane } from 'muxbase/core';
import { lazy, Suspense } from 'react';

const GitDiffView = lazy(async () => {
  const module = await import('./GitDiffView');
  return { default: module.GitDiffView };
});

export function LazyGitDiffView({ pane }: { pane: MuxBasePane }) {
  return (
    <Suspense fallback={<GitDiffLoading />}>
      <GitDiffView pane={pane} />
    </Suspense>
  );
}

function GitDiffLoading() {
  return (
    <div
      aria-label="Loading diff"
      className="flex h-full items-center justify-center bg-[var(--bg)]"
      role="status"
    >
      <span
        aria-hidden="true"
        className="h-5 w-5 animate-spin rounded-full border-2 border-[var(--border)] border-t-[var(--accent)] motion-reduce:animate-none"
      />
    </div>
  );
}
