import { lazy, Suspense } from 'react';
import type { FileTreeProps } from './file-tree/FileTree';

/** The tree ships the file-type icon sprite, so it is chunked away from the initial renderer entry. */
const FileTree = lazy(async () => {
  const module = await import('./file-tree/FileTree');
  return { default: module.FileTree };
});

export function LazyFileTree({ onFileClick, rootPath }: FileTreeProps) {
  return (
    <Suspense fallback={<FileTreeLoading />}>
      <FileTree onFileClick={onFileClick} rootPath={rootPath} />
    </Suspense>
  );
}

function FileTreeLoading() {
  return (
    <div
      aria-label="Loading files"
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
