const pendingNavigationUris = new Set<string>();

export function toFileUri(rootPath: string, relativePath = ''): string {
  const normalizedRoot = rootPath.endsWith('/') ? rootPath : `${rootPath}/`;
  return new URL(relativePath, `file://${normalizedRoot}`).href;
}

export function relativePathFromFileUri(rootPath: string, uri: string): string | null {
  try {
    const rootUrl = toFileUri(rootPath);
    const targetUrl = new URL(uri);
    if (targetUrl.protocol !== 'file:' || !targetUrl.href.startsWith(rootUrl)) return null;
    return decodeURIComponent(targetUrl.pathname.slice(new URL(rootUrl).pathname.length));
  } catch {
    return null;
  }
}

export function markPendingLspNavigation(uri: string): void {
  pendingNavigationUris.add(uri);
}

export function consumePendingLspNavigation(uri: string): boolean {
  return pendingNavigationUris.delete(uri);
}
