/**
 * Insertion-order LRU with a hard entry cap: a read moves its key to the tail, an
 * insert drops keys from the head until the cache fits. Keeps long-lived
 * main-process caches from retaining every path the app has ever looked at.
 */
export class BoundedCache<T> {
  private readonly entries = new Map<string, T>();

  constructor(private readonly maxEntries: number) {}

  get size(): number {
    return this.entries.size;
  }

  get(key: string): T | undefined {
    const value = this.entries.get(key);
    if (value === undefined) return undefined;

    this.entries.delete(key);
    this.entries.set(key, value);
    return value;
  }

  set(key: string, value: T): void {
    this.entries.delete(key);
    this.entries.set(key, value);
    this.evictOverflow();
  }

  delete(key: string): void {
    this.entries.delete(key);
  }

  /** Removes an entry and hands back its value, so callers can release chained keys. */
  take(key: string): T | undefined {
    const value = this.entries.get(key);
    this.entries.delete(key);
    return value;
  }

  clear(): void {
    this.entries.clear();
  }

  private evictOverflow(): void {
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) return;
      this.entries.delete(oldest);
    }
  }
}
