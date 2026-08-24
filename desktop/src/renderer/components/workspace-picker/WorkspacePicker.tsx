import { useEffect, useRef, useCallback, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Search, FolderOpen, FolderPlus } from 'lucide-react';
import { useWorkspacePickerStore, useProjectStore, usePaneStore, useNotificationStore } from '../../stores';
import { WorkspacePickerItem } from './WorkspacePickerItem';
import * as workspaceApi from '../../api/workspace.api';
import * as paneApi from '../../api/pane.api';

export function WorkspacePicker() {
  const isOpen = useWorkspacePickerStore((s) => s.isOpen);
  const search = useWorkspacePickerStore((s) => s.search);
  const setSearch = useWorkspacePickerStore((s) => s.setSearch);
  const selectedIndex = useWorkspacePickerStore((s) => s.selectedIndex);
  const setSelectedIndex = useWorkspacePickerStore((s) => s.setSelectedIndex);
  const moveSelection = useWorkspacePickerStore((s) => s.moveSelection);
  const close = useWorkspacePickerStore((s) => s.close);
  const getFilteredProjects = useWorkspacePickerStore((s) => s.getFilteredProjects);
  const isLoading = useWorkspacePickerStore((s) => s.isLoading);
  const deletingRoot = useWorkspacePickerStore((s) => s.deletingRoot);
  const removeProject = useWorkspacePickerStore((s) => s.removeProject);
  const historyEntries = useWorkspacePickerStore((s) => s.historyEntries);
  const activeProjects = useWorkspacePickerStore((s) => s.activeProjects);

  const switchProject = useProjectStore((s) => s.switchProject);
  const setProjectSwitching = useProjectStore((s) => s.setProjectSwitching);
  const setPanes = usePaneStore((s) => s.setPanes);
  const setCreating = usePaneStore((s) => s.setCreating);
  const addToast = useNotificationStore((s) => s.addToast);

  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [conflictPath, setConflictPath] = useState<string | null>(null);

  const projects = getFilteredProjects();

  useEffect(() => {
    if (isOpen && inputRef.current) {
      inputRef.current.focus();
    }
  }, [isOpen]);

  useEffect(() => {
    if (!listRef.current) return;
    const items = listRef.current.querySelectorAll('[data-picker-item]');
    const selected = items[selectedIndex];
    if (selected) {
      selected.scrollIntoView({ block: 'nearest' });
    }
  }, [selectedIndex]);

  const openProject = useCallback(
    async (project: { root: string; name: string; paneCount: number }, createNewPane: boolean, fresh = false) => {
      close();
      setProjectSwitching(true);

      try {
        await workspaceApi.touchHistory({
          name: project.name,
          root: project.root,
          paneCount: project.paneCount,
        });

        await switchProject(project.root, fresh ? { fresh: true } : undefined);

        const panes = await paneApi.listPanes();
        setPanes(panes);

        if (createNewPane || panes.length === 0) {
          setTimeout(() => setCreating(true), 300);
        }
      } catch (error) {
        addToast(error instanceof Error ? error.message : 'Failed to switch projects', 'error');
      } finally {
        setProjectSwitching(false);
      }
    },
    [addToast, close, setProjectSwitching, switchProject, setPanes, setCreating],
  );

  const openSessionFromPath = useCallback(
    async (folderPath: string, fresh = false) => {
      close();
      setProjectSwitching(true);

      try {
        const session = await workspaceApi.createSession({ folderPath });
        if (!session.success || !session.project) {
          setProjectSwitching(false);
          addToast(session.error ?? 'Failed to open project session', 'error');
          return;
        }
        await openProject(
          fresh ? { ...session.project, paneCount: 0 } : session.project,
          fresh,
          fresh,
        );
      } catch {
        setProjectSwitching(false);
      }
    },
    [close, setProjectSwitching, addToast, openProject],
  );

  const handleOpenFolder = useCallback(async () => {
    const result = await workspaceApi.openFolderDialog();
    if (result.canceled || !result.path) return;

    await openSessionFromPath(result.path);
  }, [openSessionFromPath]);

  const handleNewProject = useCallback(async () => {
    const result = await workspaceApi.createProjectDialog();
    if (result.canceled || !result.path) {
      if (!result.canceled && result.error) {
        addToast(result.error, 'error');
      }
      return;
    }

    const path = result.path;
    const conflict =
      activeProjects.some((p) => p.root === path)
      || historyEntries.some((h) => h.root === path);

    if (conflict) {
      setConflictPath(path);
      return;
    }

    await openSessionFromPath(path, true);
  }, [addToast, openSessionFromPath, activeProjects, historyEntries]);

  const handleResumeConflict = useCallback(async () => {
    if (!conflictPath) return;
    const path = conflictPath;
    setConflictPath(null);
    await openSessionFromPath(path, false);
  }, [conflictPath, openSessionFromPath]);

  const handleOverwriteConflict = useCallback(async () => {
    if (!conflictPath) return;
    const path = conflictPath;
    setConflictPath(null);
    await openSessionFromPath(path, true);
  }, [conflictPath, openSessionFromPath]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (conflictPath) {
        if (e.key === 'Escape') {
          e.preventDefault();
          setConflictPath(null);
        }
        return;
      }
      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          moveSelection(1);
          break;
        case 'ArrowUp':
          e.preventDefault();
          moveSelection(-1);
          break;
        case 'Enter': {
          e.preventDefault();
          if (projects.length > 0 && selectedIndex < projects.length) {
            const createNew = e.shiftKey;
            openProject(projects[selectedIndex], createNew);
          }
          break;
        }
        case 'Escape':
          e.preventDefault();
          close();
          break;
      }
    },
    [conflictPath, moveSelection, projects, selectedIndex, openProject, close],
  );

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.25 }}
          className="fixed inset-0 z-[60] flex flex-col items-center justify-center"
          style={{ background: 'var(--bg)' }}
          onKeyDown={handleKeyDown}
        >
          {/* Orb animation */}
          <div className="absolute inset-0 pointer-events-none overflow-hidden">
            <div
              className="absolute top-1/2 left-1/2 w-[600px] h-[600px] rounded-full"
              style={{
                background: 'radial-gradient(circle, var(--workspace-orb-primary) 0%, transparent 70%)',
                animation: 'orb-float 6s ease-in-out infinite',
              }}
            />
            <div
              className="absolute top-1/3 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[300px] h-[300px] rounded-full opacity-[0.04]"
              style={{ background: 'radial-gradient(circle, var(--workspace-orb-secondary) 0%, transparent 70%)' }}
            />
          </div>

          <div className="relative flex flex-col items-center gap-6 w-full max-w-[520px] px-6">
            {/* Gradient wordmark */}
            <div className="flex flex-col items-center gap-1.5 mb-2">
              <span
                className="text-[48px] font-bold tracking-[-0.04em] leading-none select-none"
                style={{
                  background:
                    'linear-gradient(135deg, var(--workspace-wordmark-from) 0%, var(--workspace-wordmark-via) 60%, var(--workspace-wordmark-to) 100%)',
                  WebkitBackgroundClip: 'text',
                  WebkitTextFillColor: 'transparent',
                  backgroundClip: 'text',
                  fontFamily: "'Inter', sans-serif",
                }}
              >
                Amux
              </span>
              <p
                className="text-[11px] font-normal tracking-[0.18em] uppercase"
                style={{ color: 'var(--text-secondary)' }}
              >
                Multi-agent terminal
              </p>
            </div>

            {/* Floating card */}
            <div
              className="w-full rounded-xl border overflow-hidden"
              style={{
                borderColor: 'var(--border)',
                background: 'var(--surface-raised)',
                boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.4)',
              }}
            >
              {/* Search input */}
              <div
                className="flex items-center gap-2.5 px-4 border-b"
                style={{ borderColor: 'var(--border)' }}
              >
                <Search size={14} style={{ color: 'var(--text-secondary)', flexShrink: 0 }} />
                <input
                  ref={inputRef}
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search projects..."
                  className="flex-1 bg-transparent py-3 text-sm outline-none"
                  style={{ color: 'var(--text)' }}
                />
              </div>

              {/* Section label */}
              <div className="px-2 pt-2">
                <span
                  className="block px-3 py-1.5 text-[10px] font-medium uppercase tracking-wider"
                  style={{ color: 'var(--text-secondary)' }}
                >
                  {search ? 'Results' : 'Recent'}
                </span>
              </div>

              {/* Project list */}
              <div ref={listRef} className="max-h-[320px] overflow-y-auto px-2 pb-1">
                {isLoading ? (
                  <div className="px-3 py-6 text-center text-xs" style={{ color: 'var(--text-secondary)' }}>
                    Loading projects...
                  </div>
                ) : projects.length === 0 ? (
                  <div className="px-3 py-6 text-center text-xs" style={{ color: 'var(--text-secondary)' }}>
                    {search ? 'No projects match your search.' : 'No recent projects.'}
                  </div>
                ) : (
                  projects.map((project, idx) => (
                    <div key={project.root} data-picker-item>
                      <WorkspacePickerItem
                        project={project}
                        isSelected={idx === selectedIndex}
                        isDeleting={deletingRoot === project.root}
                        onResume={() => openProject(project, false)}
                        onNewPane={() => openProject(project, true)}
                        onHover={() => setSelectedIndex(idx)}
                        onDelete={() => removeProject(project.root)}
                      />
                    </div>
                  ))
                )}
              </div>

              {/* Quick actions */}
              <div
                className="grid grid-cols-2 border-t"
                style={{ borderColor: 'var(--border)' }}
              >
                <button
                  onClick={handleNewProject}
                  className="flex items-center justify-center gap-2 py-2.5 text-[11px] tracking-wide transition-colors duration-150 hover:bg-[var(--surface)] border-r"
                  style={{
                    color: 'var(--text-secondary)',
                    borderColor: 'var(--border)',
                  }}
                >
                  <FolderPlus size={13} strokeWidth={1.5} />
                  <span>New Project</span>
                </button>
                <button
                  onClick={handleOpenFolder}
                  className="flex items-center justify-center gap-2 py-2.5 text-[11px] tracking-wide transition-colors duration-150 hover:bg-[var(--surface)]"
                  style={{ color: 'var(--text-secondary)' }}
                >
                  <FolderOpen size={13} strokeWidth={1.5} />
                  <span>Open Folder</span>
                </button>
              </div>
            </div>

            {/* Keyboard hints */}
            <div
              className="flex items-center gap-4 text-[11px]"
              style={{ color: 'var(--text-secondary)' }}
            >
              <span>
                <kbd className="inline-flex items-center px-1 py-0.5 rounded bg-[var(--surface)] border border-[var(--border)] text-[10px] font-mono mr-1">
                  ↑↓
                </kbd>
                navigate
              </span>
              <span>
                <kbd className="inline-flex items-center px-1 py-0.5 rounded bg-[var(--surface)] border border-[var(--border)] text-[10px] font-mono mr-1">
                  ↵
                </kbd>
                open
              </span>
              <span>
                <kbd className="inline-flex items-center px-1 py-0.5 rounded bg-[var(--surface)] border border-[var(--border)] text-[10px] font-mono mr-1">
                  ⇧↵
                </kbd>
                new pane
              </span>
              <span>
                <kbd className="inline-flex items-center px-1 py-0.5 rounded bg-[var(--surface)] border border-[var(--border)] text-[10px] font-mono mr-1">
                  esc
                </kbd>
                dismiss
              </span>
            </div>
          </div>

          {conflictPath && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="absolute inset-0 z-10 flex items-center justify-center bg-black/60 backdrop-blur-sm"
              onClick={() => setConflictPath(null)}
            >
              <motion.div
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.95 }}
                onClick={(e) => e.stopPropagation()}
                className="bg-[var(--surface-raised)] border border-[var(--border)] rounded-xl p-6 w-full max-w-[440px] shadow-2xl"
              >
                <h2 className="text-sm font-semibold text-[var(--text)]">Project already exists</h2>
                <p className="mt-2 text-xs text-[var(--text-secondary)] leading-relaxed">
                  A project at this path is already known to Amux:
                </p>
                <p className="mt-1.5 text-[11px] font-mono text-[var(--text-secondary)] truncate" title={conflictPath}>
                  {conflictPath}
                </p>
                <p className="mt-3 text-xs text-[var(--text-secondary)] leading-relaxed">
                  Resume opens it with its existing panes intact. Overwrite starts a fresh session and
                  destroys the current panes.
                </p>
                <div className="mt-5 flex justify-end gap-2">
                  <button
                    onClick={() => setConflictPath(null)}
                    className="px-3 py-1.5 rounded-md text-xs font-medium text-[var(--text-secondary)] hover:bg-[var(--surface)] transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleOverwriteConflict}
                    className="px-3 py-1.5 rounded-md text-xs font-medium text-white bg-[var(--error)] hover:opacity-90 transition-opacity"
                  >
                    Overwrite
                  </button>
                  <button
                    onClick={handleResumeConflict}
                    autoFocus
                    className="px-3 py-1.5 rounded-md text-xs font-medium text-white bg-[var(--accent)] hover:opacity-90 transition-opacity"
                  >
                    Resume
                  </button>
                </div>
              </motion.div>
            </motion.div>
          )}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
