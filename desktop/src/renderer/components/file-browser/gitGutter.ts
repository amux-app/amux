import { RangeSet, RangeSetBuilder, StateEffect, StateField, type Extension } from '@codemirror/state';
import { EditorView, gutter, GutterMarker } from '@codemirror/view';

export type GitGutterChange = 'added' | 'deleted' | 'modified';

const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

export function parseGitGutterChanges(patch: string): ReadonlyMap<number, GitGutterChange> {
  const changes = new Map<number, GitGutterChange>();
  const lines = patch.split('\n');
  let currentLine = 0;

  for (let index = 0; index < lines.length;) {
    const header = HUNK_HEADER.exec(lines[index] ?? '');
    if (!header) {
      index += 1;
      continue;
    }
    currentLine = Number(header[1]);
    index += 1;

    while (index < lines.length && !HUNK_HEADER.test(lines[index] ?? '')) {
      const line = lines[index] ?? '';
      if (line.startsWith('\\')) {
        index += 1;
        continue;
      }
      if (line.startsWith(' ')) {
        currentLine += 1;
        index += 1;
        continue;
      }
      if (!line.startsWith('+') && !line.startsWith('-')) break;

      const blockLine = currentLine;
      let additions = 0;
      let deletions = 0;
      while (index < lines.length) {
        const block = lines[index] ?? '';
        if (block.startsWith('+')) {
          additions += 1;
          index += 1;
        } else if (block.startsWith('-')) {
          deletions += 1;
          index += 1;
        } else if (block.startsWith('\\')) {
          index += 1;
        } else {
          break;
        }
      }

      const kind: GitGutterChange = deletions > 0 ? 'modified' : 'added';
      for (let offset = 0; offset < additions; offset += 1) {
        changes.set(blockLine + offset, kind);
      }
      if (additions === 0 && deletions > 0) changes.set(Math.max(1, blockLine), 'deleted');
      currentLine += additions;
    }
  }

  return changes;
}

class ChangeMarker extends GutterMarker {
  constructor(private readonly kind: GitGutterChange) {
    super();
  }

  toDOM(): HTMLElement {
    const marker = document.createElement('span');
    marker.className = `muxbase-git-gutter-${this.kind}`;
    marker.setAttribute('aria-hidden', 'true');
    return marker;
  }
}

const MARKERS: Record<GitGutterChange, GutterMarker> = {
  added: new ChangeMarker('added'),
  deleted: new ChangeMarker('deleted'),
  modified: new ChangeMarker('modified'),
};

export const setGitGutterChanges = StateEffect.define<ReadonlyMap<number, GitGutterChange>>();

const gitGutterState = StateField.define({
  create: () => RangeSet.empty,
  update(markers, transaction) {
    for (const effect of transaction.effects) {
      if (!effect.is(setGitGutterChanges)) continue;
      const builder = new RangeSetBuilder<GutterMarker>();
      for (const [lineNumber, kind] of [...effect.value].sort(([left], [right]) => left - right)) {
        const boundedLine = Math.min(Math.max(1, lineNumber), transaction.state.doc.lines);
        builder.add(transaction.state.doc.line(boundedLine).from, transaction.state.doc.line(boundedLine).from, MARKERS[kind]);
      }
      return builder.finish();
    }
    return markers.map(transaction.changes);
  },
});

export function getGitGutterExtension(): Extension {
  return [
    gitGutterState,
    gutter({
      class: 'muxbase-git-gutter',
      markers: (view) => view.state.field(gitGutterState),
    }),
    EditorView.theme({
      '.muxbase-git-gutter': { width: '3px' },
      '.muxbase-git-gutter-added, .muxbase-git-gutter-deleted, .muxbase-git-gutter-modified': {
        display: 'block',
        height: '100%',
        width: '3px',
      },
      '.muxbase-git-gutter-added': { backgroundColor: 'var(--success)' },
      '.muxbase-git-gutter-deleted': { backgroundColor: 'var(--error)' },
      '.muxbase-git-gutter-modified': { backgroundColor: 'var(--warning)' },
    }),
  ];
}
