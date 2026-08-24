import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { EditorDescriptor } from '../../shared/ipc-types.js';

/**
 * Known editors we know how to launch. Each entry lists CLIs we try first
 * (via `which`) and `.app` paths we fall back to on macOS. `command` is what
 * gets passed to `spawn()` when this editor is picked — for `.app` entries
 * we point at the inner binary so files/folders open in a new window rather
 * than the `open(1)` quick-look behaviour.
 */
interface KnownEditor {
  id: string;
  label: string;
  /** CLI binaries to try on PATH, in order. First hit wins. */
  cliNames: string[];
  /** macOS `.app` bundle paths to try if no CLI was found. */
  appPaths?: string[];
  /** Subpath inside an `.app` to the actual executable. */
  appBinarySubpath?: string;
}

const KNOWN_EDITORS: KnownEditor[] = [
  {
    id: 'vscode',
    label: 'VS Code',
    cliNames: ['code', 'code-insiders'],
    appPaths: [
      '/Applications/Visual Studio Code.app',
      '/Applications/Visual Studio Code - Insiders.app',
    ],
    appBinarySubpath: 'Contents/Resources/app/bin/code',
  },
  {
    id: 'cursor',
    label: 'Cursor',
    cliNames: ['cursor'],
    appPaths: ['/Applications/Cursor.app'],
    appBinarySubpath: 'Contents/Resources/app/bin/cursor',
  },
  {
    id: 'windsurf',
    label: 'Windsurf',
    cliNames: ['windsurf'],
    appPaths: ['/Applications/Windsurf.app'],
    appBinarySubpath: 'Contents/Resources/app/bin/windsurf',
  },
  {
    id: 'zed',
    label: 'Zed',
    cliNames: ['zed'],
    appPaths: ['/Applications/Zed.app', '/Applications/Zed Preview.app'],
    appBinarySubpath: 'Contents/MacOS/cli',
  },
  {
    id: 'sublime',
    label: 'Sublime Text',
    cliNames: ['subl'],
    appPaths: ['/Applications/Sublime Text.app'],
    appBinarySubpath: 'Contents/SharedSupport/bin/subl',
  },
  {
    id: 'webstorm',
    label: 'WebStorm',
    cliNames: ['webstorm'],
    appPaths: ['/Applications/WebStorm.app'],
    appBinarySubpath: 'Contents/MacOS/webstorm',
  },
  {
    id: 'idea',
    label: 'IntelliJ IDEA',
    cliNames: ['idea'],
    appPaths: [
      '/Applications/IntelliJ IDEA.app',
      '/Applications/IntelliJ IDEA Ultimate.app',
      '/Applications/IntelliJ IDEA CE.app',
    ],
    appBinarySubpath: 'Contents/MacOS/idea',
  },
  {
    id: 'pycharm',
    label: 'PyCharm',
    cliNames: ['pycharm'],
    appPaths: ['/Applications/PyCharm.app', '/Applications/PyCharm CE.app'],
    appBinarySubpath: 'Contents/MacOS/pycharm',
  },
];

/**
 * Probe PATH for a binary. Returns the absolute path or null. Uses `command -v`
 * which is POSIX and faster than spawning a shell for `which`.
 */
function findOnPath(bin: string): string | null {
  try {
    const out = execFileSync('/bin/sh', ['-c', `command -v ${JSON.stringify(bin)}`], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 1500,
    });
    const resolved = out.trim();
    return resolved && existsSync(resolved) ? resolved : null;
  } catch {
    return null;
  }
}

/**
 * For each known editor, resolve to a single descriptor (or null if not
 * installed). Prefer the CLI on PATH; fall back to the bundled binary inside
 * a known `.app` location.
 */
function detectKnownEditors(): EditorDescriptor[] {
  const found: EditorDescriptor[] = [];
  for (const editor of KNOWN_EDITORS) {
    let command: string | null = null;
    let source: EditorDescriptor['source'] = 'path';

    for (const cli of editor.cliNames) {
      const onPath = findOnPath(cli);
      if (onPath) {
        command = onPath;
        source = 'path';
        break;
      }
    }

    if (!command && editor.appPaths && editor.appBinarySubpath) {
      for (const appPath of editor.appPaths) {
        const inner = `${appPath}/${editor.appBinarySubpath}`;
        if (existsSync(inner)) {
          command = inner;
          source = 'app';
          break;
        }
      }
    }

    if (command) {
      found.push({ id: editor.id, label: editor.label, command, source });
    }
  }
  return found;
}

/**
 * Build the user-facing editor list — detected editors first, then the
 * `$EDITOR` env entry (if set and not already represented), then the
 * historical "System default" fallback so the menu always has at least one
 * usable option.
 */
export function detectAvailableEditors(): EditorDescriptor[] {
  const editors = detectKnownEditors();

  const envEditor = process.env.EDITOR?.trim();
  if (envEditor) {
    // Show $EDITOR explicitly when it isn't already covered by a detected
    // known editor (avoid e.g. listing "code" twice).
    const firstToken = envEditor.split(/\s+/)[0];
    const dupe = editors.some((e) => e.command === envEditor || e.command.endsWith(`/${firstToken}`));
    if (!dupe) {
      editors.push({
        id: 'env',
        label: `$EDITOR (${firstToken})`,
        command: envEditor,
        source: 'env',
      });
    }
  }

  // "System default" always last — guaranteed entry that mirrors the
  // pre-feature behaviour ($EDITOR if set, else `code`). Lets users opt out
  // of the explicit choice without changing flow.
  editors.push({
    id: 'system',
    label: 'System default',
    command: envEditor || 'code',
    source: 'fallback',
  });

  return editors;
}

/**
 * Resolve a renderer-supplied editor id to a trusted descriptor. Unknown or
 * missing ids fall back to the always-present "System default" entry so a
 * renderer can never name an arbitrary executable — only detected editors are
 * ever launched.
 */
export function resolveEditorById(id?: string): EditorDescriptor {
  const editors = detectAvailableEditors();
  const chosen = id ? editors.find((editor) => editor.id === id) : undefined;
  const system = editors.find((editor) => editor.id === 'system');
  return chosen ?? system ?? {
    id: 'system',
    label: 'System default',
    command: process.env.EDITOR?.trim() || 'code',
    source: 'fallback',
  };
}
