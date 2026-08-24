import { lazy, Suspense } from 'react';

const FileViewer = lazy(async () => {
  const module = await import('./FileViewer');
  return { default: module.FileViewer };
});

export function LazyFileViewer({ onClose }: { onClose?: () => void }) {
  return (
    <Suspense fallback={<FileViewerLoading />}>
      <FileViewer onClose={onClose} />
    </Suspense>
  );
}

function FileViewerLoading() {
  return (
    <div
      aria-label="Loading file"
      className="flex h-full items-center justify-center bg-[var(--surface)]"
      role="status"
    >
      <span
        aria-hidden="true"
        className="h-5 w-5 animate-spin rounded-full border-2 border-[var(--border)] border-t-[var(--accent)] motion-reduce:animate-none"
      />
    </div>
  );
}
