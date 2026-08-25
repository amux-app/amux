/** Encode arbitrary text as a TypeScript string literal without custom escaping. */
export function toTypeScriptStringLiteral(value) {
  return JSON.stringify(value);
}
