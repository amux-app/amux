const GENERIC_FONT_FAMILIES = new Set([
  'cursive',
  'emoji',
  'fangsong',
  'fantasy',
  'math',
  'monospace',
  'sans-serif',
  'serif',
  'system-ui',
  'ui-monospace',
  'ui-rounded',
  'ui-sans-serif',
  'ui-serif',
]);
const TERMINAL_FONT_WEIGHTS = ['400', '700'] as const;

// document.fonts.load() only fetches @font-face subsets whose unicode-range
// covers a character in the probe text (default is a single space → latin
// subset only). TUIs like Claude Code draw their banners and frames with
// box-drawing (U+2500), block elements (U+2588), and braille (U+2800) glyphs,
// which live in separate subsets. Probing with one character from each range
// forces those subsets to load before xterm paints the first frame, so the
// banner never degrades to ASCII fallback on a cold font cache. The leading
// latin 'W' keeps the primary latin subset in the probe so cold-cache cell
// metrics are still measured on the real font, not a fallback.
const TERMINAL_GLYPH_SUBSET_PROBE = 'W ─█⠀';

export interface TerminalFontLoader {
  load: (font: string, text?: string) => Promise<unknown>;
  ready: Promise<unknown>;
}

export function getTerminalFontFamilies(fontFamily: string): string[] {
  const seen = new Set<string>();
  return splitFontFamilyList(fontFamily)
    .map(normalizeFontFamily)
    .filter((family) => isNamedFontFamily(family, seen));
}

export async function loadTerminalFonts(
  fontFamily: string,
  fontSize: number,
  fontLoader: TerminalFontLoader | null = getDocumentFontLoader(),
): Promise<void> {
  if (!fontLoader) return;
  const families = getTerminalFontFamilies(fontFamily);
  if (families.length === 0) return;

  const fontSizePx = Math.max(1, fontSize);
  const loads = families.flatMap((family) => (
    TERMINAL_FONT_WEIGHTS.map((weight) => (
      fontLoader.load(`${weight} ${fontSizePx}px ${quoteFontFamily(family)}`, TERMINAL_GLYPH_SUBSET_PROBE)
    ))
  ));

  await Promise.allSettled(loads);
  await fontLoader.ready;
}

function getDocumentFontLoader(): TerminalFontLoader | null {
  if (typeof document === 'undefined') return null;
  return document.fonts ?? null;
}

function isNamedFontFamily(family: string, seen: Set<string>): boolean {
  const key = family.toLowerCase();
  if (!family || GENERIC_FONT_FAMILIES.has(key) || seen.has(key)) return false;
  seen.add(key);
  return true;
}

function normalizeFontFamily(fontFamily: string): string {
  const trimmed = fontFamily.trim();
  if (trimmed.length < 2) return trimmed;
  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];
  const isQuoted = (first === '"' || first === "'") && first === last;
  return (isQuoted ? trimmed.slice(1, -1) : trimmed)
    .replace(/\\(["'\\])/g, '$1')
    .trim();
}

function quoteFontFamily(fontFamily: string): string {
  return `"${fontFamily.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function splitFontFamilyList(fontFamily: string): string[] {
  const families: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;

  for (let i = 0; i < fontFamily.length; i += 1) {
    const char = fontFamily[i];
    if (isFontFamilyQuote(char) && !isEscaped(fontFamily, i)) {
      quote = quote === char ? null : quote ?? char;
      current += char;
    } else if (char === ',' && !quote) {
      families.push(current);
      current = '';
    } else {
      current += char;
    }
  }

  families.push(current);
  return families;
}

function isEscaped(value: string, index: number): boolean {
  let slashCount = 0;
  for (let i = index - 1; i >= 0 && value[i] === '\\'; i -= 1) {
    slashCount += 1;
  }
  return slashCount % 2 === 1;
}

function isFontFamilyQuote(char: string): char is '"' | "'" {
  return char === '"' || char === "'";
}
