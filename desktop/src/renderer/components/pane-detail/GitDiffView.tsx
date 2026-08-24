import { DiffView, DiffModeEnum } from '@git-diff-view/react';
import type { AumxPane } from 'aumx/core';
import { Files, FolderGit2, GitBranch, Minus, Plus, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Group, Panel, Separator } from 'react-resizable-panels';
import '@git-diff-view/react/styles/diff-view.css';
import './GitDiffView.css';
import type { GitDiffMode, GitDiffResponse, GitFileDiffResponse } from '../../../shared/ipc-types';
import * as gitApi from '../../api/git.api';
import * as systemApi from '../../api/system.api';
import { useAppThemeMode } from '../../hooks/useAppThemeMode';
import { useVisiblePolling } from '../../hooks/useVisiblePolling';
import { useNotificationStore } from '../../stores';
import { useEditorPrefsStore } from '../../stores/editor-prefs.store';
import { useWorktreeStatusStore } from '../../stores/worktree-status.store';
import { EmptyState } from '../shared/EmptyState';
import { HoverTooltip } from '../shared/HoverTooltip';
import { Spinner } from '../shared/Spinner';
import { AttachWorktreePicker } from '../worktree/AttachWorktreePicker';
import {
  GIT_DIFF_CONTENT_MIN_SIZE,
  GIT_DIFF_CONTENT_PANEL_ID_PREFIX,
  GIT_DIFF_FILE_LIST_DEFAULT_SIZE,
  GIT_DIFF_FILE_LIST_MAX_SIZE,
  GIT_DIFF_FILE_LIST_MIN_SIZE,
  GIT_DIFF_FILE_LIST_PANEL_ID_PREFIX,
  GIT_DIFF_RESIZE_HANDLE_CLASS,
  GIT_DIFF_RESIZE_HANDLE_LABEL,
  GIT_DIFF_RESIZE_TARGET_MINIMUM_SIZE,
} from './gitDiffLayout';
import { OpenInEditorButton } from './OpenInEditorButton';
import {
  DIFF_MODE_OPTIONS,
  FileHeaderStatus,
  FileListSearch,
  ICON_BUTTON_CLASS,
  RepoBadge,
  SegmentedControl,
  StatusGlyph,
  ToolbarDivider,
  VIEW_MODE_OPTIONS,
  safeRelative,
} from './GitDiffViewParts';

interface GitDiffViewProps {
  pane: AumxPane;
}

interface FullPatchCacheEntry {
  /** The compact patch that produced this full-file response; invalidates the entry when it changes. */
  version: string;
  response: GitFileDiffResponse;
}

const FIRST_CHANGE_SCROLL_OFFSET_PX = 96;
const WORKING_POLL_MS = 4000;
const RANGE_POLL_MS = 15000;

const REFRESH_LABEL = 'Refresh';

export function GitDiffView({ pane }: GitDiffViewProps) {
  const layoutInstanceId = useId().replaceAll(':', '');
  const contentPanelId = `${GIT_DIFF_CONTENT_PANEL_ID_PREFIX}-${layoutInstanceId}`;
  const fileListPanelId = `${GIT_DIFF_FILE_LIST_PANEL_ID_PREFIX}-${layoutInstanceId}`;
  const [data, setData] = useState<GitDiffResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<'split' | 'unified'>('unified');
  const [diffMode, setDiffMode] = useState<GitDiffMode>('working');
  const [fullPatchByFile, setFullPatchByFile] = useState<Record<string, FullPatchCacheEntry>>({});
  const [fullPatchLoadingKey, setFullPatchLoadingKey] = useState<string | null>(null);
  const [showAttachPicker, setShowAttachPicker] = useState(false);
  const addToast = useNotificationStore((s) => s.addToast);
  // Fall back to the pane's project root when no worktree is attached so the
  // Diff tab still shows the repo's working-tree diff (e.g. for shell panes
  // or panes whose worktree was detached).
  const gitPath = pane.worktreePath ?? pane.projectRoot;
  const lastEditorId = useEditorPrefsStore((s) => s.lastEditorId);
  const openEditor = useCallback(async (file?: string) => {
    if (!gitPath) return;
    try {
      // Pass the user's last picked editor id; main resolves it to a trusted
      // command and falls back to the system default when it isn't installed.
      await systemApi.openInEditor(gitPath, file, undefined, lastEditorId ?? undefined);
    } catch (err) {
      addToast(`Failed to open editor: ${err instanceof Error ? err.message : String(err)}`, 'error');
    }
  }, [addToast, gitPath, lastEditorId]);
  const appTheme = useAppThemeMode();
  const diffScrollRef = useRef<HTMLDivElement | null>(null);
  const fullPatchRequestSeqRef = useRef(0);
  const requestSeqRef = useRef(0);
  const latestDataRef = useRef<GitDiffResponse | null>(null);

  useEffect(() => {
    latestDataRef.current = data;
  }, [data]);

  useEffect(() => {
    setData(null);
    setSelectedPath(null);
    setError(null);
    setFullPatchByFile({});
    setFullPatchLoadingKey(null);
    setLoading(true);
    fullPatchRequestSeqRef.current++;
    requestSeqRef.current++;
  }, [pane.id]);

  useEffect(() => {
    setData(null);
    setSelectedPath(null);
    setError(null);
    setFullPatchByFile({});
    setFullPatchLoadingKey(null);
    setLoading(true);
    fullPatchRequestSeqRef.current++;
    requestSeqRef.current++;
  }, [diffMode]);

  const loadDiff = useCallback(async (showSpinner: boolean) => {
    const requestSeq = ++requestSeqRef.current;

    if (!gitPath) {
      if (requestSeq !== requestSeqRef.current) return;
      setData(null);
      setError(null);
      setLoading(false);
      return;
    }
    if (showSpinner) setLoading(true);
    if (showSpinner) setError(null);

    try {
      const response = await gitApi.getDiff({ worktreePath: gitPath, diffMode });
      if (requestSeq !== requestSeqRef.current) return;

      if (response.error) {
        if (showSpinner || !latestDataRef.current) {
          setError(response.error);
          setData(null);
        }
      } else {
        setError(null);
        const prev = latestDataRef.current;
        const unchanged = prev
          && prev.filesChanged === response.filesChanged
          && prev.insertions === response.insertions
          && prev.deletions === response.deletions
          && prev.diff === response.diff;
        if (!unchanged) setData(response);
        useWorktreeStatusStore.getState().set(pane.id, {
          commitsAhead: null,
          filesChanged: response.filesChanged ?? 0,
          insertions: response.insertions ?? 0,
          deletions: response.deletions ?? 0,
          isDirty: (response.filesChanged ?? 0) > 0,
          lastFetched: Date.now(),
        });
      }
    } catch (err) {
      if (requestSeq !== requestSeqRef.current) return;
      if (showSpinner || !latestDataRef.current) {
        setError((err as Error).message);
        setData(null);
      }
    } finally {
      if (requestSeq === requestSeqRef.current) {
        setLoading(false);
      }
    }
  }, [gitPath, diffMode, pane.id]);

  useEffect(() => {
    void loadDiff(true);
  }, [loadDiff, pane.id]);

  useVisiblePolling(
    () => void loadDiff(false),
    diffMode === 'working' ? WORKING_POLL_MS : RANGE_POLL_MS,
    Boolean(gitPath),
  );

  const files = useMemo(() => data?.files ?? [], [data?.files]);

  useEffect(() => {
    if (files.length === 0) {
      setSelectedPath(null);
      return;
    }
    setSelectedPath((current) =>
      current && files.some((file) => file.path === current) ? current : files[0].path,
    );
  }, [files]);

  const selectedFile = useMemo(
    () => files.find((file) => file.path === selectedPath) ?? files[0] ?? null,
    [files, selectedPath],
  );

  const selectedFileIdentityKey = useMemo(() => {
    if (!selectedFile) return null;
    return [diffMode, selectedFile.path, selectedFile.oldPath ?? ''].join(':');
  }, [diffMode, selectedFile]);

  const cachedFullPatchEntry = selectedFileIdentityKey ? fullPatchByFile[selectedFileIdentityKey] : undefined;
  const selectedFullPatch = cachedFullPatchEntry && cachedFullPatchEntry.version === selectedFile?.patch
    ? cachedFullPatchEntry.response
    : undefined;
  const selectedPatch = selectedFile ? selectedFullPatch?.patch ?? selectedFile.patch : undefined;
  const fullContextFallbackReason = selectedFullPatch?.error
    ?? (selectedFullPatch?.tooLarge ? 'Full-file context is unavailable; showing compact diff.' : null);
  const isFullPatchLoading = selectedFileIdentityKey === fullPatchLoadingKey;
  const hasFullFileContext = Boolean(selectedFullPatch?.patch);

  const hunks = useMemo(
    () => (selectedPatch ? [selectedPatch] : []),
    [selectedPatch],
  );

  const diffFileNames = useMemo(() => {
    if (!selectedFile) return { oldFileName: undefined, newFileName: undefined };
    const isAdded = selectedFile.status === 'added' || selectedFile.status === 'untracked';
    const isDeleted = selectedFile.status === 'deleted';
    return {
      oldFileName: isAdded ? null : (selectedFile.oldPath ?? selectedFile.path),
      newFileName: isDeleted ? null : selectedFile.path,
    };
  }, [selectedFile]);

  const diffViewData = useMemo(() => ({
    oldFile: { fileName: diffFileNames.oldFileName },
    newFile: { fileName: diffFileNames.newFileName },
    hunks,
  }), [diffFileNames.oldFileName, diffFileNames.newFileName, hunks]);

  useEffect(() => {
    if (!gitPath || !selectedFile || !selectedFileIdentityKey) return;
    if (!selectedFile.patch || selectedFile.isBinary || selectedFile.tooLarge) return;
    if (fullPatchByFile[selectedFileIdentityKey]?.version === selectedFile.patch) return;

    const requestSeq = ++fullPatchRequestSeqRef.current;
    const patchVersion = selectedFile.patch;
    setFullPatchLoadingKey(selectedFileIdentityKey);

    gitApi.getFileDiff({
      worktreePath: gitPath,
      diffMode,
      path: selectedFile.path,
      oldPath: selectedFile.oldPath,
    }).then((response) => {
      if (requestSeq !== fullPatchRequestSeqRef.current) return;
      setFullPatchByFile((current) => ({
        ...current,
        [selectedFileIdentityKey]: { version: patchVersion, response },
      }));
    }).catch((err) => {
      if (requestSeq !== fullPatchRequestSeqRef.current) return;
      setFullPatchByFile((current) => ({
        ...current,
        [selectedFileIdentityKey]: {
          version: patchVersion,
          response: { path: selectedFile.path, error: (err as Error).message },
        },
      }));
    }).finally(() => {
      if (requestSeq === fullPatchRequestSeqRef.current) {
        setFullPatchLoadingKey(null);
      }
    });
  }, [diffMode, fullPatchByFile, gitPath, selectedFile, selectedFileIdentityKey]);

  const scrollToFirstChange = useCallback(() => {
    if (!diffScrollRef.current) return;
    scrollContainerToFirstChangedLine(diffScrollRef.current);
  }, []);

  useLayoutEffect(() => {
    if (!selectedPatch) return;
    const frame = window.requestAnimationFrame(scrollToFirstChange);
    return () => window.cancelAnimationFrame(frame);
  }, [scrollToFirstChange, selectedFile?.path, selectedPatch, viewMode]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Spinner />
      </div>
    );
  }

  if (error) {
    return <EmptyState title="Error loading changes" description={error} />;
  }

  if (!gitPath) {
    return (
      <>
        <EmptyState
          title="No Worktree"
          description="This pane is not attached to a git worktree, so there is no isolated diff to show."
          action="Attach Worktree"
          onAction={() => setShowAttachPicker(true)}
        />
        {showAttachPicker && (
          <AttachWorktreePicker
            paneId={pane.id}
            paneSlug={pane.slug}
            onClose={() => setShowAttachPicker(false)}
            onAttached={() => void loadDiff(true)}
          />
        )}
      </>
    );
  }

  if (data?.repo && !data.repo.isGitRepo) {
    return (
      <EmptyState
        title="Not a Git Repository"
        description="This worktree path is not inside a Git repository."
      />
    );
  }

  if (!data || files.length === 0) {
    const ahead = data?.commitsAhead ?? 0;
    if (diffMode === 'working' && ahead > 0) {
      return (
        <EmptyState
          title="No uncommitted changes"
          description={`${ahead} commit(s) ahead of base branch.`}
          action="View Branch Diff"
          onAction={() => setDiffMode('branch')}
          secondaryAction="Open in editor"
          onSecondaryAction={() => void openEditor()}
        />
      );
    }
    return (
      <EmptyState
        title="No changes"
        description="This worktree has no tracked or untracked file changes yet."
        action="Open in editor"
        onAction={() => void openEditor()}
      />
    );
  }

  const branchLabel = data.repo?.detachedHead ? 'detached HEAD' : (data.repo?.branch ?? 'unknown');
  const relativeWorktree = data.repo?.repoRoot && gitPath
    ? safeRelative(data.repo.repoRoot, gitPath)
    : gitPath;

  return (
    <div className="h-full min-h-0 flex flex-col bg-[var(--bg)]">
      <div className="shrink-0 border-b border-[var(--border)] bg-[var(--surface)]/85 backdrop-blur px-3 py-2">
        <div className="flex flex-wrap items-center gap-2">
          <RepoBadge icon={GitBranch} label="Branch" value={branchLabel} />
          <ToolbarDivider />
          <RepoBadge
            icon={FolderGit2}
            label={data.repo?.isWorktree ? 'Worktree' : 'Repository'}
            value={relativeWorktree || '—'}
          />
          <ToolbarDivider />
          <RepoBadge icon={Files} label="Files changed" value={String(data.filesChanged)} />
          <ToolbarDivider />
          <RepoBadge icon={Plus} label="Lines added" value={String(data.insertions)} tone="success" />
          <RepoBadge icon={Minus} label="Lines removed" value={String(data.deletions)} tone="error" />
          <div className="flex items-center gap-1 ml-auto shrink-0">
            <SegmentedControl options={DIFF_MODE_OPTIONS} value={diffMode} onChange={setDiffMode} />
            <ToolbarDivider />
            {gitPath && (
              <OpenInEditorButton
                path={gitPath}
                size="icon"
              />
            )}
            <HoverTooltip label={REFRESH_LABEL}>
              <button
                aria-label={REFRESH_LABEL}
                onClick={() => void loadDiff(true)}
                type="button"
                className={ICON_BUTTON_CLASS}
              >
                <RefreshCw size={12} />
              </button>
            </HoverTooltip>
          </div>
        </div>
        {data.repo?.repoRoot && (
          <div className="mt-1 text-[10px] text-[var(--text-muted)] truncate" title={data.repo.repoRoot}>
            {data.repo.repoRoot}
          </div>
        )}
      </div>

      <Group
        className="flex-1 min-h-0"
        id={`git-diff-layout-${layoutInstanceId}`}
        orientation="horizontal"
        resizeTargetMinimumSize={GIT_DIFF_RESIZE_TARGET_MINIMUM_SIZE}
      >
        <Panel
          className="min-w-0 bg-[var(--surface)]/55 flex flex-col overflow-hidden"
          defaultSize={GIT_DIFF_FILE_LIST_DEFAULT_SIZE}
          groupResizeBehavior="preserve-pixel-size"
          id={fileListPanelId}
          maxSize={GIT_DIFF_FILE_LIST_MAX_SIZE}
          minSize={GIT_DIFF_FILE_LIST_MIN_SIZE}
        >
          <aside
            aria-label="Changed files"
            className="h-full min-w-0 flex flex-col"
          >
            <FileListSearch
              files={files}
              selectedPath={selectedFile?.path}
              onSelect={setSelectedPath}
              diffMode={diffMode}
            />
          </aside>
        </Panel>

        <Separator
          aria-label={GIT_DIFF_RESIZE_HANDLE_LABEL}
          className={GIT_DIFF_RESIZE_HANDLE_CLASS}
        />

        <Panel
          className="min-w-0 min-h-0 overflow-hidden"
          groupResizeBehavior="preserve-relative-size"
          id={contentPanelId}
          minSize={GIT_DIFF_CONTENT_MIN_SIZE}
        >
          <section
            aria-label="File diff"
            className="h-full min-w-0 min-h-0 flex flex-col"
          >
            {selectedFile ? (
              <>
                <div className="shrink-0 border-b border-[var(--border)] px-3 py-2 bg-[var(--surface)]/55">
                  <div className="flex items-center gap-2 min-w-0">
                    <StatusGlyph status={selectedFile.status} />
                    <div className="min-w-0 flex-1">
                      <div className="text-[12px] font-semibold text-[var(--text)] truncate">
                        {selectedFile.path}
                      </div>
                      {selectedFile.oldPath &&
                        selectedFile.oldPath !== selectedFile.path && (
                          <div className="text-[10px] text-[var(--text-muted)] truncate">
                            renamed from {selectedFile.oldPath}
                          </div>
                        )}
                    </div>
                    <FileHeaderStatus
                      fullContextFallbackReason={fullContextFallbackReason}
                      hasFullFileContext={hasFullFileContext}
                      hasPatch={Boolean(selectedPatch)}
                      isBinary={Boolean(selectedFile.isBinary)}
                      isFullPatchLoading={isFullPatchLoading}
                      onOpenFile={() => void openEditor(selectedFile.path)}
                      onScrollToFirstChange={scrollToFirstChange}
                      tooLarge={Boolean(selectedFile.tooLarge)}
                    >
                      <ToolbarDivider />
                      <SegmentedControl
                        options={VIEW_MODE_OPTIONS}
                        value={viewMode}
                        onChange={setViewMode}
                      />
                    </FileHeaderStatus>
                  </div>
                </div>

                <div
                  ref={diffScrollRef}
                  className="flex-1 min-h-0 overflow-auto"
                >
                  {selectedPatch && hunks.length > 0 ? (
                    <div className="git-diff-view-wrapper">
                      <DiffView
                        data={diffViewData}
                        diffViewMode={
                          viewMode === 'split'
                            ? DiffModeEnum.Split
                            : DiffModeEnum.Unified
                        }
                        diffViewTheme={appTheme}
                        diffViewHighlight
                        diffViewFontSize={12}
                        diffViewWrap={false}
                      />
                    </div>
                  ) : (
                    <div className="h-full flex items-center justify-center m-3 rounded-xl border border-[var(--border)] bg-[var(--surface)]">
                      <div className="text-center px-6">
                        <div className="text-sm font-medium text-[var(--text)]">
                          {selectedFile.tooLarge
                            ? 'File preview omitted'
                            : selectedFile.isBinary
                              ? 'Binary file'
                              : 'No diff preview'}
                        </div>
                        <div className="text-xs text-[var(--text-muted)] mt-1">
                          {selectedFile.tooLarge
                            ? 'This file is too large for inline preview. Open it in your editor for full details.'
                            : selectedFile.isBinary
                              ? 'This file changed, but a text diff is not available.'
                              : 'No inline patch is available for this change.'}
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              </>
            ) : (
              <EmptyState
                title="Select a file"
                description="Choose a file from the left to inspect its diff."
              />
            )}
          </section>
        </Panel>
      </Group>
    </div>
  );
}

function scrollContainerToFirstChangedLine(container: HTMLElement): void {
  const operator = container.querySelector<HTMLElement>('.diff-line-content-operator[data-operator="+"]')
    ?? container.querySelector<HTMLElement>('.diff-line-content-operator[data-operator="-"]');
  const row = operator?.closest<HTMLElement>('.diff-line');

  if (!row) return;

  const containerRect = container.getBoundingClientRect();
  const rowRect = row.getBoundingClientRect();
  const top = rowRect.top - containerRect.top + container.scrollTop - FIRST_CHANGE_SCROLL_OFFSET_PX;
  container.scrollTo({ top: Math.max(0, top) });
}
