const DISPLAY_TITLE_GRAPHEME_LIMIT = 48;
const SOURCE_CODE_POINT_LIMIT = 1_000;
const WRAPPER_LIMIT = 4;

const CONTROL_CHARACTERS = /[\p{Cc}\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069\uFEFF]+/gu;
const DECORATIVE_EDGE = /^[\s"'`“”‘’✳✶✷✸✦✧✨★☆•·●◦►▶]+|[\s"'`“”‘’✳✶✷✸✦✧✨★☆•·●◦►▶]+$/gu;
const MARKUP_TAGS = /<\/?(?:code|feedback|goal|plan|prompt|request|task)\b[^>]*>/giu;
const PROVIDER_PLACEHOLDER = /^(?:(?:new|child) session(?:\s*-\s*\d{4}-\d{2}-\d{2}t.+z)?|untitled|title|generating title(?:\.\.\.)?|loading(?:\.\.\.)?)$/iu;
const SYSTEM_REMINDER = /^\s*<system-reminder\b[^>]*>[\s\S]*?<\/system-reminder>\s*/iu;

const LEADING_COMMAND = /^\s*\/(?:goal|plan|task|implement)\b(?:\s+|:\s*)/iu;
const LEADING_MARKDOWN = /^\s*(?:```\w*\s*|#{1,6}\s+|[-*+]\s+)/u;
const TRAILING_FENCE = /\s*```\s*$/u;

const GRAPHEME_SEGMENTER = typeof Intl.Segmenter === 'function'
  ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
  : null;

const REQUEST_WRAPPERS = [
  /^(?:please)\b[\s,:-]*/iu,
  /^(?:can|could|would|will)\s+you\b[\s,:-]*/iu,
  /^(?:i\s+(?:want|need)\s+to|we\s+need\s+to)\b[\s,:-]*/iu,
  /^(?:see|review|check|look\s+at)\s+the\s+following\s+(?:plan|code|feedback|request)\b(?:\s*(?:,|:|-|;)\s*|\s+and\s+)/iu,
  /^(?:see|look\s+at)\s+the\s+following\b[\s,:-]*/iu,
] as const;

function graphemes(value: string): string[] {
  if (GRAPHEME_SEGMENTER) {
    return [...GRAPHEME_SEGMENTER.segment(value)].map(({ segment }) => segment);
  }
  return Array.from(value);
}

function takeCodePoints(value: string, limit: number): string {
  let bounded = '';
  let count = 0;
  for (const codePoint of value) {
    if (count === limit) break;
    bounded += codePoint;
    count++;
  }
  return bounded;
}

function cutAtDisplayBoundary(value: string): string {
  const parts = graphemes(value);
  if (parts.length <= DISPLAY_TITLE_GRAPHEME_LIMIT) return value;

  const head = parts.slice(0, DISPLAY_TITLE_GRAPHEME_LIMIT);
  for (let index = head.length - 1; index >= 0; index--) {
    if (!/^\s$/u.test(head[index])) continue;
    const wordCut = head.slice(0, index).join('').trimEnd();
    if (wordCut) return wordCut;
  }
  return head.join('');
}

function stripDecorativeEdges(value: string): string {
  let current = value;
  let previous = '';
  while (current !== previous) {
    previous = current;
    current = current.replace(DECORATIVE_EDGE, '');
  }
  return current;
}

function cleanPlainText(value: string): string {
  return value
    .replace(CONTROL_CHARACTERS, ' ')
    .replace(MARKUP_TAGS, ' ')
    .replace(/\s+/gu, ' ')
    .replace(/\s+([,.;:!?])/gu, '$1')
    .trim();
}

function isNoiseOnly(value: string): boolean {
  return !/[\p{L}\p{N}_]/u.test(value);
}

/**
 * Shared persistence boundary for all automatic pane-title sources.
 * Manual titles intentionally use their existing validation and lock path.
 */
export function normalizeAutomaticPaneTitle(value: string): string | null {
  const bounded = takeCodePoints(value, SOURCE_CODE_POINT_LIMIT);
  let cleaned = cleanPlainText(bounded);
  cleaned = stripDecorativeEdges(cleaned).trim();
  if (!/\.[\p{L}\p{N}]{1,10}$/u.test(cleaned)) {
    cleaned = cleaned.replace(/[.,;:!?]+$/u, '').trim();
  }
  cleaned = stripDecorativeEdges(cleaned).trim();

  if (!cleaned || isNoiseOnly(cleaned) || PROVIDER_PLACEHOLDER.test(cleaned)) return null;
  return cutAtDisplayBoundary(cleaned);
}

function stripPromptNoise(value: string): string {
  let current = value;
  for (let count = 0; count < WRAPPER_LIMIT; count++) {
    const next = current
      .replace(SYSTEM_REMINDER, '')
      .replace(LEADING_COMMAND, '')
      .replace(LEADING_MARKDOWN, '')
      .trimStart();
    if (next === current) break;
    current = next;
  }
  return current.replace(TRAILING_FENCE, '').trim();
}

function stripRequestWrappers(value: string): string {
  let current = value;
  for (let count = 0; count < WRAPPER_LIMIT; count++) {
    const wrapper = REQUEST_WRAPPERS.find((candidate) => candidate.test(current));
    if (!wrapper) break;
    current = current.replace(wrapper, '').trimStart();
  }
  return current.replace(/^make\s+sure\b[\s,:-]*/iu, 'Ensure ');
}

function preferInformativeClause(value: string): string {
  const boundary = /[.!?;](?=\s|$)|,\s/u;
  const match = boundary.exec(value);
  if (!match || match.index < 18) return value;
  return value.slice(0, match.index);
}

function capitalizeFirstLetter(value: string): string {
  return value.replace(/^\p{L}/u, (letter) => letter.toLocaleUpperCase());
}

/** Creates a synchronous, deterministic display title from a pane prompt. */
export function condenseTitleLocally(source: string): string {
  const bounded = takeCodePoints(source, SOURCE_CODE_POINT_LIMIT);
  const withoutNoise = stripPromptNoise(bounded);
  const plainText = cleanPlainText(withoutNoise);
  const unwrapped = stripRequestWrappers(plainText);
  const candidate = preferInformativeClause(unwrapped);
  const normalized = normalizeAutomaticPaneTitle(candidate);
  return normalized ? capitalizeFirstLetter(normalized) : '';
}
