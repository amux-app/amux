import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EditorSelection, EditorState } from '@codemirror/state';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  applyTextChanges,
  formatDocument,
} from '../../src/main/formatter/formatDocument';

describe('formatDocument', () => {
  let rootPath = '';

  beforeEach(async () => {
    rootPath = await mkdtemp(join(tmpdir(), 'muxbase-formatter-'));
    await mkdir(join(rootPath, 'src'));
    await writeFile(join(rootPath, 'src/app.ts'), 'const value={answer:42}\n', 'utf8');
  });

  afterEach(async () => {
    await rm(rootPath, { force: true, recursive: true });
  });

  it('uses project configuration and returns bounded multi-hunk changes', async () => {
    await writeFile(join(rootPath, '.prettierrc.json'), JSON.stringify({
      semi: false,
      singleQuote: true,
    }));
    const content = 'const first="one"\n\nconst second={value:2}\n';

    const result = await formatDocument({
      content,
      eol: 'lf',
      filePath: join(rootPath, 'src/app.ts'),
      projectRoot: rootPath,
    });

    expect(result.kind).toBe('formatted');
    if (result.kind !== 'formatted') throw new Error(`Unexpected result: ${result.kind}`);
    expect(result.changes.length).toBeGreaterThan(1);
    expect(applyTextChanges(content, result.changes)).toBe(
      "const first = 'one'\n\nconst second = { value: 2 }\n",
    );
  });

  it('returns one valid ChangeSet that preserves and maps multiple selections', async () => {
    const content = 'const first="one"\n\nconst second={value:2}\n';
    const result = await formatDocument({
      content,
      eol: 'lf',
      filePath: join(rootPath, 'src/app.ts'),
      projectRoot: rootPath,
    });
    if (result.kind !== 'formatted') throw new Error(`Unexpected result: ${result.kind}`);
    const state = EditorState.create({
      doc: content,
      extensions: [EditorState.allowMultipleSelections.of(true)],
      selection: EditorSelection.create([
        EditorSelection.cursor(0),
        EditorSelection.cursor(content.length),
      ], 1),
    });

    const updated = state.update({ changes: result.changes }).state;

    expect(updated.doc.toString()).toBe(applyTextChanges(content, result.changes));
    expect(updated.selection.ranges.map((range) => range.head)).toEqual([0, updated.doc.length]);
  });

  it('honors the project-root prettier ignore file without resolving config twice', async () => {
    await writeFile(join(rootPath, '.prettierignore'), 'src/app.ts\n', 'utf8');

    await expect(formatDocument({
      content: 'const value={answer:42}\n',
      eol: 'lf',
      filePath: join(rootPath, 'src/app.ts'),
      projectRoot: rootPath,
    })).resolves.toEqual({ kind: 'ignored' });
  });

  it('loads an explicitly configured project plugin', async () => {
    await writeFile(join(rootPath, 'prettier-plugin-foo.mjs'), `
      export const languages = [{ name: 'Foo', parsers: ['foo'], extensions: ['.foo'] }];
      export const parsers = {
        foo: {
          astFormat: 'foo-ast',
          locEnd: (node) => node.value.length,
          locStart: () => 0,
          parse: (text) => ({ type: 'document', value: text }),
        },
      };
      export const printers = {
        'foo-ast': { print: ({ node }) => node.value.toUpperCase() },
      };
    `);
    await writeFile(join(rootPath, '.prettierrc.json'), JSON.stringify({
      parser: 'foo',
      plugins: ['./prettier-plugin-foo.mjs'],
    }));
    const filePath = join(rootPath, 'src/app.foo');

    const result = await formatDocument({
      content: 'plugin works',
      eol: 'lf',
      filePath,
      projectRoot: rootPath,
    });

    expect(result.kind).toBe('formatted');
    if (result.kind !== 'formatted') throw new Error(`Unexpected result: ${result.kind}`);
    expect(applyTextChanges('plugin works', result.changes)).toBe('PLUGIN WORKS');
  });

  it('preserves CRLF when formatting an editor session', async () => {
    const content = 'const value={answer:42}\r\n';

    const result = await formatDocument({
      content,
      eol: 'crlf',
      filePath: join(rootPath, 'src/app.ts'),
      projectRoot: rootPath,
    });

    expect(result.kind).toBe('formatted');
    if (result.kind !== 'formatted') throw new Error(`Unexpected result: ${result.kind}`);
    const formatted = applyTextChanges(content, result.changes);
    expect(formatted).toContain('\r\n');
    expect(formatted.replaceAll('\r\n', '')).not.toContain('\n');
  });

  it('rejects paths outside the authorized project root', async () => {
    await expect(formatDocument({
      content: 'const value=1',
      eol: 'lf',
      filePath: join(rootPath, '../outside.ts'),
      projectRoot: rootPath,
    })).rejects.toThrow('outside the project root');
  });

  it('rejects input above the formatter contract limit', async () => {
    await expect(formatDocument({
      content: 'x'.repeat(1024 * 1024 + 1),
      eol: 'lf',
      filePath: join(rootPath, 'src/app.ts'),
      projectRoot: rootPath,
    })).rejects.toThrow('exceeds 1 MB');
  });
});
