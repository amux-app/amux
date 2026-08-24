import { describe, expect, it } from 'vitest';
import { normalizeMarkdownForTables } from '../../src/renderer/lib/markdown-table-normalize';

describe('normalizeMarkdownForTables', () => {
  it('returns input unchanged when there is no pipe or backtick', () => {
    // Arrange
    const input = '# heading\n\nplain prose paragraph.';

    // Act
    const result = normalizeMarkdownForTables(input);

    // Assert
    expect(result).toBe(input);
  });

  it('returns input unchanged when a code span contains no pipe', () => {
    // Arrange
    const input = '| col |\n|---|\n| `safe()` |';

    // Act
    const result = normalizeMarkdownForTables(input);

    // Assert
    expect(result).toBe(input);
  });

  it('replaces a literal pipe inside an inline code span on a table row with &#124;', () => {
    // Arrange — GFM splits the cell on the un-escaped pipe inside backticks
    const input = '| a | b |\n|---|---|\n| x | `if (a | b)` |';

    // Act
    const result = normalizeMarkdownForTables(input);

    // Assert
    expect(result).toBe('| a | b |\n|---|---|\n| x | `if (a &#124; b)` |');
  });

  it('replaces a backslash-escaped pipe inside an inline code span with &#124; (strips visible backslash)', () => {
    // Arrange — remark-gfm leaks the backslash inside <code> spans
    const input = '| a | b |\n|---|---|\n| x | `if (a \\|\\| b)` |';

    // Act
    const result = normalizeMarkdownForTables(input);

    // Assert
    expect(result).toBe('| a | b |\n|---|---|\n| x | `if (a &#124;&#124; b)` |');
  });

  it('does NOT touch pipes outside backtick spans', () => {
    // Arrange — table-row pipes are sacred; only pipes INSIDE code spans get rewritten
    const input = '| a | b |\n|---|---|\n| `x` | plain | text |';

    // Act
    const result = normalizeMarkdownForTables(input);

    // Assert
    expect(result).toBe(input);
  });

  it('handles multiple code spans on the same row', () => {
    // Arrange
    const input = '| `a|b` | `c|d` |';

    // Act
    const result = normalizeMarkdownForTables(input);

    // Assert
    expect(result).toBe('| `a&#124;b` | `c&#124;d` |');
  });

  it('handles double-backtick code spans where a single backtick is part of the content', () => {
    // Arrange — markdown allows ``code with ` inside`` via doubled delimiters
    const input = '| ``a|b ` c`` |';

    // Act
    const result = normalizeMarkdownForTables(input);

    // Assert
    expect(result).toBe('| ``a&#124;b ` c`` |');
  });

  it('does not alter code spans on non-table-row lines', () => {
    // Arrange — paragraphs with inline code are untouched
    const input = 'Use `a | b` to combine flags.';

    // Act
    const result = normalizeMarkdownForTables(input);

    // Assert
    expect(result).toBe(input);
  });

  it('preserves the table delimiter row exactly', () => {
    // Arrange — the delimiter line `|---|---|` must not be modified
    const input = '| a | b |\n|---|---|\n| `x|y` | z |';

    // Act
    const result = normalizeMarkdownForTables(input);

    // Assert
    expect(result.split('\n')[1]).toBe('|---|---|');
  });
});
