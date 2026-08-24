import type {
  TerminalAttachRequest,
  TerminalAttachResponse,
  TerminalDetachRequest,
  TerminalResizeRequest,
  TerminalResizeResponse,
  TerminalSelectionExpandRequest,
  TerminalSelectionExpandResponse,
  TerminalScrollRequest,
  TerminalScrollResponse,
  TerminalWriteRequest,
  TerminalUnlockStdinRequest,
} from '../../shared/ipc-types';
import { IPC } from '../../shared/ipc-channels';
import { invoke } from './ipc';

export function attach(req: TerminalAttachRequest): Promise<TerminalAttachResponse> {
  return invoke<TerminalAttachResponse>(IPC.TERMINAL_ATTACH, req);
}

export function detach(req: TerminalDetachRequest): Promise<void> {
  return invoke<void>(IPC.TERMINAL_DETACH, req);
}

export function resize(req: TerminalResizeRequest): Promise<TerminalResizeResponse> {
  return invoke<TerminalResizeResponse>(IPC.TERMINAL_RESIZE, req);
}

export function expandSelection(req: TerminalSelectionExpandRequest): Promise<TerminalSelectionExpandResponse> {
  return invoke<TerminalSelectionExpandResponse>(IPC.TERMINAL_SELECTION_EXPAND, req);
}

export function scroll(req: TerminalScrollRequest): Promise<TerminalScrollResponse> {
  return invoke<TerminalScrollResponse>(IPC.TERMINAL_SCROLL, req);
}

export function write(req: TerminalWriteRequest): Promise<void> {
  return invoke<void>(IPC.TERMINAL_WRITE, req);
}

export function unlockStdin(req: TerminalUnlockStdinRequest): Promise<void> {
  return invoke<void>(IPC.TERMINAL_UNLOCK_STDIN, req);
}
