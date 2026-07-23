import { create } from "zustand";
import { api } from "@/lib/api";
import type { APIResponse } from "@/types/auth";
import type { Invitation } from "@/types/organization";

interface InvitationsState {
  pending: Invitation[];
  loading: boolean;

  fetchMine: () => Promise<void>;
  accept: (id: string) => Promise<void>;
  decline: (id: string) => Promise<void>;
  reset: () => void;
}

// Invitee-side store: the caller's own pending invitations, used for the sidebar
// badge and the "Invitations" screen.
export const useInvitationsStore = create<InvitationsState>()((set) => ({
  pending: [],
  loading: false,

  fetchMine: async () => {
    set({ loading: true });
    try {
      const res = await api.get<APIResponse<Invitation[]>>("/api/v1/invitations/", true);
      set({ pending: res.success && res.data ? res.data : [] });
    } catch {
      // Silent — the badge just won't show; the screen surfaces errors on action.
    } finally {
      set({ loading: false });
    }
  },

  accept: async (id) => {
    const res = await api.post<APIResponse<unknown>>(`/api/v1/invitations/${id}/accept`, {}, true);
    if (!res.success) throw new Error(res.error ?? "Accept failed");
    set((s) => ({ pending: s.pending.filter((i) => i.id !== id) }));
  },

  decline: async (id) => {
    const res = await api.post<APIResponse<unknown>>(`/api/v1/invitations/${id}/decline`, {}, true);
    if (!res.success) throw new Error(res.error ?? "Decline failed");
    set((s) => ({ pending: s.pending.filter((i) => i.id !== id) }));
  },

  reset: () => set({ pending: [], loading: false }),
}));
