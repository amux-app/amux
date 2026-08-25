import { Compartment, EditorState } from '@codemirror/state';
import { openSearchPanel } from '@codemirror/search';
import { EditorView, keymap } from '@codemirror/view';
import { useEffect, useRef } from 'react';
import type {
  FileEol,
  FileWriteResponse,
} from '../../../shared/ipc-types';
import { writeFileContent } from '../../api/file.api';
import { getFileDiff } from '../../api/git.api';
import { rendererLog } from '../../lib/rendererLog';
import { EditorSession, type EditorSessionStatus } from './EditorSession';
import {
  getFileEditorBaseExtensions,
  getFileEditorCompletionExtension,
  loadFileEditorLanguageExtension,
  loadFileEditorLintExtension,
  getFileEditorReadOnlyExtension,
  getFileEditorSearchExtension,
  getFileEditorWordWrapExtension,
} from './fileEditorSupport';
import { computeMinimalDocumentChange } from './fileEditorDocumentChange';
import {
  getGitGutterExtension,
  parseGitGutterChanges,
  setGitGutterChanges,
} from './gitGutter';
import { consumePendingLspNavigation, toFileUri } from './lspNavigation';

interface CodeMirrorEditorProps {
  content: string;
  contentVersion?: string;
  eol?: FileEol;
  enableCompletion?: boolean;
  enableLint?: boolean;
  fileKey: string;
  fileName: string;
  hasBom?: boolean;
  highlightQuery?: string;
  openSearchPanelRequestKey: number;
  readOnly?: boolean;
  relativePath: string;
  rootPath: string;
  scrollToLine?: number;
  wordWrap: boolean;
  onConflict?: (response: Extract<FileWriteResponse, { success: false }>) => void;
  onError?: (error: unknown) => void;
  onFormatDocument?: () => void;
  onLanguageIntelligenceStatus?: (status: LanguageIntelligenceStatus, detail?: string) => void;
  onSaved?: (content: string, response: Extract<FileWriteResponse, { success: true }>) => void;
  onSessionReady?: (session: EditorSession | null) => void;
  onStatusChange?: (status: EditorSessionStatus) => void;
}

export type LanguageIntelligenceStatus = 'idle' | 'ready' | 'starting' | 'syntax-only' | 'unavailable';

interface CreateEditorStateOptions {
  completionCompartment: Compartment;
  content: string;
  fileName: string;
  highlightQuery?: string;
  languageCompartment: Compartment;
  lintCompartment: Compartment;
  gitGutterCompartment: Compartment;
  lspCompartment: Compartment;
  lineSeparator: string;
  onDocumentChange: () => void;
  onFormatDocument: () => void;
  onLanguageIntelligenceRequest: () => void;
  readOnly: boolean;
  readOnlyCompartment: Compartment;
  relativePath: string;
  rootPath: string;
  searchCompartment: Compartment;
  wordWrap: boolean;
  wordWrapCompartment: Compartment;
}

const CODE_MIRROR_LOG_SCOPE = 'file-editor';
const LINE_SEPARATOR_BY_EOL: Record<FileEol, string> = {
  cr: '\r',
  crlf: '\r\n',
  lf: '\n',
};

function elapsedMs(startedAt: number): number {
  return Math.round(performance.now() - startedAt);
}

function createEditorState({
  completionCompartment,
  content,
  fileName,
  highlightQuery,
  languageCompartment,
  lintCompartment,
  gitGutterCompartment,
  lspCompartment,
  lineSeparator,
  onDocumentChange,
  onFormatDocument,
  onLanguageIntelligenceRequest,
  readOnly,
  readOnlyCompartment,
  relativePath,
  rootPath,
  searchCompartment,
  wordWrap,
  wordWrapCompartment,
}: CreateEditorStateOptions): EditorState {
  return EditorState.create({
    doc: content,
    extensions: [
      ...getFileEditorBaseExtensions(onDocumentChange, lineSeparator),
      languageCompartment.of([]),
      lintCompartment.of([]),
      gitGutterCompartment.of([]),
      lspCompartment.of([]),
      completionCompartment.of(getFileEditorCompletionExtension(fileName, rootPath, relativePath)),
      wordWrapCompartment.of(getFileEditorWordWrapExtension(wordWrap)),
      searchCompartment.of(getFileEditorSearchExtension(highlightQuery)),
      readOnlyCompartment.of(getFileEditorReadOnlyExtension(readOnly)),
      keymap.of([{
        key: 'Shift-Alt-f',
        run: () => {
          onFormatDocument();
          return true;
        },
      }, {
        key: 'Ctrl-Space',
        run: () => {
          onLanguageIntelligenceRequest();
          return false;
        },
      }, {
        key: 'F12',
        run: () => {
          onLanguageIntelligenceRequest();
          return false;
        },
      }, {
        key: 'Shift-F12',
        run: () => {
          onLanguageIntelligenceRequest();
          return false;
        },
      }]),
    ],
  });
}

export function CodeMirrorEditor({
  content,
  contentVersion,
  eol = 'lf',
  enableCompletion = true,
  enableLint = true,
  fileKey,
  fileName,
  hasBom = false,
  highlightQuery,
  openSearchPanelRequestKey,
  readOnly = false,
  relativePath,
  rootPath,
  scrollToLine,
  wordWrap,
  onConflict,
  onError,
  onFormatDocument,
  onLanguageIntelligenceStatus,
  onSaved,
  onSessionReady,
  onStatusChange,
}: CodeMirrorEditorProps) {
  const completionCompartmentRef = useRef(new Compartment());
  const containerRef = useRef<HTMLDivElement | null>(null);
  const languageCompartmentRef = useRef(new Compartment());
  const gitGutterCompartmentRef = useRef(new Compartment());
  const gitGutterStartedRef = useRef(false);
  const gitGutterTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const gitGutterGenerationRef = useRef(0);
  const languageGenerationRef = useRef(0);
  const lintCompartmentRef = useRef(new Compartment());
  const lintStartedRef = useRef(false);
  const lspCompartmentRef = useRef(new Compartment());
  const lspDisposeRef = useRef<(() => void) | null>(null);
  const lspGenerationRef = useRef(0);
  const lspStartedRef = useRef(false);
  const readOnlyCompartmentRef = useRef(new Compartment());
  const searchCompartmentRef = useRef(new Compartment());
  const viewRef = useRef<EditorView | null>(null);
  const wordWrapCompartmentRef = useRef(new Compartment());
  const callbackRef = useRef({
    onConflict,
    onError,
    onFormatDocument,
    onLanguageIntelligenceStatus,
    onSaved,
    onSessionReady,
    onStatusChange,
  });

  useEffect(() => {
    callbackRef.current = {
      onConflict,
      onError,
      onFormatDocument,
      onLanguageIntelligenceStatus,
      onSaved,
      onSessionReady,
      onStatusChange,
    };
  }, [
    onConflict,
    onError,
    onFormatDocument,
    onLanguageIntelligenceStatus,
    onSaved,
    onSessionReady,
    onStatusChange,
  ]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let view: EditorView;
    const session = !readOnly && contentVersion
      ? new EditorSession({
          contentVersion,
          eol,
          fileKey,
          hasBom,
          relativePath,
          rootPath,
          snapshot: () => view.state.sliceDoc(),
          applyChanges: (changes) => view.dispatch({ changes }),
          write: writeFileContent,
          onConflict: (response) => callbackRef.current.onConflict?.(response),
          onError: (error) => callbackRef.current.onError?.(error),
          onSaved: (savedContent, response) => callbackRef.current.onSaved?.(savedContent, response),
          onStatusChange: (status) => callbackRef.current.onStatusChange?.(status),
        })
      : null;
    const startLanguageIntelligence = (): void => {
      if (
        !session
        || session.isDisposed
        || lspStartedRef.current
        || !enableCompletion
        || !/\.(?:[cm]?[jt]sx?)$/i.test(relativePath)
      ) return;
      lspStartedRef.current = true;
      const lspGeneration = ++lspGenerationRef.current;
      callbackRef.current.onLanguageIntelligenceStatus?.('starting');
      void import('./typescriptLsp').then(({ activateTypeScriptLsp }) => activateTypeScriptLsp({
        editorSessionId: session.editorSessionId,
        onStatus: (status, detail) => callbackRef.current.onLanguageIntelligenceStatus?.(status, detail),
        relativePath,
        rootPath,
      })).then((activation) => {
        if (
          viewRef.current !== view
          || session.isDisposed
          || lspGeneration !== lspGenerationRef.current
        ) {
          if (activation.status === 'ready') activation.dispose();
          return;
        }
        if (activation.status !== 'ready') {
          callbackRef.current.onLanguageIntelligenceStatus?.(activation.status, activation.reason);
          return;
        }
        lspDisposeRef.current = activation.dispose;
        view.dispatch({ effects: lspCompartmentRef.current.reconfigure(activation.extension) });
        callbackRef.current.onLanguageIntelligenceStatus?.('ready');
      }).catch((error: unknown) => {
        rendererLog.warn(CODE_MIRROR_LOG_SCOPE, 'Language intelligence activation failed', { error, fileKey });
        callbackRef.current.onLanguageIntelligenceStatus?.('unavailable', 'Language intelligence failed to start');
      });
    };
    const mountedAt = performance.now();
    view = new EditorView({
      parent: container,
      state: createEditorState({
        completionCompartment: completionCompartmentRef.current,
        content,
        fileName,
        highlightQuery,
        languageCompartment: languageCompartmentRef.current,
        lintCompartment: lintCompartmentRef.current,
        gitGutterCompartment: gitGutterCompartmentRef.current,
        lspCompartment: lspCompartmentRef.current,
        lineSeparator: LINE_SEPARATOR_BY_EOL[eol],
        onDocumentChange: () => {
          session?.documentChanged();
          startLanguageIntelligence();
          if (session) {
            if (!gitGutterStartedRef.current) {
              gitGutterStartedRef.current = true;
              view.dispatch({
                effects: gitGutterCompartmentRef.current.reconfigure(getGitGutterExtension()),
              });
            }
            if (gitGutterTimerRef.current !== null) clearTimeout(gitGutterTimerRef.current);
            const gutterGeneration = ++gitGutterGenerationRef.current;
            gitGutterTimerRef.current = setTimeout(() => {
              gitGutterTimerRef.current = null;
              void getFileDiff({
                diffMode: 'working',
                path: relativePath,
                worktreePath: rootPath,
              }).then((response) => {
                if (
                  viewRef.current !== view
                  || session.isDisposed
                  || gutterGeneration !== gitGutterGenerationRef.current
                ) return;
                view.dispatch({
                  effects: setGitGutterChanges.of(parseGitGutterChanges(response.patch ?? '')),
                });
              }).catch((error: unknown) => {
                rendererLog.warn(CODE_MIRROR_LOG_SCOPE, 'Git gutter refresh failed', {
                  error,
                  fileKey,
                });
              });
            }, 1_100);
          }
          if (!enableLint || lintStartedRef.current) return;
          lintStartedRef.current = true;
          const requestedSessionId = session?.editorSessionId;
          void loadFileEditorLintExtension(fileName).then((lintExtension) => {
            if (
              viewRef.current !== view
              || session?.editorSessionId !== requestedSessionId
              || session?.isDisposed
            ) return;
            view.dispatch({
              effects: lintCompartmentRef.current.reconfigure(lintExtension),
            });
          }).catch((error: unknown) => {
            rendererLog.warn(CODE_MIRROR_LOG_SCOPE, 'Lint load failed', { error, fileKey, fileName });
          });
        },
        onFormatDocument: () => callbackRef.current.onFormatDocument?.(),
        onLanguageIntelligenceRequest: startLanguageIntelligence,
        readOnly,
        readOnlyCompartment: readOnlyCompartmentRef.current,
        relativePath,
        rootPath,
        searchCompartment: searchCompartmentRef.current,
        wordWrap,
        wordWrapCompartment: wordWrapCompartmentRef.current,
      }),
    });

    viewRef.current = view;
    if (consumePendingLspNavigation(toFileUri(rootPath, relativePath))) startLanguageIntelligence();
    callbackRef.current.onSessionReady?.(session);
    rendererLog.info(CODE_MIRROR_LOG_SCOPE, 'Editor mounted', {
      contentLength: content.length,
      durationMs: elapsedMs(mountedAt),
      fileKey,
      fileName,
    });
    return () => {
      if (gitGutterTimerRef.current !== null) clearTimeout(gitGutterTimerRef.current);
      gitGutterGenerationRef.current += 1;
      gitGutterStartedRef.current = false;
      lspGenerationRef.current += 1;
      lspDisposeRef.current?.();
      lspDisposeRef.current = null;
      lspStartedRef.current = false;
      callbackRef.current.onSessionReady?.(null);
      session?.dispose();
      view.destroy();
      viewRef.current = null;
    };
    // The editor session owns mutable CodeMirror compartments and is deliberately recreated only
    // when the file identity changes. Other props are applied through refs/effects below; adding
    // them here would destroy the editor session on ordinary content or option updates.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileKey]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const generation = ++languageGenerationRef.current;
    const requestedFileKey = fileKey;
    view.dispatch({
      effects: completionCompartmentRef.current.reconfigure(
        enableCompletion ? getFileEditorCompletionExtension(fileName, rootPath, relativePath) : [],
      ),
    });
    void loadFileEditorLanguageExtension(fileName).then((language) => {
      if (
        viewRef.current !== view
        || requestedFileKey !== fileKey
        || generation !== languageGenerationRef.current
      ) return;
      view.dispatch({
        effects: languageCompartmentRef.current.reconfigure(language),
      });
    }).catch((error: unknown) => {
      rendererLog.warn(CODE_MIRROR_LOG_SCOPE, 'Grammar load failed', { error, fileKey, fileName });
    });
  }, [enableCompletion, fileKey, fileName, relativePath, rootPath]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const currentContent = view.state.sliceDoc();
    const change = computeMinimalDocumentChange(currentContent, content);
    if (change) view.dispatch({ changes: change });
  }, [content]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: wordWrapCompartmentRef.current.reconfigure(getFileEditorWordWrapExtension(wordWrap)),
    });
  }, [wordWrap]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: searchCompartmentRef.current.reconfigure(getFileEditorSearchExtension(highlightQuery)),
    });
  }, [highlightQuery]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: readOnlyCompartmentRef.current.reconfigure(getFileEditorReadOnlyExtension(readOnly)),
    });
  }, [readOnly]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || !scrollToLine) return;
    const boundedLineNumber = Math.max(1, Math.min(scrollToLine, view.state.doc.lines));
    const line = view.state.doc.line(boundedLineNumber);
    const frame = requestAnimationFrame(() => {
      view.dispatch({ effects: EditorView.scrollIntoView(line.from, { y: 'center' }) });
    });
    return () => cancelAnimationFrame(frame);
  }, [fileKey, scrollToLine]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || openSearchPanelRequestKey === 0) return;
    view.focus();
    openSearchPanel(view);
  }, [openSearchPanelRequestKey]);

  return <div ref={containerRef} className="h-full min-h-0" />;
}
