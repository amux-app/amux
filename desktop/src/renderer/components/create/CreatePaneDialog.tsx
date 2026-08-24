import type { AgentName } from 'aumx/core';
import { Pencil, Terminal } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { getAgentDefaults } from '../../api/agent-defaults.api';
import { listAgents, refreshAgents } from '../../api/agent.api';
import * as paneApi from '../../api/pane.api';
import * as settingsApi from '../../api/settings.api';
import { usePaneActions } from '../../hooks/usePaneActions';
import { AGENT_TUNING, isValidOption } from '../../lib/agent-models';
import { cn } from '../../lib/cn';
import { resolveDefaultTaskProjectRoot } from '../../lib/project-root-defaults';
import { createSubmissionGate } from '../../lib/submission-gate';
import { type LaunchMode, useNotificationStore, usePaneStore, useProjectStore } from '../../stores';
import { useTaskDefaultsStore } from '../../stores/task-defaults.store';
import type {
  AgentDefaultsResponse,
  DuelSideConfig,
  PaneCreateRequest,
  PaneDuelCreateRequest,
  PastSession,
} from '../../../shared/ipc-types';
import { PAST_SESSIONS_INITIAL_VISIBLE } from '../../../shared/ipc-types';
import { Kbd } from '../shared/Kbd';
import { ConfirmDialog } from '../shared/ConfirmDialog';
import { ProjectPicker } from '../shared/ProjectPicker';
import { SegmentedTabs } from '../shared/SegmentedTabs';
import { Spinner } from '../shared/Spinner';
import { AgentSelector } from './AgentSelector';
import { AgentTuning } from './AgentTuning';
import { ConfigurationDisclosure } from './ConfigurationDisclosure';
import { DuelSideCard } from './DuelSideCard';
import { QuickSettings } from './QuickSettings';
import { SessionPicker } from './SessionPicker';

const GRADIENT_BORDER_STYLE = {
  background:
    'linear-gradient(152deg, rgba(88,166,255,0.55) 0%, rgba(139,92,246,0.32) 28%, rgba(255,255,255,0.09) 52%, rgba(251,191,36,0.28) 78%, rgba(45,212,191,0.22) 100%)',
} as const;

const LAUNCH_BUTTON_STYLE = {
  background: 'linear-gradient(135deg, #3b82f6 0%, #6366f1 48%, #2563eb 100%)',
} as const;

const GLASS_PANEL_STYLE = {
  background:
    'linear-gradient(168deg, color-mix(in srgb, var(--surface-raised) 92%, transparent) 0%, color-mix(in srgb, var(--surface-raised) 97%, transparent) 45%, color-mix(in srgb, var(--surface) 99%, transparent) 100%)',
  backdropFilter: 'blur(52px) saturate(150%)',
  WebkitBackdropFilter: 'blur(52px) saturate(150%)',
} as const;

const OVERLAY_SCRIM_STYLE = {
  backgroundColor: 'color-mix(in srgb, var(--bg) 42%, #000000)',
  backdropFilter: 'blur(28px) saturate(165%)',
  WebkitBackdropFilter: 'blur(28px) saturate(165%)',
} as const;

const OVERLAY_WASH_STYLE = {
  background:
    'radial-gradient(ellipse 110% 55% at 50% -18%, rgba(88, 166, 255, 0.16), transparent 58%), radial-gradient(ellipse 65% 50% at 108% 42%, rgba(167, 139, 250, 0.11), transparent 52%), radial-gradient(ellipse 55% 48% at -8% 72%, rgba(45, 212, 191, 0.09), transparent 50%), radial-gradient(ellipse 50% 40% at 92% 88%, rgba(251, 191, 36, 0.06), transparent 50%)',
} as const;

const GRID_MASK_STYLE = {
  backgroundImage:
    'linear-gradient(rgba(255,255,255,0.028) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.028) 1px, transparent 1px)',
  backgroundSize: '56px 56px',
  maskImage: 'radial-gradient(ellipse 85% 75% at 50% 38%, black 12%, transparent 72%)',
  WebkitMaskImage: 'radial-gradient(ellipse 85% 75% at 50% 38%, black 12%, transparent 72%)',
} as const;

const CARD_INNER_GLOW_STYLE = {
  background:
    'radial-gradient(ellipse 120% 70% at 50% -30%, rgba(88, 166, 255, 0.09), transparent 55%), radial-gradient(ellipse 80% 50% at 100% 0%, rgba(167, 139, 250, 0.05), transparent 45%)',
} as const;

const MODAL_BACKDROP_TRANSITION = {
  duration: 0.28,
  ease: [0.22, 1, 0.36, 1],
} as const;

const MODAL_PANEL_TRANSITION = {
  duration: 0.38,
  ease: [0.16, 1, 0.3, 1],
} as const;

const DEFAULT_AGENT_ORDER: AgentName[] = ['claude', 'codex', 'opencode', 'pi'];
const DUEL_SIDE_B_ORDER: AgentName[] = ['codex', 'opencode', 'pi', 'claude'];

const MODE_ITEMS = [
  { id: 'single', label: 'Single' },
  { id: 'duel', label: 'Duel' },
] as const;

const REASON_EMPTY_PROMPT = 'Enter a prompt for both agents';
const REASON_IDENTICAL_SIDES = 'Sides must differ in agent, model, or effort';

type ClassicCompatibilityRequest =
  | { kind: 'single'; request: PaneCreateRequest }
  | { kind: 'duel'; request: PaneDuelCreateRequest };

function sideTupleKey(agent: AgentName | undefined, model: string | undefined, effort: string | undefined): string {
  return `${agent ?? ''}|${model ?? ''}|${effort ?? ''}`;
}

function configurationSummary(
  model: string | undefined,
  effort: string | undefined,
  resumeSessionId: string | undefined,
  useWorktree: boolean,
): string {
  const overrides = [model, effort, resumeSessionId ? 'Resume session' : undefined, useWorktree ? 'Worktree on' : undefined]
    .filter((value): value is string => value !== undefined);
  return overrides.length > 0 ? overrides.join(' · ') : 'All defaults · Off worktree';
}

function shouldSubmitOnEnter(e: KeyboardEvent, dialog: HTMLElement | null, modifierRequired: boolean): boolean {
  if (e.metaKey || e.ctrlKey) return true;
  if (modifierRequired) return false;
  if (e.shiftKey || e.altKey) return false;
  const target = e.target;
  if (!(target instanceof HTMLElement)) return true;
  if (!dialog) return false;
  if (!dialog.contains(target)) return true;
  if (target.isContentEditable) return false;
  const tag = target.tagName;
  if (tag === 'TEXTAREA') return false;
  if (tag === 'A') return false;
  if (tag === 'BUTTON' && target.getAttribute('role') !== 'radio') return false;
  return true;
}

function resolvePrimaryAgent(agents: AgentName[]): AgentName | undefined {
  return DEFAULT_AGENT_ORDER.find((candidate) => agents.includes(candidate)) ?? agents[0];
}

function resolveSecondaryAgent(agents: AgentName[], primary: AgentName | undefined): AgentName | undefined {
  const differing = DUEL_SIDE_B_ORDER.find((candidate) => agents.includes(candidate) && candidate !== primary);
  return differing ?? primary ?? resolvePrimaryAgent(agents);
}

interface WorkspaceConfigurationProps {
  effectiveProjectRoot: string | undefined;
  onChange: (projectRoot: string | undefined) => void;
  projectRoot: string | undefined;
  sessionProjectRoot: string;
  target: 'agent' | 'terminal';
}

function WorkspaceConfiguration({
  effectiveProjectRoot,
  onChange,
  projectRoot,
  sessionProjectRoot,
  target,
}: WorkspaceConfigurationProps) {
  const article = target === 'agent' ? 'an' : 'a';
  return (
    <div>
      <label className="mb-1.5 block text-[10px] font-medium uppercase tracking-wider text-[var(--text-secondary)]">
        Workspace
      </label>
      <ProjectPicker value={projectRoot} onChange={onChange} />
      {!sessionProjectRoot && (
        <p className="mt-2 text-[10px] leading-relaxed text-[var(--text-secondary)]" role="status">
          {effectiveProjectRoot
            ? `This folder will open as your active workspace before the ${target} starts.`
            : `Choose a workspace folder to launch ${article} ${target}.`}
        </p>
      )}
    </div>
  );
}

function pruneModel(agent: AgentName, agentDefaults: AgentDefaultsResponse | null, set: (fn: (current: string | undefined) => string | undefined) => void) {
  const catalog = AGENT_TUNING[agent];
  if (agent !== 'opencode') {
    set((current) => (current !== undefined && !isValidOption(catalog.models, current) ? undefined : current));
    return;
  }
  const ids = agentDefaults?.opencode?.availableModels;
  if (ids && ids.length > 0) {
    set((current) => (current !== undefined && !ids.includes(current) ? undefined : current));
  }
}

function pruneEffort(agent: AgentName, set: (fn: (current: string | undefined) => string | undefined) => void) {
  const catalog = AGENT_TUNING[agent];
  set((current) => (current !== undefined && !isValidOption(catalog.efforts, current) ? undefined : current));
}

type CreatePaneModalBackdropProps = {
  children: ReactNode;
  onDismiss: () => void;
};

function CreatePaneModalBackdrop({ children, onDismiss }: CreatePaneModalBackdropProps) {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={MODAL_BACKDROP_TRANSITION}
      className="fixed inset-0 z-[70] overflow-hidden"
    >
      <div aria-hidden className="absolute inset-0" style={OVERLAY_SCRIM_STYLE} />
      <div aria-hidden className="pointer-events-none absolute inset-0" style={OVERLAY_WASH_STYLE} />
      <motion.div
        aria-hidden
        className="pointer-events-none absolute left-1/2 top-[-32%] h-[min(92vh,920px)] w-[min(140vw,1400px)] -translate-x-1/2 rounded-full"
        style={{
          background: 'radial-gradient(closest-side, rgba(88,166,255,0.14), transparent 100%)',
        }}
        animate={{ opacity: [0.45, 0.78, 0.45], scale: [1, 1.06, 1] }}
        transition={{ duration: 11, repeat: Infinity, ease: 'easeInOut' }}
      />
      <motion.div
        aria-hidden
        className="pointer-events-none absolute bottom-[-25%] right-[-18%] h-[min(70vh,640px)] w-[min(85vw,720px)] rounded-full"
        style={{
          background: 'radial-gradient(closest-side, rgba(251,191,36,0.07), transparent 100%)',
        }}
        animate={{ opacity: [0.35, 0.62, 0.35], scale: [1, 1.04, 1] }}
        transition={{ duration: 14, repeat: Infinity, ease: 'easeInOut', delay: 1.2 }}
      />
      <div aria-hidden className="pointer-events-none absolute inset-0 opacity-[0.85]" style={GRID_MASK_STYLE} />
      <div
        role="presentation"
        className="relative flex min-h-full cursor-default items-start justify-center px-4 pb-10 pt-[10vh]"
        onClick={onDismiss}
      >
        {children}
      </div>
    </motion.div>
  );
}

function VsDivider() {
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute left-1/2 top-1/2 z-[2] flex h-7 w-7 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border border-[var(--divider-strong)] bg-[var(--surface-raised)] text-[9px] font-bold uppercase tracking-wider text-[var(--text-secondary)] shadow-sm"
    >
      VS
    </div>
  );
}

export function CreatePaneDialog() {
  const isCreating = usePaneStore((s) => s.isCreating);
  const createMode = usePaneStore((s) => s.createMode);
  const setCreating = usePaneStore((s) => s.setCreating);
  const lastTaskProjectRoot = useTaskDefaultsStore((s) => s.lastTaskProjectRoot);
  const setLastTaskProjectRoot = useTaskDefaultsStore((s) => s.setLastTaskProjectRoot);
  const activeProjectRoot = useProjectStore((s) => s.activeProject?.root);
  const projectSwitching = useProjectStore((s) => s.projectSwitching);
  const setProjectSwitching = useProjectStore((s) => s.setProjectSwitching);
  const sessionProjectRoot = useProjectStore((s) => s.sessionProjectRoot);
  const switchProject = useProjectStore((s) => s.switchProject);
  const { createPane } = usePaneActions();
  const setPendingPane = usePaneStore((s) => s.setPendingPane);
  const setPanes = usePaneStore((s) => s.setPanes);

  const [paneName, setPaneName] = useState('');
  const [mode, setMode] = useState<LaunchMode>('single');
  const [prompt, setPrompt] = useState('');
  const [agent, setAgent] = useState<AgentName | undefined>(undefined);
  const [agentB, setAgentB] = useState<AgentName | undefined>(undefined);
  const [permissionMode, setPermissionMode] = useState<'' | 'auto'>('auto');
  const [useWorktree, setUseWorktree] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [availableAgents, setAvailableAgents] = useState<AgentName[]>([]);
  const [projectRoot, setProjectRoot] = useState<string | undefined>(undefined);
  const [model, setModel] = useState<string | undefined>(undefined);
  const [effort, setEffort] = useState<string | undefined>(undefined);
  const [modelB, setModelB] = useState<string | undefined>(undefined);
  const [effortB, setEffortB] = useState<string | undefined>(undefined);
  const [agentDefaults, setAgentDefaults] = useState<AgentDefaultsResponse | null>(null);
  const [pastSessions, setPastSessions] = useState<PastSession[]>([]);
  const [sessionsTotal, setSessionsTotal] = useState(0);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [resumeSessionId, setResumeSessionId] = useState<string | undefined>(undefined);
  const [classicCompatibilityRequest, setClassicCompatibilityRequest] = useState<ClassicCompatibilityRequest | null>(null);
  const sessionsRequestRef = useRef(0);
  const initializedCreateRef = useRef(false);
  const submissionGateRef = useRef(createSubmissionGate());
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const duelDisabled = availableAgents.length === 0;
  const isDuel = mode === 'duel' && !duelDisabled;

  useEffect(() => {
    if (!isCreating) {
      initializedCreateRef.current = false;
      setPaneName('');
      setMode('single');
      setPrompt('');
      setAgent(undefined);
      setAgentB(undefined);
      setPermissionMode('auto');
      setSubmitting(false);
      setProjectRoot(undefined);
      setModel(undefined);
      setEffort(undefined);
      setModelB(undefined);
      setEffortB(undefined);
      setAgentDefaults(null);
      setPastSessions([]);
      setSessionsTotal(0);
      setSessionsLoading(false);
      setResumeSessionId(undefined);
      setClassicCompatibilityRequest(null);
      sessionsRequestRef.current += 1;
      return;
    }

    if (initializedCreateRef.current) return;
    initializedCreateRef.current = true;
    setMode(createMode);

    const resolvedProjectRoot = resolveDefaultTaskProjectRoot({
      activeProjectRoot,
      sessionProjectRoot,
      lastTaskProjectRoot,
    });
    setProjectRoot(resolvedProjectRoot);
    const defaultsTimeout = new Promise<AgentDefaultsResponse>((_, reject) => {
      setTimeout(() => reject(new Error('agent-defaults timeout')), 5000);
    });
    Promise.race([getAgentDefaults(resolvedProjectRoot), defaultsTimeout])
      .then(setAgentDefaults)
      .catch(() => setAgentDefaults({ claude: {}, codex: {}, opencode: {}, pi: {} }));
  }, [isCreating, createMode, activeProjectRoot, sessionProjectRoot, lastTaskProjectRoot]);

  useEffect(() => {
    if (!isCreating) return;
    const capability = mode === 'duel' ? 'duel' : 'launch';
    void listAgents(capability).then(setAvailableAgents).catch(() => {});
    // Paint from the boot cache immediately, then refresh in the background so
    // agents installed while Amux is running appear on the next dialog open.
    void refreshAgents(capability).then(setAvailableAgents).catch(() => {});
  }, [isCreating, mode]);

  useEffect(() => {
    if (!isCreating || availableAgents.length === 0) return;
    setAgent((currentAgent) => {
      if (currentAgent && availableAgents.includes(currentAgent)) return currentAgent;
      return resolvePrimaryAgent(availableAgents);
    });
  }, [isCreating, availableAgents]);

  useEffect(() => {
    if (!isCreating) return;
    if (!isDuel) {
      setAgentB(undefined);
      setModelB(undefined);
      setEffortB(undefined);
      return;
    }
    setAgentB((currentAgentB) => {
      if (currentAgentB && availableAgents.includes(currentAgentB) && currentAgentB !== agent) return currentAgentB;
      return resolveSecondaryAgent(availableAgents, agent);
    });
  }, [isCreating, isDuel, agent, availableAgents]);

  useEffect(() => {
    if (!isCreating) return;
    settingsApi.getSettings({ projectRoot })
      .then((settings) => {
        setUseWorktree(settings.useWorktree ?? false);
        setPermissionMode(settings.permissionMode === '' ? '' : 'auto');
      })
      .catch(() => {});
  }, [isCreating, projectRoot]);

  useEffect(() => {
    if (!isCreating || !initializedCreateRef.current) return;
    const controller = new AbortController();
    getAgentDefaults(projectRoot)
      .then((r) => { if (!controller.signal.aborted) setAgentDefaults(r); })
      .catch(() => { if (!controller.signal.aborted) setAgentDefaults({ claude: {}, codex: {}, opencode: {}, pi: {} }); });
    return () => controller.abort();
  }, [isCreating, projectRoot]);

  useEffect(() => {
    if (!isCreating || !agent) return;
    pruneModel(agent, agentDefaults, setModel);
    pruneEffort(agent, setEffort);
  }, [isCreating, agent, agentDefaults]);

  useEffect(() => {
    if (!isCreating || !isDuel || !agentB) return;
    pruneModel(agentB, agentDefaults, setModelB);
    pruneEffort(agentB, setEffortB);
  }, [isCreating, isDuel, agentB, agentDefaults]);

  const effectiveProjectRoot = projectRoot || activeProjectRoot || sessionProjectRoot || undefined;

  const fetchSessions = useCallback((sessionAgent: AgentName, root: string, limit?: number) => {
    const requestId = sessionsRequestRef.current + 1;
    sessionsRequestRef.current = requestId;
    setSessionsLoading(true);
    paneApi.listPaneSessions({ agent: sessionAgent, projectRoot: root, limit })
      .then((res) => {
        if (sessionsRequestRef.current !== requestId) return;
        setPastSessions(res.sessions);
        setSessionsTotal(res.total ?? res.sessions.length);
        setSessionsLoading(false);
      })
      .catch(() => {
        if (sessionsRequestRef.current !== requestId) return;
        setPastSessions([]);
        setSessionsTotal(0);
        setSessionsLoading(false);
      });
  }, []);

  useEffect(() => {
    if (!isCreating || isDuel || !agent || !effectiveProjectRoot) return;
    setResumeSessionId(undefined);
    fetchSessions(agent, effectiveProjectRoot, PAST_SESSIONS_INITIAL_VISIBLE);
  }, [isCreating, isDuel, agent, effectiveProjectRoot, fetchSessions]);

  const handleShowAllSessions = useCallback(() => {
    if (!agent || !effectiveProjectRoot) return;
    fetchSessions(agent, effectiveProjectRoot);
  }, [agent, effectiveProjectRoot, fetchSessions]);

  const handleClose = useCallback(() => {
    if (!submitting) setCreating(false);
  }, [submitting, setCreating]);

  const addToast = useNotificationStore((s) => s.addToast);
  const handleProjectRootChange = useCallback((nextProjectRoot: string | undefined) => {
    setProjectRoot(nextProjectRoot);
    setLastTaskProjectRoot(nextProjectRoot);
  }, [setLastTaskProjectRoot]);

  const handleAgentSelect = useCallback((nextAgent: AgentName) => {
    setAgent(nextAgent);
    setResumeSessionId(undefined);
  }, []);

  const trimmedPrompt = prompt.trim();
  const sidesDiffer = sideTupleKey(agent, model, effort) !== sideTupleKey(agentB, modelB, effortB);
  const duelReason = !trimmedPrompt ? REASON_EMPTY_PROMPT : !sidesDiffer ? REASON_IDENTICAL_SIDES : undefined;
  const duelValid = isDuel && agent !== undefined && agentB !== undefined && duelReason === undefined;
  const singleValid = !isDuel && agent !== undefined;
  const canSubmit = (isDuel ? duelValid : singleValid)
    && effectiveProjectRoot !== undefined
    && !submitting
    && !projectSwitching;

  const prepareWorkspace = useCallback(async (): Promise<{ projectRoot?: string } | null> => {
    const targetRoot = effectiveProjectRoot;
    if (!targetRoot) return null;

    // A ready session may intentionally launch panes rooted in another project.
    // Only first launch needs to turn the selected folder into the session owner.
    if (sessionProjectRoot) return { projectRoot };

    setProjectSwitching(true);
    try {
      await switchProject(targetRoot);
      const activatedRoot = useProjectStore.getState().sessionProjectRoot;
      if (activatedRoot !== targetRoot) {
        addToast(
          'Amux could not open the selected workspace.',
          'error',
          {
            detail: 'Choose the folder again and make sure it still exists and is accessible.',
            title: 'Workspace not ready',
          },
        );
        return null;
      }

      setPanes(await paneApi.listPanes());
      return { projectRoot: targetRoot };
    } catch (error) {
      addToast(
        `Amux could not open the selected workspace: ${(error as Error).message}`,
        'error',
        {
          detail: 'Choose the folder again and make sure it still exists and is accessible.',
          title: 'Workspace not ready',
        },
      );
      return null;
    } finally {
      setProjectSwitching(false);
    }
  }, [addToast, effectiveProjectRoot, projectRoot, sessionProjectRoot, setPanes, setProjectSwitching, switchProject]);

  const runDuel = useCallback(async (): Promise<boolean> => {
    if (!agent || !agentB) return false;
    const preparedWorkspace = await prepareWorkspace();
    if (!preparedWorkspace) return false;
    const sides: [DuelSideConfig, DuelSideConfig] = [
      { agent, model, effort },
      { agent: agentB, model: modelB, effort: effortB },
    ];
    const request: PaneDuelCreateRequest = {
      prompt: trimmedPrompt,
      sides,
      useWorktree,
      projectRoot: preparedWorkspace.projectRoot,
      paneName: paneName.trim() || undefined,
    };
    try {
      const result = await paneApi.createDuelPanes(request);
      if (result.survivorPaneId) {
        const survivor = result.paneA?.slug ?? 'Side A';
        addToast(`${survivor} is running, but the other Duel side failed: ${result.error ?? 'Unknown launch error'}`, 'warning');
        return true;
      }
      if (result.claudeFullscreenPreflightFailed) {
        setClassicCompatibilityRequest({
          kind: 'duel',
          request: { ...request, claudeRenderer: 'classic' },
        });
        return false;
      }
      if (result.success) {
        const label = `${result.paneA?.slug ?? 'Side A'} vs ${result.paneB?.slug ?? 'Side B'}`;
        addToast(`Duel started: ${label}`, 'success');
        return true;
      }
      addToast(result.error ?? 'Failed to start Duel', 'error');
      return false;
    } catch (error) {
      addToast(`Failed to start Duel: ${(error as Error).message}`, 'error');
      return false;
    }
  }, [agent, agentB, model, effort, modelB, effortB, trimmedPrompt, useWorktree, paneName, addToast, prepareWorkspace]);

  const runSingle = useCallback(async (): Promise<boolean> => {
    if (!agent) return false;
    const preparedWorkspace = await prepareWorkspace();
    if (!preparedWorkspace) return false;
    setPendingPane({ agent, prompt: '' });
    const request: PaneCreateRequest = {
      prompt: '',
      agent,
      projectRoot: preparedWorkspace.projectRoot,
      useWorktree,
      paneName: paneName.trim() || undefined,
      model,
      effort,
      resumeSessionId,
    };
    const result = await createPane(request);
    if (result?.claudeFullscreenPreflightFailed) {
      setClassicCompatibilityRequest({
        kind: 'single',
        request: { ...request, claudeRenderer: 'classic' },
      });
    }
    return result?.success === true;
  }, [agent, prepareWorkspace, setPendingPane, createPane, useWorktree, paneName, model, effort, resumeSessionId]);

  const handleClassicCompatibility = useCallback(async () => {
    if (!classicCompatibilityRequest || submitting) return;
    setSubmitting(true);
    try {
      const result = classicCompatibilityRequest.kind === 'single'
        ? await createPane(classicCompatibilityRequest.request)
        : await paneApi.createDuelPanes(classicCompatibilityRequest.request);
      if (result?.success) {
        setClassicCompatibilityRequest(null);
        setCreating(false);
      }
    } finally {
      setSubmitting(false);
    }
  }, [classicCompatibilityRequest, createPane, setCreating, submitting]);

  const handleUpdateClaude = useCallback(() => {
    setClassicCompatibilityRequest(null);
    addToast('Update Claude Code to 2.1.220 or newer, then launch the pane again.', 'info');
  }, [addToast]);

  const handleSubmit = useCallback(async () => {
    if (!canSubmit) return;
    await submissionGateRef.current.run(async () => {
      setSubmitting(true);
      let shouldClose = false;
      try {
        if (isDuel) {
          shouldClose = await runDuel();
        } else {
          shouldClose = await runSingle();
        }
      } finally {
        if (shouldClose) setCreating(false);
        setSubmitting(false);
      }
    });
  }, [canSubmit, isDuel, runDuel, runSingle, setCreating]);

  const handleTerminalOnly = useCallback(async () => {
    if (projectSwitching || !effectiveProjectRoot) return;
    await submissionGateRef.current.run(async () => {
      setSubmitting(true);
      try {
        const preparedWorkspace = await prepareWorkspace();
        if (!preparedWorkspace) return;
        const result = await createPane({
          prompt: '',
          type: 'shell',
          projectRoot: preparedWorkspace.projectRoot,
        });
        if (result?.success) setCreating(false);
      } finally {
        setSubmitting(false);
      }
    });
  }, [createPane, effectiveProjectRoot, prepareWorkspace, projectSwitching, setCreating]);

  useEffect(() => {
    if (!isCreating) return;
    const handler = (e: KeyboardEvent) => {
      if (classicCompatibilityRequest) return;
      if (e.key === 'Escape') {
        handleClose();
        return;
      }
      if (e.key === 'Enter' && shouldSubmitOnEnter(e, dialogRef.current, isDuel)) {
        e.preventDefault();
        if (canSubmit) handleSubmit();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [isCreating, isDuel, handleClose, canSubmit, handleSubmit, classicCompatibilityRequest]);

  const submitLabel = isDuel
    ? 'Start duel'
    : sessionProjectRoot
      ? agent === 'pi' ? 'Launch Pi' : 'Launch Pane'
      : agent === 'pi' ? 'Open Workspace & Launch Pi' : 'Open Workspace & Launch';

  return (
    <AnimatePresence>
      {isCreating && (
        <CreatePaneModalBackdrop onDismiss={handleClose}>
          <motion.div
            initial={{ opacity: 0, y: 12, scale: 0.985, filter: 'blur(10px)' }}
            animate={{ opacity: 1, y: 0, scale: 1, filter: 'blur(0px)' }}
            exit={{ opacity: 0, y: 10, scale: 0.99, filter: 'blur(5px)' }}
            transition={MODAL_PANEL_TRANSITION}
            onClick={(e) => e.stopPropagation()}
            className={cn(
              'w-full transform-gpu cursor-auto p-[1.5px] rounded-[24px] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.05),0_32px_64px_-24px_rgba(0,0,0,0.65),0_0_120px_-40px_rgba(88,166,255,0.35)] will-change-transform',
              isDuel ? 'max-w-[760px]' : 'max-w-[580px]',
            )}
            style={GRADIENT_BORDER_STYLE}
          >
            <div
              ref={dialogRef}
              role="dialog"
              aria-modal="true"
              aria-labelledby="create-pane-dialog-title"
              className={cn(
                'relative max-h-[80vh] overflow-y-auto rounded-[22.5px]',
                'shadow-[inset_0_1px_0_0_rgba(255,255,255,0.09),inset_0_0_0_1px_rgba(255,255,255,0.04)]',
              )}
              style={GLASS_PANEL_STYLE}
            >
              <div
                aria-hidden
                className="pointer-events-none absolute inset-0 rounded-[22.5px]"
                style={CARD_INNER_GLOW_STYLE}
              />
              <div className="relative z-[1] flex items-center justify-between px-5 pt-5 pb-1">
                <div className="flex flex-col gap-0.5">
                  <span className="text-[11px] font-medium uppercase tracking-[0.14em] text-[var(--text-secondary)]">
                    Launch
                  </span>
                  <span id="create-pane-dialog-title" className="text-lg font-semibold tracking-[-0.03em] text-[var(--text)]">
                    New Pane
                  </span>
                </div>
                <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-[color-mix(in_srgb,var(--text)_4%,transparent)] border border-[var(--divider)]">
                  <Pencil size={11} className="text-[var(--text-secondary)]" />
                  <input
                    type="text"
                    value={paneName}
                    onChange={(e) => setPaneName(e.target.value)}
                    placeholder="Name (optional)"
                    className="w-[110px] bg-transparent text-xs text-[var(--text-secondary)] outline-none placeholder:text-[var(--text-secondary)]"
                  />
                </div>
              </div>

              <div className="relative z-[1] px-5 pt-3 pb-1">
                <SegmentedTabs
                  items={MODE_ITEMS}
                  value={isDuel ? 'duel' : 'single'}
                  onChange={(next) => { if (next === 'duel' && duelDisabled) return; setMode(next); }}
                  layoutId="create-pane-mode"
                />
              </div>

              {isDuel ? (
                <>
                  <div className="relative z-[1] px-5 pt-3">
                    <div className="relative grid grid-cols-2 gap-3">
                      <DuelSideCard
                        accent="a"
                        agents={availableAgents}
                        agent={agent}
                        onAgentSelect={handleAgentSelect}
                        model={model}
                        effort={effort}
                        onModelChange={setModel}
                        onEffortChange={setEffort}
                        agentDefaults={agentDefaults}
                      />
                      <DuelSideCard
                        accent="b"
                        agents={availableAgents}
                        agent={agentB}
                        onAgentSelect={setAgentB}
                        model={modelB}
                        effort={effortB}
                        onModelChange={setModelB}
                        onEffortChange={setEffortB}
                        agentDefaults={agentDefaults}
                        order={DUEL_SIDE_B_ORDER}
                      />
                      <VsDivider />
                    </div>
                  </div>
                  <div className="relative z-[1] px-5 pt-3">
                    <label className="mb-1.5 block text-[10px] font-medium uppercase tracking-wider text-[var(--text-secondary)]">
                      Prompt — sent to both agents
                    </label>
                    <textarea
                      value={prompt}
                      onChange={(e) => setPrompt(e.target.value)}
                      rows={3}
                      autoFocus
                      placeholder="Ask both agents the same question…"
                      className="w-full resize-none rounded-[12px] border border-[var(--divider)] bg-[color-mix(in_srgb,var(--text)_2%,transparent)] px-3 py-2.5 text-[13px] leading-relaxed text-[var(--text)] outline-none transition-colors placeholder:text-[var(--text-secondary)] focus:border-[var(--divider-strong)]"
                    />
                  </div>
                </>
              ) : (
                <>
                  <div className="relative z-[1] px-5 py-4">
                    <AgentSelector
                      agents={availableAgents}
                      selected={agent}
                      onSelect={handleAgentSelect}
                      autoFocus
                    />
                  </div>

                  {agent && (
                    <div className="relative z-[1] px-5 pb-4">
                      <ConfigurationDisclosure
                        agent={agent}
                        summary={configurationSummary(model, effort, resumeSessionId, useWorktree)}
                      >
                        <AgentTuning
                          agent={agent}
                          model={model}
                          effort={effort}
                          onModelChange={setModel}
                          onEffortChange={setEffort}
                          defaults={agentDefaults?.[agent]}
                          opencodeDefaults={agentDefaults?.opencode}
                          defaultsLoading={agentDefaults === null}
                        />
                        <SessionPicker
                          sessions={pastSessions}
                          value={resumeSessionId}
                          onChange={setResumeSessionId}
                          loading={sessionsLoading}
                          totalCount={sessionsTotal}
                          onShowAll={handleShowAllSessions}
                        />
                        <WorkspaceConfiguration
                          effectiveProjectRoot={effectiveProjectRoot}
                          onChange={handleProjectRootChange}
                          projectRoot={projectRoot}
                          sessionProjectRoot={sessionProjectRoot}
                          target="agent"
                        />
                        <QuickSettings
                          agent={agent}
                          onUseWorktreeChange={setUseWorktree}
                          permissionMode={permissionMode}
                          useWorktree={useWorktree}
                        />
                      </ConfigurationDisclosure>
                    </div>
                  )}
                  {!agent && (
                    <div className="relative z-[1] px-5 pb-4">
                      <WorkspaceConfiguration
                        effectiveProjectRoot={effectiveProjectRoot}
                        onChange={handleProjectRootChange}
                        projectRoot={projectRoot}
                        sessionProjectRoot={sessionProjectRoot}
                        target="terminal"
                      />
                    </div>
                  )}
                </>
              )}

              {isDuel && <div className="relative z-[1] px-5 pt-3 pb-3">
                <WorkspaceConfiguration
                  effectiveProjectRoot={effectiveProjectRoot}
                  onChange={handleProjectRootChange}
                  projectRoot={projectRoot}
                  sessionProjectRoot={sessionProjectRoot}
                  target="agent"
                />
              </div>}

              {isDuel && <div className="relative z-[1] px-5 pb-3">
                <QuickSettings
                  agent={agent}
                  onUseWorktreeChange={setUseWorktree}
                  permissionMode={permissionMode}
                  useWorktree={useWorktree}
                />
              </div>}

              <div className="relative z-[1] flex flex-col gap-2 border-t border-[var(--divider)] bg-gradient-to-t from-transparent to-[color-mix(in_srgb,var(--text)_2%,transparent)] px-5 py-3.5">
                {isDuel && duelReason && (
                  <span className="text-[10px] font-medium text-[var(--text-secondary)]">{duelReason}</span>
                )}
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2.5">
                    <span className="text-[10px] text-[var(--text-secondary)]">
                      <Kbd keys="Esc" /> close
                    </span>
                    <span className="text-[10px] text-[var(--text-secondary)]">
                      <Kbd keys={isDuel ? '⌘↵' : '↵'} /> {isDuel ? 'start' : 'launch'}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={handleTerminalOnly}
                      disabled={submitting || projectSwitching || !effectiveProjectRoot}
                      className={cn(
                        'flex items-center gap-1.5 px-3.5 py-2 rounded-[10px] text-[11px] font-medium transition-all',
                        'border border-[var(--divider)] text-[var(--text-secondary)]',
                        'hover:border-[var(--divider-strong)] hover:text-[var(--text)]',
                        'disabled:opacity-40 disabled:cursor-not-allowed',
                      )}
                    >
                      <Terminal size={12} />
                      Terminal
                    </button>
                    <button
                      type="button"
                      onClick={handleSubmit}
                      disabled={!canSubmit}
                      className={cn(
                        'flex items-center gap-2 px-5 py-2 rounded-[10px] text-xs font-semibold transition-all',
                        'text-white shadow-[0_0_24px_-6px_rgba(74,108,247,0.45)]',
                        'hover:translate-y-[-1px] hover:shadow-[0_0_32px_-4px_rgba(74,108,247,0.55)]',
                        'disabled:opacity-40 disabled:cursor-not-allowed disabled:shadow-none disabled:translate-y-0',
                      )}
                      style={LAUNCH_BUTTON_STYLE}
                    >
                      {submitting && <Spinner size="sm" className="border-white/30 border-t-white" />}
                      {submitLabel}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </motion.div>
        </CreatePaneModalBackdrop>
      )}
      <ConfirmDialog
        cancelLabel="Update Claude"
        confirmLabel="Use classic compatibility mode"
        initialFocus="cancel"
        message="This Claude version cannot satisfy Amux's fullscreen renderer contract. Update Claude for protected terminal history, or explicitly launch this pane in known-lossy classic compatibility mode and use Activity for conversation history."
        onCancel={handleUpdateClaude}
        onConfirm={handleClassicCompatibility}
        open={classicCompatibilityRequest !== null}
        pending={submitting}
        title="Claude update required"
      />
    </AnimatePresence>
  );
}
