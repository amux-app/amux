export function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  return window.aumx.invoke<T>(channel, ...args);
}

export function on(channel: string, cb: (...args: unknown[]) => void): () => void {
  return window.aumx.on(channel, cb);
}
