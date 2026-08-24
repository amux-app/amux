import { PanelLeft, Plus, Shrink, SquarePen } from 'lucide-react';
import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Group, Panel, Separator, usePanelRef } from 'react-resizable-panels';
import { getAppInfo } from '../../api/system.api';
import { useCompactSidebarViewport } from '../../hooks/useCompactSidebarViewport';
import { useFileBrowserWatch } from '../../hooks/useFileBrowserWatch';
import { useSidebarCollapsed } from '../../hooks/useSidebarCollapsed';
import { useSidebarPreferences } from '../../hooks/useSidebarPreferences';
import { cn } from '../../lib/cn';
import { clampSidebarWidth, HEADER_ICON_BUTTON_CLASS, OVERLAY_CHROME_Z_CLASS, SIDEBAR_TOGGLE_LABEL, SIDEBAR_TOGGLE_TOOLTIP } from '../../lib/constants';
import { IS_MAC } from '../../lib/platform';
import { useFileBrowserStore, usePaneStore, useUiStore } from '../../stores';
import { AttentionStat } from '../dashboard/AttentionStat';
import {
  FILE_BROWSER_CROWDED_RESIZE_HANDLE_CLASS,
  FILE_BROWSER_RESIZE_TARGET_MINIMUM_SIZE,
  FILE_BROWSER_SHELL_RESIZE_HANDLE_CLASS,
  FILE_BROWSER_SHELL_SEPARATOR_ID,
} from '../file-browser/fileBrowserLayout';
import { HelpOverlay } from '../shared/HelpOverlay';
import { HoverTooltip } from '../shared/HoverTooltip';
import { RendererErrorBoundary } from '../shared/RendererErrorBoundary';
import { ContentArea } from './ContentArea';
import { Sidebar } from './Sidebar';
import { AppUpdateControl } from './AppUpdateControl';
import { NEW_AGENT_LABEL } from './SidebarCreateButton';
import { TitleBarStatus } from './TitleBarStatus';
import {
  SIDEBAR_COLLAPSE_KEY,
  SIDEBAR_CONTENT_MIN_SIZE,
  SIDEBAR_DRAGGING_ATTRIBUTE,
  SIDEBAR_LIVE_WIDTH_VALUE,
  SIDEBAR_LIVE_WIDTH_VAR,
  SIDEBAR_PANEL_CLASS,
  SIDEBAR_PANEL_COLLAPSED_SIZE,
  SIDEBAR_PANEL_ID,
  SIDEBAR_PANEL_MAX_SIZE,
  SIDEBAR_PANEL_MIN_SIZE,
  SIDEBAR_RESIZE_HANDLE_CLASS,
  SIDEBAR_RESIZE_KEYS,
  SIDEBAR_SEPARATOR_ID,
} from './sidebarLayout';
import { SIDEBAR_CHROME_ICON_CLASS, SIDEBAR_ICON_SIZE, SIDEBAR_ICON_STROKE } from './SidebarRow';

const COMPACT_SIDEBAR_HINT = 'Widen the window to expand the sidebar';

const FileBrowserPanel = lazy(async () => {
  const module = await import('../file-browser/FileBrowserPanel');
  return { default: module.FileBrowserPanel };
});

/**
 * Marks a programmatic panel.resize() (window-resize reconcile, zoom reconcile,
 * collapse/expand re-assert) so it snaps in one frame instead of riding the
 * `.sidebar-panel` transition — the same suppression a pointer drag gets from
 * `SIDEBAR_DRAGGING_ATTRIBUTE`, just for resizes the user didn't initiate.
 */
const SIDEBAR_PROGRAMMATIC_ATTRIBUTE = 'data-sidebar-programmatic';

// 44px strip, flex-centred on the same line the lights are placed on from main.
const TITLEBAR_STRIP_CLASS =
  'relative isolate flex h-11 shrink-0 items-center bg-[var(--bg)] [-webkit-app-region:drag]';

// With lights on screen they own a 76px gutter (three 12px circles from x=18 on a
// 23px pitch) plus a 10px gap. Fullscreen and non-macOS have none, so the cluster
// falls back to the sidebar's own 8px inset instead of floating in dead space.
const TITLEBAR_LIGHTS_GUTTER_CLASS = 'pl-[86px]';
const TITLEBAR_PLAIN_GUTTER_CLASS = 'pl-[8px]';

const TITLEBAR_BUTTON_CLASS = cn(
  SIDEBAR_CHROME_ICON_CLASS,
  'disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-[var(--sidebar-icon)]',
  '[-webkit-app-region:no-drag]',
);

const ZEN_CHIP_BUTTON_CLASS = cn(
  HEADER_ICON_BUTTON_CLASS,
  'text-[var(--text-muted)] hover:bg-[var(--surface-raised)] hover:text-[var(--accent)]',
);

// Chrome layer: an open modal backdrop covers the chip instead of racing it on DOM order.
const ZEN_CHIP_CONTAINER_CLASS = cn(
  'fixed top-0 right-2 flex h-11 items-center gap-1.5 [-webkit-app-region:no-drag]',
  OVERLAY_CHROME_Z_CLASS,
);

export function AppShell() {
  useFileBrowserWatch();
  const fileBrowserOpen = useFileBrowserStore((s) => s.isOpen);
  const viewerCrowded = useFileBrowserStore((s) => s.viewerCrowded);
  const zenMode = useUiStore((s) => s.zenMode);
  const sidebarWidth = useUiStore((s) => s.sidebarWidth);
  const windowFullScreen = useUiStore((s) => s.windowFullScreen);
  const sidebarCollapsed = useSidebarCollapsed();
  const compactViewport = useCompactSidebarViewport();
  const trafficLightsVisible = IS_MAC && !windowFullScreen;
  const filePanelRef = usePanelRef();
  const sidebarPanelRef = usePanelRef();
  const sidebarPanelElementRef = useRef<HTMLDivElement>(null);
  const groupElementRef = useRef<HTMLDivElement>(null);
  const shellRef = useRef<HTMLDivElement>(null);
  /** A pointer drag or keyboard resize is in flight; only those write preferences. */
  const userResizeRef = useRef(false);
  /** Group width in px, measured once per drag so no move tick forces a layout flush. */
  const groupWidthRef = useRef<number | null>(null);
  /** Latest computed column width in px, waiting for its animation frame. */
  const pendingSidebarWidthRef = useRef<number | null>(null);
  const sidebarWidthFrameRef = useRef<number | null>(null);
  /** The pending frames clearing SIDEBAR_PROGRAMMATIC_ATTRIBUTE after a re-assert settles. */
  const programmaticSidebarFrameRef = useRef<number | null>(null);
  const isSidebarDragging = useCallback(
    () => shellRef.current?.getAttribute(SIDEBAR_DRAGGING_ATTRIBUTE) === 'true',
    [],
  );
  const { setWidth, toggleCollapsed } = useSidebarPreferences();
  const [showDevMarker, setShowDevMarker] = useState(false);
  const sidebarHidden = zenMode || sidebarCollapsed;

  // The library reserves `className` for an inner div, so the sized element is
  // reached through `elementRef` — that is where the collapse transition lives.
  useEffect(() => {
    sidebarPanelElementRef.current?.classList.add(SIDEBAR_PANEL_CLASS);
  }, []);

  useLayoutEffect(() => {
    shellRef.current?.style.setProperty(SIDEBAR_LIVE_WIDTH_VAR, `${sidebarWidth}px`);
  }, [sidebarWidth]);

  // The preference is authoritative: the panel is driven to it rather than left at
  // whatever size the library remembered. This is always a programmatic call — the
  // pointer drag path never calls it — so it borrows the drag's own transition
  // suppression rather than animating through the 200ms `.sidebar-panel` transition,
  // which would desync the column from the CSS-var-driven inner surface and, on
  // Electron zoom, re-assert against a transition-mid-flight (transient) denominator.
  const applySidebarWidth = useCallback(() => {
    const panel = sidebarPanelRef.current;
    if (!panel) return;
    if (programmaticSidebarFrameRef.current !== null) {
      cancelAnimationFrame(programmaticSidebarFrameRef.current);
      programmaticSidebarFrameRef.current = null;
    }
    const shell = shellRef.current;
    shell?.setAttribute(SIDEBAR_PROGRAMMATIC_ATTRIBUTE, 'true');
    panel.resize(sidebarHidden ? SIDEBAR_PANEL_COLLAPSED_SIZE : `${sidebarWidth}px`);
    // Two frames: one for the resize to paint, one to confirm nothing else re-queued
    // it — the same double-rAF the zoom reconcile below already relies on.
    programmaticSidebarFrameRef.current = requestAnimationFrame(() => {
      programmaticSidebarFrameRef.current = requestAnimationFrame(() => {
        programmaticSidebarFrameRef.current = null;
        shell?.removeAttribute(SIDEBAR_PROGRAMMATIC_ATTRIBUTE);
      });
    });
  }, [sidebarHidden, sidebarPanelRef, sidebarWidth]);

  // Panels hold their size as a percentage of the group, so the pixel width is
  // re-asserted on every window resize — otherwise the column would scale with it.
  useEffect(() => {
    const group = groupElementRef.current;
    if (!group) return;
    // Anything this effect does is programmatic, so a resize interaction that never
    // settled (a press on the handle with no movement) must not be read as one.
    userResizeRef.current = false;
    const applyWidth = () => {
      if (isSidebarDragging()) return;
      applySidebarWidth();
    };
    // Observing the group re-asserts the width against the settled layout; a plain
    // resize listener runs too early and converts against the previous group width.
    // The observation delivered on `observe` also sequences this after the panel has
    // re-registered its bounds for the new collapsed state.
    let reconcileFrame: number | null = null;
    const reconcileWidth = () => {
      applyWidth();
      if (reconcileFrame !== null) cancelAnimationFrame(reconcileFrame);
      // Electron zoom can notify this observer before react-resizable-panels has
      // refreshed its pixel constraints. Re-assert once on the next frame so the
      // stored pixel preference wins after both observers have settled.
      reconcileFrame = requestAnimationFrame(() => {
        reconcileFrame = null;
        applyWidth();
      });
    };
    const observer = new ResizeObserver(reconcileWidth);
    observer.observe(group);
    return () => {
      observer.disconnect();
      if (reconcileFrame !== null) cancelAnimationFrame(reconcileFrame);
    };
  }, [applySidebarWidth, isSidebarDragging]);

  // The library activates a drag from an inflated document-level hit target
  // (resizeTargetMinimumSize), so the press can land on a neighbouring element and
  // skip this separator's pointerdown. It captures the pointer to the separator once
  // the drag activates, so gotpointercapture is the begin signal for those grabs;
  // on-element presses just begin twice, which is harmless.
  const beginSidebarDrag = () => {
    userResizeRef.current = true;
    groupWidthRef.current = groupElementRef.current?.getBoundingClientRect().width ?? null;
    shellRef.current?.setAttribute(SIDEBAR_DRAGGING_ATTRIBUTE, 'true');
  };

  // The attribute only suppresses the collapse transition, so it is cleared as soon
  // as the pointer is released — a press that never moved must not leave it stuck.
  const endSidebarDrag = () => {
    if (sidebarWidthFrameRef.current !== null) {
      cancelAnimationFrame(sidebarWidthFrameRef.current);
      sidebarWidthFrameRef.current = null;
    }
    shellRef.current?.removeAttribute(SIDEBAR_DRAGGING_ATTRIBUTE);
    // A collapse toggled mid-drag was skipped by the reconcile, so the release is its
    // last trigger. An expanded release is deliberately not re-asserted: its width
    // commits through `onLayoutChanged`, which the store has yet to see here.
    if (sidebarHidden) applySidebarWidth();
  };

  // The separator resizes from the keyboard too, and that is as user-initiated as a
  // drag, so it must reach the same commit path. The library binds keydown natively
  // on the separator, so this has to run in the capture phase to beat it — a bubbling
  // handler would flag the resize after it had settled.
  const beginSidebarKeyResize = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!SIDEBAR_RESIZE_KEYS.has(event.key)) return;
    userResizeRef.current = true;
    groupWidthRef.current = groupElementRef.current?.getBoundingClientRect().width ?? null;
  };

  // Arrow-key resizes settle without the group reporting a finished layout, so the
  // key release is their commit point. Enter is the separator's collapse toggle: it
  // moves no boundary, so it goes to the preference the titlebar and ⌘B write.
  const commitSidebarKeyResize = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === SIDEBAR_COLLAPSE_KEY) {
      toggleCollapsed();
      return;
    }
    if (!SIDEBAR_RESIZE_KEYS.has(event.key)) return;
    commitSidebarWidth();
  };

  // The variable is written once per frame rather than once per pointer move, so a
  // fast drag coalesces into a single style write instead of a queue of them.
  const flushSidebarWidth = () => {
    sidebarWidthFrameRef.current = null;
    const width = pendingSidebarWidthRef.current;
    if (!userResizeRef.current || width === null) return;
    shellRef.current?.style.setProperty(SIDEBAR_LIVE_WIDTH_VAR, `${width}px`);
  };

  // Layout updates paint through the CSS variable instead of React state, and only
  // during a user resize, so a programmatic collapse leaves the width pinned. The
  // width comes from the layout being applied and from the group width measured at
  // drag start, so no move tick has to force a synchronous layout to read it back.
  const trackSidebarResize = (layout: Record<string, number>) => {
    if (!userResizeRef.current) return;
    const percentage = layout[SIDEBAR_PANEL_ID];
    const groupWidth = groupWidthRef.current;
    if (percentage === undefined || groupWidth === null) return;
    pendingSidebarWidthRef.current = Math.round((percentage / 100) * groupWidth);
    if (sidebarWidthFrameRef.current === null) {
      sidebarWidthFrameRef.current = requestAnimationFrame(flushSidebarWidth);
    }
  };

  // Only a user resize writes preferences. Programmatic collapse and expand also
  // settle the layout, and reacting to those would fight the state that caused them.
  const commitSidebarWidth = () => {
    const panel = sidebarPanelRef.current;
    if (!userResizeRef.current || !panel) return;
    userResizeRef.current = false;
    const next = clampSidebarWidth(panel.getSize().inPixels);
    shellRef.current?.style.setProperty(SIDEBAR_LIVE_WIDTH_VAR, `${next}px`);
    setWidth(next);
  };

  useEffect(() => {
    let isMounted = true;

    void getAppInfo()
      .then((info) => {
        if (isMounted) {
          setShowDevMarker(!info.isPackaged);
        }
      })
      .catch(() => {
        if (isMounted) {
          setShowDevMarker(false);
        }
      });

    return () => {
      isMounted = false;
    };
  }, []);

  useEffect(() => {
    if (fileBrowserOpen) {
      filePanelRef.current?.expand();
    } else {
      filePanelRef.current?.collapse();
    }
  }, [fileBrowserOpen, filePanelRef]);

  return (
    <div ref={shellRef} data-testid="app-shell" className="flex flex-col h-screen w-screen overflow-hidden bg-[var(--bg)]">
      <div
        data-testid="app-titlebar"
        className={cn(
          TITLEBAR_STRIP_CLASS,
          trafficLightsVisible ? TITLEBAR_LIGHTS_GUTTER_CLASS : TITLEBAR_PLAIN_GUTTER_CLASS,
        )}
      >
        {/* Left segment: the sidebar column runs unbroken from the top of the window. */}
        <div
          aria-hidden
          className="sidebar-width-motion absolute inset-y-0 left-0 -z-10 bg-[var(--sidebar-bg)]"
          style={{ width: sidebarHidden ? 0 : SIDEBAR_LIVE_WIDTH_VALUE }}
        />
        {!zenMode && <TitlebarSidebarCluster compact={compactViewport} />}
        {showDevMarker && (
          <span
            aria-label="Development app runtime"
            className="ml-[8px] inline-flex h-4 items-center rounded-md border border-[var(--divider)] bg-[var(--surface-raised)]/70 px-1.5 text-[9px] font-medium leading-none tracking-normal text-[var(--text-muted)]"
          >
            dev
          </span>
        )}
        {!zenMode && <TitleBarStatus />}
      </div>
      <div className="flex flex-1 overflow-hidden">
        <Group
          className="flex-1 min-w-0"
          elementRef={groupElementRef}
          orientation="horizontal"
          onLayoutChange={trackSidebarResize}
          onLayoutChanged={commitSidebarWidth}
          resizeTargetMinimumSize={FILE_BROWSER_RESIZE_TARGET_MINIMUM_SIZE}
        >
          <Panel
            panelRef={sidebarPanelRef}
            elementRef={sidebarPanelElementRef}
            id={SIDEBAR_PANEL_ID}
            defaultSize={sidebarHidden ? SIDEBAR_PANEL_COLLAPSED_SIZE : `${sidebarWidth}px`}
            minSize={sidebarHidden ? SIDEBAR_PANEL_COLLAPSED_SIZE : SIDEBAR_PANEL_MIN_SIZE}
            maxSize={SIDEBAR_PANEL_MAX_SIZE}
          >
            {!zenMode && <Sidebar />}
          </Panel>
          <Separator
            id={SIDEBAR_SEPARATOR_ID}
            disabled={sidebarHidden}
            onGotPointerCapture={beginSidebarDrag}
            onKeyDownCapture={beginSidebarKeyResize}
            onKeyUp={commitSidebarKeyResize}
            onLostPointerCapture={endSidebarDrag}
            onPointerDown={beginSidebarDrag}
            onPointerUp={endSidebarDrag}
            className={cn(
              SIDEBAR_RESIZE_HANDLE_CLASS,
              sidebarHidden && 'pointer-events-none opacity-0',
            )}
          />
          <Panel className="h-full min-w-0 overflow-hidden" minSize={SIDEBAR_CONTENT_MIN_SIZE}>
            <Group
              className="h-full"
              orientation="horizontal"
              resizeTargetMinimumSize={FILE_BROWSER_RESIZE_TARGET_MINIMUM_SIZE}
            >
            <Panel
              panelRef={filePanelRef}
              collapsible
              collapsedSize="0"
              defaultSize="15"
              minSize="10"
              maxSize="70"
            >
              {fileBrowserOpen && (
                <RendererErrorBoundary
                  compact
                  description="Retry to remount the file browser and editor surface."
                  scope="file-browser"
                  title="File browser unavailable"
                >
                  <Suspense fallback={null}>
                    <FileBrowserPanel />
                  </Suspense>
                </RendererErrorBoundary>
              )}
            </Panel>
            <Separator
              disabled={!fileBrowserOpen}
              id={FILE_BROWSER_SHELL_SEPARATOR_ID}
              className={cn(
                FILE_BROWSER_SHELL_RESIZE_HANDLE_CLASS,
                viewerCrowded && FILE_BROWSER_CROWDED_RESIZE_HANDLE_CLASS,
                zenMode && !fileBrowserOpen && 'pointer-events-none opacity-0',
              )}
            />
            <Panel defaultSize="80" minSize="30">
              <RendererErrorBoundary
                compact
                description="Retry to remount the current dashboard or settings view."
                scope="content-area"
                title="Main view unavailable"
              >
                <ContentArea />
              </RendererErrorBoundary>
            </Panel>
            </Group>
          </Panel>
        </Group>
      </div>
      <HelpOverlay />
      {zenMode && <ZenExitChip />}
      {zenMode && !fileBrowserOpen && <ZenSidebarPeek />}
    </div>
  );
}

function ZenExitChip() {
  const setZenMode = useUiStore((s) => s.setZenMode);
  const setCreating = usePaneStore((s) => s.setCreating);
  return (
    <div className={ZEN_CHIP_CONTAINER_CLASS}>
      <AppUpdateControl />
      <AttentionStat variant="zen" />
      <HoverTooltip label="New pane (⌘N)" align="end">
        <button
          type="button"
          onClick={() => setCreating(true)}
          data-testid="zen-new-pane"
          aria-label="New pane"
          className={ZEN_CHIP_BUTTON_CLASS}
        >
          <Plus size={12} />
        </button>
      </HoverTooltip>
      <HoverTooltip label="Exit Zen mode (⌘⌥Z)" align="end">
        <button
          type="button"
          onClick={() => setZenMode(false)}
          data-testid="zen-exit-chip"
          aria-label="Exit Zen mode"
          className={ZEN_CHIP_BUTTON_CLASS}
        >
          <Shrink size={12} />
        </button>
      </HoverTooltip>
    </div>
  );
}

// Permanent strip chrome: collapsed and expanded are pixel-identical here, so the
// controls never move and never need a fade.
function TitlebarSidebarCluster({ compact }: Readonly<{ compact: boolean }>) {
  const setCreating = usePaneStore((s) => s.setCreating);
  const { toggleCollapsed } = useSidebarPreferences();

  return (
    <div className="flex items-center gap-[2px]">
      <HoverTooltip label={compact ? COMPACT_SIDEBAR_HINT : SIDEBAR_TOGGLE_TOOLTIP}>
        <button
          type="button"
          onClick={toggleCollapsed}
          disabled={compact}
          data-testid="titlebar-sidebar-toggle"
          aria-label={compact ? COMPACT_SIDEBAR_HINT : SIDEBAR_TOGGLE_LABEL}
          className={TITLEBAR_BUTTON_CLASS}
        >
          <PanelLeft size={SIDEBAR_ICON_SIZE} strokeWidth={SIDEBAR_ICON_STROKE} />
        </button>
      </HoverTooltip>
      <HoverTooltip label={`${NEW_AGENT_LABEL} ⌘N`}>
        <button
          type="button"
          onClick={() => setCreating(true)}
          data-testid="titlebar-new-agent"
          aria-label={NEW_AGENT_LABEL}
          className={TITLEBAR_BUTTON_CLASS}
        >
          <SquarePen size={SIDEBAR_ICON_SIZE} strokeWidth={SIDEBAR_ICON_STROKE} />
        </button>
      </HoverTooltip>
    </div>
  );
}

function ZenSidebarPeek() {
  const [peek, setPeek] = useState(false);

  return (
    <>
      {/* Hover trip zone — thin invisible strip glued to the left window edge. */}
      <div
        aria-hidden
        className="fixed left-0 top-11 bottom-0 z-40 w-2 [-webkit-app-region:no-drag]"
        onMouseEnter={() => setPeek(true)}
      />
      {/* Fading sidebar layer. Renders always so mouse-leave transitions have
          something to fade; pointer-events toggle so it doesn't eat clicks when
          hidden. */}
      <div
        className={cn(
          'fixed left-0 top-11 bottom-0 z-40 transition-opacity duration-200 ease-out [-webkit-app-region:no-drag]',
          peek ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none',
        )}
        style={{ width: SIDEBAR_LIVE_WIDTH_VALUE }}
        onMouseLeave={() => setPeek(false)}
      >
        <Sidebar forceExpanded />
      </div>
    </>
  );
}
