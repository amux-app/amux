export type JsonRecord = Record<string, unknown>;

export function asRecord(value: unknown): JsonRecord | undefined {
  return value && typeof value === 'object' ? (value as JsonRecord) : undefined;
}

/** One JSONL line as an object, or null when it is blank, malformed or not an object. */
export function parseJsonRecord(line: string): JsonRecord | null {
  if (!line.trim()) return null;
  try {
    const parsed: unknown = JSON.parse(line);
    return Array.isArray(parsed) ? null : asRecord(parsed) ?? null;
  } catch {
    return null;
  }
}

export function getString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function getNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function parseIsoTimestamp(value?: string): number | undefined {
  if (!value) return undefined;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : undefined;
}
