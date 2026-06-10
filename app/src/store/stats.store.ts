import { create } from "zustand";
import type { ContainerStats } from "@/types/swarm";

interface APIResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
}

export interface StatsEntry {
  stats: ContainerStats[];
  loading: boolean;
  lastFetchedAt: number | null;
  error: string | null;
  // Polling flag is intentionally separate from the page's lifecycle so the
  // user can pause/resume without losing the last fetched snapshot.
  polling: boolean;
}

const defaultEntry: StatsEntry = {
  stats: [],
  loading: false,
  lastFetchedAt: null,
  error: null,
  polling: true,
};

interface StatsState {
  entries: Record<string, StatsEntry>;

  fetchOnce: (serverId: string, host: string, agentPort: number) => Promise<void>;
  setPolling: (serverId: string, on: boolean) => void;
  ensureEntry: (serverId: string) => void;
  reset: (serverId: string) => void;
}

export const useStatsStore = create<StatsState>((set, get) => ({
  entries: {},

  ensureEntry: (serverId) => {
    if (!get().entries[serverId]) {
      set((s) => ({
        entries: { ...s.entries, [serverId]: { ...defaultEntry } },
      }));
    }
  },

  setPolling: (serverId, on) => {
    set((s) => {
      const entry = s.entries[serverId] ?? { ...defaultEntry };
      return {
        entries: { ...s.entries, [serverId]: { ...entry, polling: on } },
      };
    });
  },

  reset: (serverId) => {
    set((s) => ({
      entries: { ...s.entries, [serverId]: { ...defaultEntry } },
    }));
  },

  fetchOnce: async (serverId, host, agentPort) => {
    const entry = get().entries[serverId];
    if (entry?.loading) return;

    set((s) => ({
      entries: {
        ...s.entries,
        [serverId]: { ...(s.entries[serverId] ?? defaultEntry), loading: true },
      },
    }));

    try {
      const res = (await fetch(
        `http://${host}:${agentPort}/api/v1/stats`,
      ).then((r) => r.json())) as APIResponse<ContainerStats[]>;

      if (!res.success) {
        set((s) => ({
          entries: {
            ...s.entries,
            [serverId]: {
              ...(s.entries[serverId] ?? defaultEntry),
              loading: false,
              error: res.error ?? "Failed to fetch stats",
            },
          },
        }));
        return;
      }

      set((s) => ({
        entries: {
          ...s.entries,
          [serverId]: {
            ...(s.entries[serverId] ?? defaultEntry),
            stats: res.data ?? [],
            lastFetchedAt: Date.now(),
            loading: false,
            error: null,
          },
        },
      }));
    } catch (e) {
      set((s) => ({
        entries: {
          ...s.entries,
          [serverId]: {
            ...(s.entries[serverId] ?? defaultEntry),
            loading: false,
            error:
              e instanceof Error ? e.message : "Failed to connect to agent",
          },
        },
      }));
    }
  },
}));
