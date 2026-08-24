import { create } from 'zustand';
import type { AgentHealthMap } from '../../shared/ipc-types';

interface AgentHealthState {
  snapshots: AgentHealthMap;
  fetchedAt: number;
}

interface AgentHealthActions {
  set: (snapshots: AgentHealthMap, fetchedAt: number) => void;
}

export const useAgentHealthStore = create<AgentHealthState & AgentHealthActions>((set) => ({
  snapshots: {},
  fetchedAt: 0,
  set: (snapshots, fetchedAt) => set({ snapshots, fetchedAt }),
}));
