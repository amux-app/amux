/**
 * Shell quoting utility — single source of truth.
 *
 * Wraps a value in POSIX-safe single quotes, escaping any embedded
 * single quotes with the '\'' idiom.
 */
export function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
