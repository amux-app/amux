import type { MuxBasePane } from 'muxbase/core';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useFlipReorder } from '../../hooks/useFlipReorder';
import { cn } from '../../lib/cn';
import type { ActiveProjectSource } from '../../lib/pane-project-display';
import { resolveSidebarDisplayOrder } from '../../lib/sidebar-display-order';
import { orderSidebarPanes, type SidebarGroup, type SidebarStatusLookup } from '../../lib/sidebar-order';
import { useUiStore } from '../../stores';
import { usePaneActivityStore } from '../../stores/pane-activity.store';
import { SidebarAgentRow } from './SidebarAgentRow';
import { SIDEBAR_ROW_CLASS } from './SidebarRow';

const GROUP_CAP = 5;
const MUTED_TEXT_CLASS = 'text-[13px] text-[var(--sidebar-text-muted)]';
const AGENTS_LIST_ARIA_LABEL = 'Agents';

const GROUP_HEADER_CLASS = cn(
  'mt-[8px] flex h-[26px] items-center gap-[4px] px-[8px]',
  'text-[11px] leading-[1.3] font-semibold tracking-[0.08em] uppercase text-[var(--sidebar-text-muted)]',
);

interface SidebarAgentListProps {
  activeProject: ActiveProjectSource | null;
  hiddenPaneIds: Set<string>;
  hydrating: boolean;
  onCreateFirst: () => void;
  onDelete: (paneId: string) => Promise<boolean>;
  onRename: (paneId: string, name: string) => void | Promise<void>;
  onSelect: (paneId: string) => void;
  panes: MuxBasePane[];
  selectedPaneId: string | null;
  statusOf: SidebarStatusLookup;
  titleOf: ReadonlyMap<string, string>;
}

interface SidebarGroupViewProps {
  expanded: boolean;
  group: SidebarGroup;
  hiddenPaneIds: Set<string>;
  index: number;
  onDelete: (paneId: string) => Promise<boolean>;
  onRename: (paneId: string, name: string) => void | Promise<void>;
  onSelect: (paneId: string) => void;
  onToggleExpand: (key: string) => void;
  selectedPaneId: string | null;
  statusOf: SidebarStatusLookup;
  titleOf: ReadonlyMap<string, string>;
}

/** The index (stable per render, unique across the ordered groups) disambiguates
 * sanitized keys that would otherwise collapse together, e.g. `/p/my.app` and
 * `/p/my-app` both sanitize to `p-my-app`. */
function sidebarGroupHeadingId(key: string, index: number): string {
  return `sidebar-group-${index}-${key.replace(/[^a-zA-Z0-9_-]+/g, '-')}`;
}

function SidebarGroupView({
  expanded,
  group,
  hiddenPaneIds,
  index,
  onDelete,
  onRename,
  onSelect,
  onToggleExpand,
  selectedPaneId,
  statusOf,
  titleOf,
}: Readonly<SidebarGroupViewProps>) {
  const visible = expanded ? group.panes : group.panes.slice(0, GROUP_CAP);
  const hiddenCount = group.panes.length - visible.length;
  const headingId = sidebarGroupHeadingId(group.key, index);

  return (
    <div data-flip-id={group.key}>
      {group.label !== null && (
        <div className={GROUP_HEADER_CLASS} data-testid="sidebar-group-header" id={headingId}>
          {group.label}
          <span className="opacity-[0.72]">· {group.panes.length}</span>
        </div>
      )}
      <ul
        aria-label={group.label === null ? AGENTS_LIST_ARIA_LABEL : undefined}
        aria-labelledby={group.label === null ? undefined : headingId}
        className="flex flex-col gap-[1px]"
      >
        {visible.map((pane) => (
          <SidebarAgentRow
            key={pane.id}
            hidden={hiddenPaneIds.has(pane.id)}
            onDelete={onDelete}
            onRename={onRename}
            onSelect={onSelect}
            pane={pane}
            selected={selectedPaneId === pane.id}
            sessionTitle={titleOf.get(pane.id)}
            status={statusOf.get(pane.id)}
          />
        ))}
        {hiddenCount > 0 && (
          <li>
            <button
              type="button"
              onClick={() => onToggleExpand(group.key)}
              className={cn(SIDEBAR_ROW_CLASS, 'text-[13px] text-[var(--sidebar-text-muted)]')}
            >
              {`Show ${hiddenCount} more`}
            </button>
          </li>
        )}
        {expanded && group.panes.length > GROUP_CAP && (
          <li>
            <button
              type="button"
              onClick={() => onToggleExpand(group.key)}
              className={cn(SIDEBAR_ROW_CLASS, 'text-[13px] text-[var(--sidebar-text-muted)]')}
            >
              Show less
            </button>
          </li>
        )}
      </ul>
    </div>
  );
}

export function SidebarAgentList({
  activeProject,
  hiddenPaneIds,
  hydrating,
  onCreateFirst,
  onDelete,
  onRename,
  onSelect,
  panes,
  selectedPaneId,
  statusOf,
  titleOf,
}: Readonly<SidebarAgentListProps>) {
  const organize = useUiStore((s) => s.sidebarOrganize);
  const sort = useUiStore((s) => s.sidebarSort);
  const activityByPaneId = usePaneActivityStore((s) => s.activityByPaneId);
  const [expandedGroups, setExpandedGroups] = useState<ReadonlySet<string>>(() => new Set());
  const [pointerInside, setPointerInside] = useState(false);
  const heldGroupsRef = useRef<SidebarGroup[] | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const targetGroups = useMemo(
    () => orderSidebarPanes(panes, organize, sort, statusOf, activityByPaneId, activeProject),
    [activeProject, activityByPaneId, organize, panes, sort, statusOf],
  );

  const displayGroups = useMemo(
    () => resolveSidebarDisplayOrder(targetGroups, pointerInside ? heldGroupsRef.current : null, pointerInside),
    [pointerInside, targetGroups],
  );

  // A membership change forces displayGroups to fall back to targetGroups even
  // while hovering. Re-arm the held snapshot to that fresh order so the hold
  // resumes on the next tick instead of staying broken for the rest of the hover.
  useEffect(() => {
    if (pointerInside && displayGroups === targetGroups) {
      heldGroupsRef.current = targetGroups;
    }
  }, [displayGroups, pointerInside, targetGroups]);

  const isEmptyBranch = hydrating || panes.length === 0;
  useEffect(() => {
    if (isEmptyBranch) {
      setPointerInside(false);
      heldGroupsRef.current = null;
    }
  }, [isEmptyBranch]);

  useFlipReorder(containerRef);

  const handleToggleExpand = useCallback((key: string) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }, []);

  const handlePointerEnter = useCallback(() => {
    heldGroupsRef.current = targetGroups;
    setPointerInside(true);
  }, [targetGroups]);
  const handlePointerLeave = useCallback(() => setPointerInside(false), []);

  if (hydrating) {
    return (
      <p role="status" className={`px-[8px] py-6 text-center ${MUTED_TEXT_CLASS}`}>
        Loading agents…
      </p>
    );
  }

  if (panes.length === 0) {
    return (
      <div className="px-[8px] py-6 text-center">
        <p className={MUTED_TEXT_CLASS}>No agents running</p>
        <button
          type="button"
          onClick={onCreateFirst}
          className="sidebar-focus mt-1 inline-flex h-[24px] items-center rounded-[6px] px-2 text-[13px] font-medium text-[var(--accent)] hover:underline"
        >
          Launch your first agent
        </button>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      data-sidebar-agent-list="true"
      data-testid="sidebar-agent-list"
      onPointerEnter={handlePointerEnter}
      onPointerLeave={handlePointerLeave}
    >
      {displayGroups.map((group, index) => (
        <SidebarGroupView
          key={group.key}
          expanded={expandedGroups.has(group.key)}
          group={group}
          hiddenPaneIds={hiddenPaneIds}
          index={index}
          onDelete={onDelete}
          onRename={onRename}
          onSelect={onSelect}
          onToggleExpand={handleToggleExpand}
          selectedPaneId={selectedPaneId}
          statusOf={statusOf}
          titleOf={titleOf}
        />
      ))}
    </div>
  );
}
