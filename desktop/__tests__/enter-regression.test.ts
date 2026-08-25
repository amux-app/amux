// @vitest-environment happy-dom

import { javascript } from '@codemirror/lang-javascript';
import { EditorSelection, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { afterEach, describe, expect, it } from 'vitest';
import {
  getFileEditorBaseExtensions,
  getFileEditorCompletionExtension,
} from '../src/renderer/components/file-browser/fileEditorSupport';

const views: EditorView[] = [];

afterEach(() => {
  for (const view of views.splice(0)) view.destroy();
  document.body.replaceChildren();
});

function createView(doc: string, selection: EditorSelection): EditorView {
  const parent = document.createElement('div');
  document.body.append(parent);
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      selection,
      extensions: [
        ...getFileEditorBaseExtensions(() => {}),
        getFileEditorCompletionExtension('index.ts'),
        javascript({ typescript: true }),
      ],
    }),
  });
  views.push(view);
  return view;
}

function pressEnter(view: EditorView): void {
  view.focus();
  view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', {
    bubbles: true,
    cancelable: true,
    key: 'Enter',
  }));
}

describe('plain Enter behavior', () => {
  it('auto-indents after an opening brace', () => {
    const view = createView('if (x) {', EditorSelection.cursor(8));

    pressEnter(view);

    expect(view.state.sliceDoc()).toBe('if (x) {\n  ');
  });

  it('splits a brace pair onto three lines', () => {
    const view = createView('if (x) {}', EditorSelection.cursor(8));

    pressEnter(view);

    expect(view.state.sliceDoc()).toBe('if (x) {\n  \n}');
  });
});
