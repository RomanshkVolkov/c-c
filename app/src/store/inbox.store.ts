import { create } from "zustand";
import { api } from "@/lib/api";
import type { APIResponse } from "@/types/auth";

/**
 * What happened while you were away.
 *
 * Distinct from `notifications.store`, which is a delivery log: that one
 * answers "did the OS notification fire, and if not why", and only ever knows
 * about the session it lived in. This one is the server's record, so the badge
 * can finally mean "since you last read it" instead of "since you last launched
 * the app" — which is the complaint this whole feature exists to fix.
 */

export interface InboxItem {
  id: string;
  orgId: string;
  kind: string;
  title: string;
  body: string;
  link: string;
  readAt?: string | null;
  createdAt: string;
}

export interface InboxPrefs {
  mentions: boolean;
  dms: boolean;
  comments: boolean;
  reports: boolean;
}

interface InboxState {
  items: InboxItem[];
  unread: number;
  loading: boolean;
  orgId: string | null;

  load: (orgId: string | null) => Promise<void>;
  markRead: (ids: string[]) => Promise<void>;
  markAllRead: () => Promise<void>;
  prefs: InboxPrefs | null;
  loadPrefs: () => Promise<void>;
  savePrefs: (p: InboxPrefs) => Promise<void>;
}

export const useInboxStore = create<InboxState>((set, get) => ({
  items: [],
  unread: 0,
  loading: false,
  orgId: null,

  load: async (orgId) => {
    set({ loading: true, orgId });
    try {
      const q = orgId ? `?orgId=${orgId}&limit=50` : "?limit=50";
      const res = await api.get<APIResponse<{ items: InboxItem[]; unread: number }>>(
        `/api/v1/notifications/${q}`,
        true,
      );
      set({ items: res.data?.items ?? [], unread: res.data?.unread ?? 0, loading: false });
    } catch {
      // Silent: an inbox that failed to load is a badge that doesn't update,
      // not something to interrupt somebody with.
      set({ loading: false });
    }
  },

  markRead: async (ids) => {
    if (ids.length === 0) return;
    // Optimistic, because reading is the one action nobody wants to wait for.
    // The count is recomputed from the rows rather than decremented, so a
    // double click can't drive it below zero.
    set((s) => {
      const items = s.items.map((i) => (ids.includes(i.id) ? { ...i, readAt: "now" } : i));
      return { items, unread: Math.max(0, s.unread - ids.filter((id) =>
        s.items.some((i) => i.id === id && !i.readAt)).length) };
    });
    await api.post<APIResponse<unknown>>("/api/v1/notifications/read", { ids }, true);
  },

  prefs: null,

  loadPrefs: async () => {
    try {
      const res = await api.get<APIResponse<InboxPrefs>>("/api/v1/notifications/preferences", true);
      if (res.data) set({ prefs: res.data });
    } catch {
      // Silent: not knowing your preferences is a dialog that opens with the
      // defaults, not something to interrupt anybody about.
    }
  },

  savePrefs: async (p) => {
    // Optimistic, and the server's answer wins: it forces mentions back on, so
    // taking its reply is how the dialog stops claiming something untrue.
    set({ prefs: p });
    const res = await api.patch<APIResponse<InboxPrefs>>(
      "/api/v1/notifications/preferences",
      p,
      true,
    );
    if (res.data) set({ prefs: res.data });
  },

  markAllRead: async () => {
    const orgId = get().orgId;
    set((s) => ({ items: s.items.map((i) => ({ ...i, readAt: i.readAt ?? "now" })), unread: 0 }));
    const q = orgId ? `?orgId=${orgId}` : "";
    await api.post<APIResponse<unknown>>(`/api/v1/notifications/read-all${q}`, {}, true);
  },
}));
