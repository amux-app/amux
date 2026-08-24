import { describe, expect, it, vi } from 'vitest';

// The addon's published bundles stall vite-node's module runner, so the base
// provider is stubbed with instrumented values; the real tables are covered
// by the packaged renderer via the terminal E2E suite. charProperties encodes
// (codepoint, preceding) so delegation and borrowing are observable.
vi.mock('@xterm/addon-unicode-graphemes', () => ({
  UnicodeGraphemesAddon: class {
    activate(terminal: { unicode: { register: (provider: unknown) => void } }): void {
      terminal.unicode.register({
        version: '15-graphemes',
        charProperties: (codepoint: number, preceding: number) => codepoint * 1000 + preceding,
        wcwidth: (codepoint: number) => (codepoint === CJK_ONE ? 2 : 1),
      });
    }
  },
}));

import {
  activateTmuxAlignedUnicode,
  createTmuxAlignedUnicodeProvider,
  TERMINAL_UNICODE_VERSION,
} from '../../src/renderer/lib/terminal-unicode';

const NARROW_A = 0x61;
const CJK_ONE = 0x4e00;
const GRINNING_FACE = 0x1f600;
const ORANGE_CIRCLE = 0x1f7e0;
const WOOD = 0x1fab5;
const REGIONAL_INDICATOR_A = 0x1f1e6;

describe('createTmuxAlignedUnicodeProvider', () => {
  it('forces modern emoji wide and delegates everything else to the addon', () => {
    // Arrange
    const provider = createTmuxAlignedUnicodeProvider();

    // Act + Assert: Unicode 12-15 emoji the addon tables miss become wide;
    // ordinary codepoints keep the addon's own answer.
    expect(provider.version).toBe(TERMINAL_UNICODE_VERSION);
    expect(provider.wcwidth(ORANGE_CIRCLE)).toBe(2);
    expect(provider.wcwidth(WOOD)).toBe(2);
    expect(provider.wcwidth(NARROW_A)).toBe(1);
    expect(provider.wcwidth(CJK_ONE)).toBe(2);
  });

  it('borrows the packed properties of a wide pictographic for corrected emoji', () => {
    // Arrange
    const provider = createTmuxAlignedUnicodeProvider();
    const preceding = 7;

    // Act
    const woodProperties = provider.charProperties(WOOD, preceding);
    const narrowProperties = provider.charProperties(NARROW_A, preceding);

    // Assert: corrected emoji answer as U+1F600 would (width and grapheme
    // joining), everything else passes through untouched.
    expect(woodProperties).toBe(GRINNING_FACE * 1000 + preceding);
    expect(narrowProperties).toBe(NARROW_A * 1000 + preceding);
  });

  it('leaves regional indicators on the addon flag-pairing logic', () => {
    // Arrange
    const provider = createTmuxAlignedUnicodeProvider();

    // Act
    const regionalIndicatorProperties = provider.charProperties(REGIONAL_INDICATOR_A, 0);

    // Assert: flags are EAW-neutral and must not be rewritten into
    // pictographics or their two-codepoint pairing would break.
    expect(regionalIndicatorProperties).toBe(REGIONAL_INDICATOR_A * 1000);
  });

  it('is registered and activated on the terminal', () => {
    // Arrange
    const register = vi.fn();
    const terminal = { unicode: { activeVersion: '6', register } };

    // Act
    activateTmuxAlignedUnicode(terminal as never);

    // Assert
    expect(register).toHaveBeenCalledWith(expect.objectContaining({ version: TERMINAL_UNICODE_VERSION }));
    expect(terminal.unicode.activeVersion).toBe(TERMINAL_UNICODE_VERSION);
  });
});
