import type { Terminal } from '@xterm/xterm';
import { isTerminalDebugEnabled } from './terminalDebugMode';

type DebugApi = {
  getFontFamily: (paneId: string) => string | null;
  getFontSize: (paneId: string) => number | null;
  listPaneIds: () => string[];
  getLine: (paneId: string, row: number) => string | null;
  getLines: (paneId: string, startRow: number, count: number) => string[];
  getViewportInfo: (paneId: string) => TerminalDebugViewportInfo | null;
  getVisibleLines: (paneId: string, count: number) => string[];
  _recordAttach: (paneId: string, streamId: number | null, action: TerminalDebugAttachAction) => void;
  _recordData: (paneId: string, event: TerminalDebugDataEvent) => void;
  _recordDrop: (paneId: string, eventStreamId: number | undefined, currentStreamId: number | null) => void;
  _recordWheel: (paneId: string, event: TerminalDebugWheelEvent) => void;
  _register: (paneId: string, term: Terminal) => void;
  _unregister: (paneId: string) => void;
};

type TerminalDebugAttachAction = 'attach-start' | 'attach-success' | 'detach';

interface TerminalDebugRect {
  bottom: number;
  height: number;
  left: number;
  right: number;
  top: number;
  width: number;
  x: number;
  y: number;
}

interface TerminalDebugViewportInfo {
  attachHistory: TerminalDebugStreamEvent[];
  baseY: number;
  cols: number;
  cursorX: number;
  cursorY: number;
  dataEventEvictionCount: number;
  dataEventHistory: TerminalDebugDataEvent[];
  droppedEventCount: number;
  elementRect: TerminalDebugRect | null;
  lastDroppedEvent: TerminalDebugDroppedEvent | null;
  length: number;
  rows: number;
  screenRect: TerminalDebugRect | null;
  selectionPosition: {
    end: { x: number; y: number };
    start: { x: number; y: number };
  } | null;
  streamId: number | null;
  type: 'normal' | 'alternate';
  viewportY: number;
  wheelEvictionCount: number;
  wheelHistory: TerminalDebugWheelEvent[];
}

interface TerminalDebugStreamEvent {
  action: TerminalDebugAttachAction;
  streamId: number | null;
  ts: number;
}

interface TerminalDebugDroppedEvent {
  currentStreamId: number | null;
  eventStreamId: number | undefined;
  ts: number;
}

interface TerminalDebugBufferSnapshot {
  baseY: number;
  cursorX: number;
  cursorY: number;
  length: number;
  type: 'normal' | 'alternate';
  viewportY: number;
}

interface TerminalDebugDataEvent {
  after: TerminalDebugBufferSnapshot;
  before: TerminalDebugBufferSnapshot;
  dataLength: number;
  hardReset: boolean;
  meaningfulLines: string[];
  source: 'live' | 'replay' | undefined;
  streamId: number;
  ts: number;
}

type TerminalDebugWheelConsumedBy = 'agent-input' | 'native-scroll' | 'none' | 'suppress' | 'tmux-scroll';

interface TerminalDebugWheelEvent {
  after: Pick<TerminalDebugBufferSnapshot, 'baseY' | 'type' | 'viewportY'>;
  before: Pick<TerminalDebugBufferSnapshot, 'baseY' | 'type' | 'viewportY'>;
  consumedBy: TerminalDebugWheelConsumedBy;
  defaultPrevented: boolean;
  deltaMode: number;
  deltaX: number;
  deltaY: number;
  selectionOwner?: 'application' | 'pending' | 'terminal';
  selectionAccumulatedLength?: number;
  selectionAnchorLength?: number;
  selectionRangeComplete?: boolean;
  selectionRangeVerified?: boolean;
  selectionTextLength?: number;
  ts: number;
}

interface TerminalDebugMetadata {
  attachHistory: TerminalDebugStreamEvent[];
  dataEventEvictionCount: number;
  dataEventHistory: TerminalDebugDataEvent[];
  droppedEventCount: number;
  lastDroppedEvent: TerminalDebugDroppedEvent | null;
  streamId: number | null;
  wheelEvictionCount: number;
  wheelHistory: TerminalDebugWheelEvent[];
}

declare global {
  interface Window {
    __muxbaseTerminalDebug?: DebugApi;
  }
}

const TERMINAL_OSC_SEQUENCE = /\x1b\][^\x07]*(?:\x07|\x1b\\)/g;
const TERMINAL_CSI_SEQUENCE = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const TERMINAL_CONTROL_CHARS = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;
const TERMINAL_DEBUG_MEANINGFUL_CONTENT = /[\p{L}\p{N}]{3,}/u;

function normalizeDebugLine(line: string): string {
  return line
    .replace(TERMINAL_OSC_SEQUENCE, '')
    .replace(TERMINAL_CSI_SEQUENCE, '')
    .replace(TERMINAL_CONTROL_CHARS, '')
    .replace(/\s+/g, '');
}

function extractMeaningfulLines(data: string): string[] {
  return data
    .split(/\r?\n/)
    .map(normalizeDebugLine)
    .filter((line) => line.length >= 12 && TERMINAL_DEBUG_MEANINGFUL_CONTENT.test(line))
    .slice(0, 96);
}

function ensureApi(): DebugApi {
  if (window.__muxbaseTerminalDebug) return window.__muxbaseTerminalDebug;

  const terminals = new Map<string, Terminal>();
  const metadata = new Map<string, TerminalDebugMetadata>();

  const getMetadata = (paneId: string): TerminalDebugMetadata => {
    const existing = metadata.get(paneId);
    if (existing) return existing;
    const next: TerminalDebugMetadata = {
      attachHistory: [],
      dataEventEvictionCount: 0,
      dataEventHistory: [],
      droppedEventCount: 0,
      lastDroppedEvent: null,
      streamId: null,
      wheelEvictionCount: 0,
      wheelHistory: [],
    };
    metadata.set(paneId, next);
    return next;
  };

  const toDebugRect = (rect: DOMRect | null | undefined): TerminalDebugRect | null => {
    if (!rect) return null;
    return {
      bottom: rect.bottom,
      height: rect.height,
      left: rect.left,
      right: rect.right,
      top: rect.top,
      width: rect.width,
      x: rect.x,
      y: rect.y,
    };
  };

  const api: DebugApi = {
    getFontFamily: (paneId: string) => {
      const term = terminals.get(paneId);
      return term?.options.fontFamily ?? null;
    },
    getFontSize: (paneId: string) => {
      const term = terminals.get(paneId);
      return term?.options.fontSize ?? null;
    },
    listPaneIds: () => [...terminals.keys()],
    getLine: (paneId: string, row: number) => {
      const term = terminals.get(paneId);
      if (!term) return null;
      const buffer = term.buffer.active;
      const line = buffer.getLine(row);
      if (!line) return null;
      // Alternate-screen xterm lines can retain styled cells beyond the
      // current grid after a shrink so a later grow can restore them. Those
      // off-screen cells are not rendered and must not be mistaken for visible
      // reflow corruption in E2E snapshots.
      return line.translateToString?.(true, 0, term.cols) ?? null;
    },
    getLines: (paneId: string, startRow: number, count: number) => {
      const out: string[] = [];
      for (let i = 0; i < count; i += 1) {
        const line = api.getLine(paneId, startRow + i);
        if (line == null) break;
        out.push(line);
      }
      return out;
    },
    getViewportInfo: (paneId: string) => {
      const term = terminals.get(paneId);
      if (!term) return null;
      const buffer = term.buffer.active;
      const baseY = Number(buffer.baseY ?? 0);
      const viewportY = Number(buffer.viewportY ?? baseY);
      const length = Number(buffer.length ?? 0);
      const element = term.element;
      const screen = element?.querySelector('.xterm-screen');
      const meta = getMetadata(paneId);
      return {
        attachHistory: [...meta.attachHistory],
        baseY,
        cols: term.cols,
        cursorX: buffer.cursorX,
        cursorY: buffer.cursorY,
        dataEventEvictionCount: meta.dataEventEvictionCount,
        dataEventHistory: [...meta.dataEventHistory],
        droppedEventCount: meta.droppedEventCount,
        elementRect: toDebugRect(element?.getBoundingClientRect()),
        lastDroppedEvent: meta.lastDroppedEvent,
        length,
        rows: term.rows,
        screenRect: toDebugRect(screen instanceof HTMLElement ? screen.getBoundingClientRect() : null),
        selectionPosition: term.getSelectionPosition() ?? null,
        streamId: meta.streamId,
        type: buffer.type,
        viewportY,
        wheelEvictionCount: meta.wheelEvictionCount,
        wheelHistory: [...meta.wheelHistory],
      };
    },
    getVisibleLines: (paneId: string, count: number) => {
      const info = api.getViewportInfo(paneId);
      if (!info) return [];
      return api.getLines(paneId, info.viewportY, Math.min(count, info.rows));
    },
    _register: (paneId: string, term: Terminal) => {
      terminals.set(paneId, term);
      getMetadata(paneId);
    },
    _unregister: (paneId: string) => {
      terminals.delete(paneId);
      metadata.delete(paneId);
    },
    _recordAttach: (paneId: string, streamId: number | null, action: TerminalDebugAttachAction) => {
      const meta = getMetadata(paneId);
      meta.streamId = streamId;
      meta.attachHistory.push({ action, streamId, ts: Date.now() });
      if (meta.attachHistory.length > 32) meta.attachHistory.shift();
    },
    _recordData: (paneId: string, event: TerminalDebugDataEvent) => {
      const meta = getMetadata(paneId);
      meta.dataEventHistory.push(event);
      if (meta.dataEventHistory.length > 256) {
        meta.dataEventHistory.shift();
        meta.dataEventEvictionCount += 1;
      }
    },
    _recordDrop: (paneId: string, eventStreamId: number | undefined, currentStreamId: number | null) => {
      const meta = getMetadata(paneId);
      meta.droppedEventCount += 1;
      meta.lastDroppedEvent = { currentStreamId, eventStreamId, ts: Date.now() };
    },
    _recordWheel: (paneId: string, event: TerminalDebugWheelEvent) => {
      const meta = getMetadata(paneId);
      meta.wheelHistory.push(event);
      if (meta.wheelHistory.length > 32) {
        meta.wheelHistory.shift();
        meta.wheelEvictionCount += 1;
      }
    },
  };

  window.__muxbaseTerminalDebug = api;
  return api;
}

function registerTerminalForDebug(paneId: string, term: Terminal): void {
  if (!isTerminalDebugEnabled()) return;
  ensureApi()._register(paneId, term);
}

function unregisterTerminalForDebug(paneId: string): void {
  if (!isTerminalDebugEnabled()) return;
  window.__muxbaseTerminalDebug?._unregister(paneId);
}

function recordTerminalAttachForDebug(
  paneId: string,
  streamId: number | null,
  action: TerminalDebugAttachAction,
): void {
  if (!isTerminalDebugEnabled()) return;
  ensureApi()._recordAttach(paneId, streamId, action);
}

function getTerminalBufferSnapshotForDebug(term: Terminal): TerminalDebugBufferSnapshot {
  const buffer = term.buffer.active;
  return {
    baseY: buffer.baseY,
    cursorX: buffer.cursorX,
    cursorY: buffer.cursorY,
    length: buffer.length,
    type: buffer.type,
    viewportY: buffer.viewportY,
  };
}

function recordTerminalDataForDebug(
  paneId: string,
  event: Omit<TerminalDebugDataEvent, 'meaningfulLines' | 'ts'> & { data: string },
): void {
  if (!isTerminalDebugEnabled()) return;
  const { data, ...rest } = event;
  ensureApi()._recordData(paneId, {
    ...rest,
    meaningfulLines: extractMeaningfulLines(data),
    ts: Date.now(),
  });
}

function recordTerminalDroppedEventForDebug(
  paneId: string,
  eventStreamId: number | undefined,
  currentStreamId: number | null,
): void {
  if (!isTerminalDebugEnabled()) return;
  ensureApi()._recordDrop(paneId, eventStreamId, currentStreamId);
}

function recordTerminalWheelForDebug(
  paneId: string,
  event: Omit<TerminalDebugWheelEvent, 'ts'>,
): void {
  if (!isTerminalDebugEnabled()) return;
  ensureApi()._recordWheel(paneId, { ...event, ts: Date.now() });
}

export const terminalDebug = {
  attach: recordTerminalAttachForDebug,
  capture: getTerminalBufferSnapshotForDebug,
  data: recordTerminalDataForDebug,
  drop: recordTerminalDroppedEventForDebug,
  register: registerTerminalForDebug,
  unregister: unregisterTerminalForDebug,
  wheel: recordTerminalWheelForDebug,
};
