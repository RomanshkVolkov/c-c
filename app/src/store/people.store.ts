import { create } from "zustand";
import { api } from "@/lib/api";
import { useAuthStore } from "@/store/auth.store";
import { useOrgsStore } from "@/store/orgs.store";
import type { APIResponse } from "@/types/auth";

export interface Person {
  id: string;
  username: string;
}

/**
 * The colleagues of the organization on screen.
 *
 * Loaded once per organization rather than searched per keystroke: a team is
 * small enough to hold, and the `@` picker has to answer instantly while
 * somebody is mid-word. The server still narrows by organization and still
 * re-checks every mention when the message is saved — this list is a
 * convenience, never the boundary.
 */
interface PeopleState {
  byOrg: Record<string, Person[]>;
  fetchPeople: (orgId?: string) => Promise<void>;
  /** Everyone in the current organization, for a picker to read synchronously. */
  current: () => Person[];
}

export const usePeopleStore = create<PeopleState>((set, get) => ({
  byOrg: {},

  fetchPeople: async (orgId) => {
    const org = orgId ?? useOrgsStore.getState().currentOrgId;
    if (!org) return;
    // An empty query asks for the org's people; the endpoint refuses an
    // organization the caller doesn't belong to.
    const res = await api.get<APIResponse<Person[]>>(
      `/api/v1/users/search?q=&orgId=${encodeURIComponent(org)}&limit=50`,
    );
    set((s) => ({ byOrg: { ...s.byOrg, [org]: res.data ?? [] } }));
  },

  current: () => {
    const org = useOrgsStore.getState().currentOrgId;
    return org ? (get().byOrg[org] ?? []) : [];
  },
}));

// Another team's names must not be in memory after a logout.
useAuthStore.subscribe((state, prev) => {
  if (prev.accessToken && !state.accessToken) usePeopleStore.setState({ byOrg: {} });
});
