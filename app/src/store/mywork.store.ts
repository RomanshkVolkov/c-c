import { create } from "zustand";
import { persist } from "zustand/middleware";
import { api } from "@/lib/api";
import type { APIResponse } from "@/types/auth";
import type { OpenTask } from "@/types/task";

/**
 * "My work": everything open across every space, asked one question at a time.
 *
 * Until now the only cross-list view was the dashboard's eight-line summary,
 * and anything more meant opening lists one by one and remembering. The four
 * lenses are the questions people actually ask — what is mine, what did I
 * raise, what am I keeping an eye on, and what came from a client — and each is
 * a server-side filter rather than a slice of a big download, because "all the
 * open work in the organization" is not something a client should be holding.
 */

export type WorkLens = "assigned" | "created" | "watching" | "clients" | "all";

/** The query each lens asks. Kept here so the page never builds URLs. */
const LENS_QUERY: Record<WorkLens, string> = {
  assigned: "assignee=me",
  created: "creator=me",
  watching: "watcher=me",
  clients: "origin=clients",
  all: "",
};

interface MyWorkState {
  lens: WorkLens;
  includeClosed: boolean;
  tasks: OpenTask[];
  loading: boolean;
  error: string | null;

  setLens: (lens: WorkLens) => void;
  setIncludeClosed: (on: boolean) => void;
  load: (orgId: string | null) => Promise<void>;
  /** Follow or unfollow, and drop the row when it leaves the lens you're in. */
  setWatching: (taskId: string, on: boolean) => Promise<void>;
}

export const useMyWorkStore = create<MyWorkState>()(
  persist(
    (set, get) => ({
      lens: "assigned",
      includeClosed: false,
      tasks: [],
      loading: false,
      error: null,

      setLens: (lens) => set({ lens }),
      setIncludeClosed: (includeClosed) => set({ includeClosed }),

      load: async (orgId) => {
        set({ loading: true, error: null });
        try {
          const partes = [
            orgId ? `orgId=${orgId}` : "",
            LENS_QUERY[get().lens],
            get().includeClosed ? "status=all" : "",
            "limit=200",
          ].filter(Boolean);
          const res = await api.get<APIResponse<OpenTask[]>>(
            `/api/v1/tasks/?${partes.join("&")}`,
            true,
          );
          set({ tasks: res.data ?? [], loading: false });
        } catch (e) {
          set({ error: String(e), loading: false, tasks: [] });
        }
      },

      setWatching: async (taskId, on) => {
        const path = `/api/v1/tasks/${taskId}/watch`;
        if (on) await api.post<APIResponse<unknown>>(path, {}, true);
        else await api.delete<APIResponse<unknown>>(path, true);
        // Unfollowing from the "watching" lens should take the row away: it no
        // longer answers the question the screen is asking.
        if (!on && get().lens === "watching") {
          set((s) => ({ tasks: s.tasks.filter((t) => t.id !== taskId) }));
        }
      },
    }),
    {
      name: "cac-mywork",
      // Only the lens and the toggle: the work itself is asked for fresh, since
      // a stale list of what is pending is worse than a moment with none.
      partialize: (s) => ({ lens: s.lens, includeClosed: s.includeClosed }),
    },
  ),
);
