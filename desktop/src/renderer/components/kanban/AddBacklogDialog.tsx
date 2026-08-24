import { useCallback, useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import type { AgentName } from 'aumx/core';
import { listAgents } from '../../api/agent.api';
import { cn } from '../../lib/cn';
import { ToggleSwitch } from '../shared/ToggleSwitch';
import { ProjectPicker } from '../shared/ProjectPicker';
import * as settingsApi from '../../api/settings.api';
import { useTaskDefaultsStore } from '../../stores/task-defaults.store';
import { useProjectStore } from '../../stores';
import { resolveDefaultTaskProjectRoot } from '../../lib/project-root-defaults';

const COMPLEXITY_OPTIONS = [
  { value: 'S' as const, label: 'S', description: 'Small (< 30 min)' },
  { value: 'M' as const, label: 'M', description: 'Medium (30-90 min)' },
  { value: 'L' as const, label: 'L', description: 'Large (90+ min)' },
];

const COMPLEXITY_COLORS: Record<string, string> = {
  S: 'var(--success)',
  M: 'var(--warning)',
  L: 'var(--error)',
};

const AGENT_INFO: Record<string, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
  pi: 'Pi',
};

const KANBAN_AGENTS = ['claude', 'codex', 'opencode', 'pi'] as const satisfies readonly AgentName[];

export interface BacklogFormData {
  title: string;
  prompt: string;
  complexity: 'S' | 'M' | 'L';
  agent?: AgentName;
  useWorktree?: boolean;
  projectRoot?: string;
}

interface AddBacklogDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (data: BacklogFormData) => void;
  editItem?: { id: string; title: string; prompt: string; complexity: 'S' | 'M' | 'L'; agent?: AgentName; useWorktree?: boolean; projectRoot?: string };
}

export function AddBacklogDialog({ isOpen, onClose, onSubmit, editItem }: AddBacklogDialogProps) {
  const lastTaskProjectRoot = useTaskDefaultsStore((s) => s.lastTaskProjectRoot);
  const setLastTaskProjectRoot = useTaskDefaultsStore((s) => s.setLastTaskProjectRoot);
  const activeProjectRoot = useProjectStore((s) => s.activeProject?.root);
  const sessionProjectRoot = useProjectStore((s) => s.sessionProjectRoot);
  const [title, setTitle] = useState('');
  const [prompt, setPrompt] = useState('');
  const [complexity, setComplexity] = useState<'S' | 'M' | 'L'>('M');
  const [agent, setAgent] = useState<AgentName | undefined>(undefined);
  const [initGitIfMissing, setInitGitIfMissing] = useState(true);
  const [useWorktree, setUseWorktree] = useState(false);
  const [projectRoot, setProjectRoot] = useState<string | undefined>(undefined);
  const [availableAgents, setAvailableAgents] = useState<AgentName[]>([]);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const titleRef = useRef<HTMLInputElement>(null);
  const initializedOpenRef = useRef(false);

  useEffect(() => {
    if (!isOpen) {
      initializedOpenRef.current = false;
      return;
    }
    if (initializedOpenRef.current) return;

    initializedOpenRef.current = true;
    setTitle(editItem?.title ?? '');
    setPrompt(editItem?.prompt ?? '');
    setComplexity(editItem?.complexity ?? 'M');
    setAgent(editItem?.agent);
    setProjectRoot(editItem?.projectRoot ?? resolveDefaultTaskProjectRoot({
      activeProjectRoot,
      sessionProjectRoot,
      lastTaskProjectRoot,
    }));
    setShowAdvanced(false);
    setUseWorktree(editItem?.useWorktree ?? false);
    listAgents('kanban').then(setAvailableAgents).catch(() => {});
    setTimeout(() => titleRef.current?.focus(), 100);
  }, [isOpen, editItem, activeProjectRoot, sessionProjectRoot, lastTaskProjectRoot]);

  useEffect(() => {
    if (!isOpen) return;
    settingsApi.getSettings({ projectRoot }).then((s) => {
      setInitGitIfMissing(s.initGitIfMissing ?? true);
      if (editItem?.useWorktree === undefined) {
        setUseWorktree(s.useWorktree ?? false);
      }
    }).catch(() => {});
  }, [isOpen, projectRoot, editItem?.useWorktree]);

  const handleSubmit = useCallback(() => {
    if (!title.trim() || !prompt.trim()) return;
    onSubmit({ title: title.trim(), prompt: prompt.trim(), complexity, agent, useWorktree, projectRoot });
    onClose();
  }, [title, prompt, complexity, agent, useWorktree, projectRoot, onSubmit, onClose]);

  const handleProjectRootChange = useCallback((nextProjectRoot: string | undefined) => {
    setProjectRoot(nextProjectRoot);
    setLastTaskProjectRoot(nextProjectRoot);
  }, [setLastTaskProjectRoot]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
      if (e.key === 'Enter' && e.metaKey) {
        e.preventDefault();
        handleSubmit();
      }
    },
    [onClose, handleSubmit],
  );

  const isValid = title.trim().length > 0 && prompt.trim().length > 0;

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          <motion.div
            className="fixed inset-0 bg-black/50 z-40"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
          />
          <motion.div
            className="fixed inset-0 z-50 flex items-center justify-center p-4"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          >
            <motion.div
              className="bg-[var(--surface)] border border-[var(--border)] rounded-xl w-full max-w-[480px] shadow-2xl overflow-hidden"
              initial={{ scale: 0.95, y: 10 }}
              animate={{ scale: 1, y: 0 }}
              exit={{ scale: 0.95, y: 10 }}
              transition={{ type: 'spring', damping: 25, stiffness: 350 }}
              onKeyDown={handleKeyDown}
            >
              {/* Header */}
              <div className="flex items-center justify-between px-5 pt-5 pb-3">
                <h2 className="text-sm font-semibold text-[var(--text)]">{editItem ? 'Edit Task' : 'Add Backlog Task'}</h2>
                <button
                  onClick={onClose}
                  className="w-6 h-6 flex items-center justify-center text-[var(--text-muted)] hover:text-[var(--text)] rounded transition-colors"
                >
                  <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                    <path d="M3.5 3.5L10.5 10.5M10.5 3.5L3.5 10.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                  </svg>
                </button>
              </div>

              <div className="px-5 pb-5 space-y-4">
                {/* Title */}
                <div className="space-y-1.5">
                  <label className="text-[11px] font-medium text-[var(--text-secondary)]">Title</label>
                  <input
                    ref={titleRef}
                    type="text"
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    placeholder="e.g. Fix auth bug"
                    className="w-full px-3 py-2 text-sm bg-[var(--bg)] border border-[var(--border)] rounded-lg text-[var(--text)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-[var(--accent)] transition-colors"
                  />
                </div>

                {/* Prompt */}
                <div className="space-y-1.5">
                  <label className="text-[11px] font-medium text-[var(--text-secondary)]">Prompt</label>
                  <textarea
                    value={prompt}
                    onChange={(e) => setPrompt(e.target.value)}
                    placeholder="Describe what the agent should do..."
                    rows={3}
                    className="w-full px-3 py-2 text-sm bg-[var(--bg)] border border-[var(--border)] rounded-lg text-[var(--text)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-[var(--accent)] resize-none transition-colors"
                  />
                </div>

                {/* Agent (optional) */}
                <div className="space-y-1.5">
                  <label className="text-[11px] font-medium text-[var(--text-secondary)]">
                    Agent <span className="text-[var(--text-muted)] font-normal">(optional)</span>
                  </label>
                  <div className="flex gap-2">
                    {KANBAN_AGENTS.map((a) => {
                      const available = availableAgents.includes(a);
                      const isSelected = agent === a;
                      return (
                        <button
                          key={a}
                          type="button"
                          disabled={!available}
                          onClick={() => setAgent(isSelected ? undefined : a)}
                          className={cn(
                            'flex-1 py-1.5 rounded-lg text-[11px] font-medium transition-all border',
                            isSelected
                              ? 'border-[var(--accent)] bg-[var(--accent)]/5 text-[var(--accent)]'
                              : 'border-[var(--border)] text-[var(--text-secondary)] hover:border-[var(--text-muted)]',
                            !available && 'opacity-40 cursor-not-allowed',
                          )}
                        >
                          {AGENT_INFO[a] ?? a}
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* Git Worktree */}
                <div className="flex items-center justify-between py-1">
                  <div>
                    <span className="text-[11px] font-medium text-[var(--text-secondary)]">Git Worktree</span>
                    <p className="text-[10px] text-[var(--text-muted)]">Isolate work in a separate worktree</p>
                    {useWorktree && (
                      <p className="text-[10px] text-[var(--text-muted)]">
                        {initGitIfMissing
                          ? 'If Git is missing, aumx will run git init and create .git.'
                          : 'Requires an existing Git repository.'}
                      </p>
                    )}
                  </div>
                  <ToggleSwitch checked={useWorktree} onChange={setUseWorktree} size="sm" />
                </div>

                {/* Project */}
                <div className="space-y-1.5">
                  <label className="text-[11px] font-medium text-[var(--text-secondary)]">
                    Project <span className="text-[var(--text-muted)] font-normal">(optional)</span>
                  </label>
                  <ProjectPicker value={projectRoot} onChange={handleProjectRootChange} />
                </div>

                {/* Advanced */}
                <div>
                  <button
                    type="button"
                    onClick={() => setShowAdvanced(!showAdvanced)}
                    className="flex items-center gap-1.5 text-[11px] font-medium text-[var(--text-muted)] hover:text-[var(--text-secondary)] transition-colors"
                  >
                    <svg
                      width="10"
                      height="10"
                      viewBox="0 0 10 10"
                      fill="none"
                      className={cn('transition-transform', showAdvanced && 'rotate-90')}
                    >
                      <path d="M3.5 2L6.5 5L3.5 8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                    Advanced
                  </button>
                  <AnimatePresence>
                    {showAdvanced && (
                      <motion.div
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: 'auto', opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{ duration: 0.15 }}
                        className="overflow-hidden"
                      >
                        <div className="pt-3 space-y-1.5">
                          <label className="text-[11px] font-medium text-[var(--text-secondary)]">Complexity</label>
                          <div className="flex gap-2">
                            {COMPLEXITY_OPTIONS.map((opt) => (
                              <button
                                key={opt.value}
                                type="button"
                                onClick={() => setComplexity(opt.value)}
                                className={cn(
                                  'flex-1 py-1.5 rounded-lg text-[11px] font-medium transition-all border',
                                  complexity === opt.value
                                    ? 'border-current'
                                    : 'border-[var(--border)] text-[var(--text-muted)] hover:border-[var(--text-muted)]',
                                )}
                                style={complexity === opt.value ? { color: COMPLEXITY_COLORS[opt.value] } : undefined}
                              >
                                <span className="font-bold">{opt.label}</span>
                                <span className="ml-1 opacity-70">{opt.description}</span>
                              </button>
                            ))}
                          </div>
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>

                {/* Actions */}
                <div className="flex gap-2 pt-1">
                  <button
                    onClick={onClose}
                    className="flex-1 py-2 rounded-lg text-[12px] font-medium text-[var(--text-secondary)] border border-[var(--border)] hover:bg-[var(--surface-raised)] transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleSubmit}
                    disabled={!isValid}
                    className={cn(
                      'flex-1 py-2 rounded-lg text-[12px] font-medium transition-all border',
                      isValid
                        ? 'bg-[var(--accent)]/15 border-[var(--accent)]/30 text-[var(--accent)] hover:bg-[var(--accent)]/25'
                        : 'opacity-50 cursor-not-allowed bg-[var(--surface)] border-[var(--border)] text-[var(--text-muted)]',
                    )}
                  >
                    {editItem ? 'Save Changes' : 'Add to Backlog'}
                  </button>
                </div>

                <p className="text-[10px] text-[var(--text-muted)] text-center">
                  {'\u2318'}+Enter to submit
                </p>
              </div>
            </motion.div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
