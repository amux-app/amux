export function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  return window.muxbase.invoke<T>(channel, ...args);
}

export function on(channel: string, cb: (...args: unknown[]) => void): () => void {
  return window.muxbase.on(channel, cb);
}
