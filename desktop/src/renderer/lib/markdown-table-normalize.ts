/**
 * Normalize markdown so GFM tables render correctly even when cells contain
 * pipe characters inside inline code spans.
 *
 * GitHub-Flavored Markdown's table parser treats `|` as a cell separator
 * before inline parsing runs, so a literal `|` inside an inline `code` span
 * inside a table row splits the row into too many cells. The official escape
 * is `\|`, but `remark-gfm` historically leaks the backslash into the
 * rendered <code>, producing visible `\|` instead of `|`
 * (https://github.com/remarkjs/remark/issues/583,
 * https://github.com/mdx-js/mdx/issues/838).
 *
 * The robust fix is to replace `|` with the HTML entity `&#124;` inside any
 * backtick span that sits on a table row line. The entity round-trips through
 * GFM and remark untouched and renders as a literal pipe in the <code>.
 *
 * We only touch lines that look like table rows (start with `|` and contain
 * at least one more `|`) so prose with code-spans is untouched.
 */
const TABLE_ROW_LINE = /^\s*\|.*\|\s*$/;

export function normalizeMarkdownForTables(input: string): string {
  if (!input.includes('|') || !input.includes('`')) return input;

  return input
    .split('\n')
    .map((line) => (TABLE_ROW_LINE.test(line) ? escapePipesInBacktickSpans(line) : line))
    .join('\n');
}

function escapePipesInBacktickSpans(line: string): string {
  // Walk the line, toggling between "outside code" and "inside code" on every
  // backtick run. While inside, replace `|` with `&#124;` and strip any
  // backslash that immediately precedes a pipe (the GFM escape that
  // remark-gfm leaks visibly inside code spans).
  let result = '';
  let inCode = false;
  let runDelim = '';
  let i = 0;
  while (i < line.length) {
    const char = line[i];
    if (char === '`') {
      const run = readBacktickRun(line, i);
      if (!inCode) {
        inCode = true;
        runDelim = run;
      } else if (run === runDelim) {
        inCode = false;
        runDelim = '';
      }
      result += run;
      i += run.length;
      continue;
    }
    if (inCode && char === '|') {
      result += '&#124;';
      i += 1;
      continue;
    }
    if (inCode && char === '\\' && line[i + 1] === '|') {
      result += '&#124;';
      i += 2;
      continue;
    }
    result += char;
    i += 1;
  }
  return result;
}

function readBacktickRun(line: string, start: number): string {
  let end = start;
  while (end < line.length && line[end] === '`') end += 1;
  return line.slice(start, end);
}
