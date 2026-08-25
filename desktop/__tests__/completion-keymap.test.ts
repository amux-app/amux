// @vitest-environment happy-dom

import {
  startCompletion,
  type CompletionSource,
} from '@codemirror/autocomplete';
import { undo, undoDepth } from '@codemirror/commands';
import { EditorSelection, EditorState, Transaction } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getFileEditorBaseExtensions,
  getFileEditorCompletionExtension,
} from '../src/renderer/components/file-browser/fileEditorSupport';

const views: EditorView[] = [];

afterEach(() => {
  for (const view of views.splice(0)) view.destroy();
  document.body.replaceChildren();
});

function createView(source: CompletionSource): EditorView {
  const parent = document.createElement('div');
  document.body.append(parent);
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: 'd',
      selection: EditorSelection.cursor(1),
      extensions: [
        ...getFileEditorBaseExtensions(() => {}),
        getFileEditorCompletionExtension('index.ts'),
        EditorState.languageData.of(() => [{ autocomplete: source }]),
      ],
    }),
  });
  views.push(view);
  return view;
}

function pressKey(view: EditorView, key: string): void {
  view.focus();
  view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', {
    bubbles: true,
    cancelable: true,
    key,
  }));
}

describe('completion keyboard contract regressions', () => {
  it('inserts a newline when incremental typing reaches an exact no-op completion', async () => {
    const source: CompletionSource = (_context) => ({
      from: 0,
      options: [{ apply: 'dist', label: 'dist', type: 'keyword' }],
      validFor: /\w*/,
    });
    const view = createView(source);

    startCompletion(view);
    await vi.waitFor(() => expect(view.dom.querySelector('[role="listbox"]')).not.toBeNull());
    view.dispatch({
      annotations: Transaction.addToHistory.of(false),
      changes: { from: 1, insert: 'i' },
      selection: { anchor: 2 },
      userEvent: 'input.type',
    });
    view.dispatch({
      annotations: Transaction.addToHistory.of(false),
      changes: { from: 2, insert: 's' },
      selection: { anchor: 3 },
      userEvent: 'input.type',
    });
    view.dispatch({
      annotations: Transaction.addToHistory.of(false),
      changes: { from: 3, insert: 't' },
      selection: { anchor: 4 },
      userEvent: 'input.type',
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const undoDepthBeforeEnter = undoDepth(view.state);
    pressKey(view, 'Enter');

    expect(view.state.sliceDoc()).toBe('dist\n');
    expect(undoDepth(view.state)).toBe(undoDepthBeforeEnter + 1);
    expect(undo(view)).toBe(true);
    expect(view.state.sliceDoc()).toBe('dist');
    expect(undoDepth(view.state)).toBe(undoDepthBeforeEnter);
  });

  it('accepts a selected completion with Tab and indents when no completion is open', async () => {
    const completionSource: CompletionSource = (_context) => ({
      from: 0,
      options: [{ apply: 'distance', label: 'distance', type: 'keyword' }],
      validFor: /\w*/,
    });
    const acceptingView = createView(completionSource);

    startCompletion(acceptingView);
    await vi.waitFor(() => expect(acceptingView.dom.querySelector('[role="listbox"]')).not.toBeNull());
    await new Promise((resolve) => setTimeout(resolve, 100));
    pressKey(acceptingView, 'Tab');
    expect(acceptingView.state.sliceDoc()).toBe('distance');

    const indentView = createView(() => null);
    pressKey(indentView, 'Tab');
    expect(indentView.state.sliceDoc()).toBe('  d');
  });

  it('keeps language-data completion sources composable beside the file-editor extension', async () => {
    let sourceCalls = 0;
    const dummySource: CompletionSource = (context) => {
      sourceCalls += 1;
      return {
        from: context.pos,
        options: [{ label: 'dummy', type: 'keyword' }],
      };
    };
    const parent = document.createElement('div');
    document.body.append(parent);
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: '',
        extensions: [getFileEditorCompletionExtension('index.ts'), EditorState.languageData.of(() => [{ autocomplete: dummySource }])],
      }),
    });
    views.push(view);

    startCompletion(view);
    await vi.waitFor(() => expect(sourceCalls).toBeGreaterThan(0));
  });
});
