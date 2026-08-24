import { EditorSelection, EditorState } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import { computeMinimalDocumentChange } from '../src/renderer/components/file-browser/fileEditorDocumentChange';

describe('computeMinimalDocumentChange', () => {
  it('changes only the divergent middle of an adopted disk document', () => {
    expect(computeMinimalDocumentChange(
      'const answer = 41;\nconst stable = true;\n',
      'const answer = 42;\nconst stable = true;\n',
    )).toEqual({
      from: 16,
      insert: '2',
      to: 17,
    });
  });

  it('preserves a cursor after unchanged suffix text when CodeMirror maps the change', () => {
    const current = 'before\nkeep cursor here\nafter\n';
    const next = 'before changed\nkeep cursor here\nafter\n';
    const cursor = current.indexOf('cursor') + 'cursor'.length;
    const state = EditorState.create({
      doc: current,
      selection: EditorSelection.cursor(cursor),
    });
    const change = computeMinimalDocumentChange(current, next);

    const transaction = state.update({ changes: change ?? undefined });

    expect(transaction.state.doc.toString()).toBe(next);
    expect(transaction.state.sliceDoc(
      transaction.state.selection.main.head - 'cursor'.length,
      transaction.state.selection.main.head,
    )).toBe('cursor');
  });

  it('returns null when no document change is needed', () => {
    expect(computeMinimalDocumentChange('same', 'same')).toBeNull();
  });
});
