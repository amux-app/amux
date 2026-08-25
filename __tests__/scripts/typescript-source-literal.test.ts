import { describe, expect, it } from 'vitest';

import { toTypeScriptStringLiteral } from '../../scripts/typescript-source-literal.mjs';

describe('toTypeScriptStringLiteral', () => {
  it('round-trips every template-literal metacharacter as data', () => {
    const value = String.raw`backslash: \\; backtick: \`; interpolation: \${danger}; newline:
done`;

    expect(JSON.parse(toTypeScriptStringLiteral(value))).toBe(value);
  });
});
