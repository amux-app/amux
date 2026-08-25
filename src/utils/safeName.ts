export interface NormalizeAsciiNameOptions {
  allowedPunctuation?: string;
  maxLength?: number;
}

function isAsciiLetterOrDigit(character: string): boolean {
  const code = character.charCodeAt(0);
  return (code >= 48 && code <= 57) || (code >= 97 && code <= 122);
}

/**
 * Normalize an uncontrolled name without regular expressions. Invalid runs and
 * repeated hyphens become one separator, and separators are trimmed at both ends.
 */
export function normalizeAsciiName(
  input: string,
  options: NormalizeAsciiNameOptions = {},
): string {
  const allowedPunctuation = new Set(options.allowedPunctuation ?? '');
  const maxLength = options.maxLength ?? Number.MAX_SAFE_INTEGER;
  if (!Number.isSafeInteger(maxLength) || maxLength <= 0) return '';

  let normalized = '';
  let separatorPending = false;

  for (const character of input.toLowerCase()) {
    const allowed = isAsciiLetterOrDigit(character) || allowedPunctuation.has(character);
    if (allowed) {
      if (separatorPending && normalized.length < maxLength) normalized += '-';
      separatorPending = false;
      if (normalized.length < maxLength) normalized += character;
    } else if (normalized.length > 0) {
      separatorPending = true;
    }

    if (normalized.length === maxLength) break;
  }

  return normalized.endsWith('-') ? normalized.slice(0, -1) : normalized;
}
