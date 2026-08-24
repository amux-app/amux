import { create } from 'zustand';
import type { SerializableActionResult } from '../../shared/ipc-types';

type ConflictOption = NonNullable<SerializableActionResult['options']>[number];

interface ConflictResolutionState {
  paneId: string | null;
  callbackId: string | null;
  conflictFiles: string[];
  options: ConflictOption[];
  message: string | null;
}

interface ConflictResolutionActions {
  openConflictResolution: (paneId: string, result: SerializableActionResult) => void;
  closeConflictResolution: () => void;
}

function parseConflictFiles(message: string): string[] {
  return message
    .split('\n')
    .filter((line) => line.trimStart().startsWith('•'))
    .map((line) => line.replace(/^\s*•\s*/, '').trim())
    .filter(Boolean);
}

const INITIAL_STATE: ConflictResolutionState = {
  paneId: null,
  callbackId: null,
  conflictFiles: [],
  options: [],
  message: null,
};

export const useConflictResolutionStore = create<ConflictResolutionState & ConflictResolutionActions>(
  (set) => ({
    ...INITIAL_STATE,

    openConflictResolution: (paneId, result) =>
      set({
        paneId,
        callbackId: result.callbackId ?? null,
        conflictFiles: parseConflictFiles(result.message),
        options: result.options ?? [],
        message: result.message,
      }),

    closeConflictResolution: () => set(INITIAL_STATE),
  }),
);
