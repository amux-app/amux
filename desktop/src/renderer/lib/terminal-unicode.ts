import { UnicodeGraphemesAddon } from '@xterm/addon-unicode-graphemes';
import type { Terminal } from '@xterm/xterm';
import { eastAsianWidthType } from 'get-east-asian-width';

export const TERMINAL_UNICODE_VERSION = '15-graphemes-tmux';

const BASE_PROVIDER_VERSION = '15-graphemes';
const EMOJI_PLANE_START = 0x1f000;
const WIDE_PICTOGRAPHIC_REFERENCE = 0x1f600;

interface GraphemeUnicodeProvider {
  readonly version: string;
  charProperties(codepoint: number, preceding: number): number;
  wcwidth(codepoint: number): number;
}

interface UnicodeProviderRegistry {
  unicode: {
    activeVersion: string;
    register(provider: GraphemeUnicodeProvider): void;
  };
}

function isModernWideEmoji(codepoint: number): boolean {
  return codepoint >= EMOJI_PLANE_START && eastAsianWidthType(codepoint) === 'wide';
}

/**
 * The unicode-graphemes addon (0.4.x, latest for xterm 6.0) ships width
 * tables that predate the Unicode 12-15 emoji additions, while tmux measures
 * them as wide — every line containing e.g. a status circle or a newer emoji
 * would render one cell short and break TUI box borders. This provider
 * delegates to the addon and corrects only the supplementary emoji plane,
 * sourcing widths from Unicode's own East Asian Width data. Regional
 * indicators are EAW-neutral, so flag pairing stays on the addon's logic.
 * Retire once the addon ships current tables (0.5.x, xterm 6.1).
 */
class TmuxAlignedGraphemeProvider implements GraphemeUnicodeProvider {
  readonly version = TERMINAL_UNICODE_VERSION;

  constructor(private readonly base: GraphemeUnicodeProvider) {}

  charProperties(codepoint: number, preceding: number): number {
    if (isModernWideEmoji(codepoint)) {
      // Borrow the packed properties of a known wide pictographic so width
      // AND grapheme-join behavior match what tmux renders.
      return this.base.charProperties(WIDE_PICTOGRAPHIC_REFERENCE, preceding);
    }
    return this.base.charProperties(codepoint, preceding);
  }

  wcwidth(codepoint: number): number {
    if (isModernWideEmoji(codepoint)) return 2;
    return this.base.wcwidth(codepoint);
  }
}

export function createTmuxAlignedUnicodeProvider(): GraphemeUnicodeProvider {
  const captured: GraphemeUnicodeProvider[] = [];
  const captureRegistry: UnicodeProviderRegistry = {
    unicode: {
      activeVersion: '',
      register: (provider) => captured.push(provider),
    },
  };
  new UnicodeGraphemesAddon().activate(captureRegistry as unknown as Terminal);
  const base = captured.find((provider) => provider.version === BASE_PROVIDER_VERSION);
  if (!base) {
    throw new Error(`unicode provider ${BASE_PROVIDER_VERSION} was not registered by the graphemes addon`);
  }
  return new TmuxAlignedGraphemeProvider(base);
}

export function activateTmuxAlignedUnicode(terminal: Terminal): void {
  const registry = terminal as unknown as UnicodeProviderRegistry;
  registry.unicode.register(createTmuxAlignedUnicodeProvider());
  registry.unicode.activeVersion = TERMINAL_UNICODE_VERSION;
}
