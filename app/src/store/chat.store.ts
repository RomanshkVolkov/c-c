import { create } from "zustand";
import { api } from "@/lib/api";
import { useAuthStore } from "@/store/auth.store";

/**
 * The space's channel.
 *
 * Only the open channel's messages live here. A cache per space would have to
 * answer "is this page still current?" on every reconnect, and the answer is
 * cheap to just re-fetch: a channel is read from the bottom and the bottom is
 * one request.
 *
 * `unreadBySpace` is the exception — the navigator needs every space's count at
 * once, so it comes from a single grouped endpoint rather than a request per row.
 */

export interface ChatMessage {
  id: string;
  spaceId: string;
  authorUserId: string;
  authorName: string;
  body: string;
  createdAt: string;
  updatedAt: string;
}

interface ChatState {
  /** The channel currently on screen, oldest-first — the order it renders in. */
  messages: ChatMessage[];
  /** Which space `messages` belongs to; null when the panel has never opened. */
  spaceId: string | null;
  loading: boolean;
  /** True while a `before` page is in flight, so the scroller doesn't ask twice. */
  loadingOlder: boolean;
  /** False once a backwards page comes back short — there is no more history. */
  hasMore: boolean;
  unreadBySpace: Record<string, number>;
  /**
   * Los canales que sigo. Seguir es decir «avísame también de lo corriente»:
   * sin eso, sólo una mención genera notificación, y con eso encendido para
   * todo el espacio la bandeja acabaría siendo una copia del chat.
   */
  following: string[];
  /**
   * Which channel is on screen, if any. Named for the panel it used to be; it
   * now means "the Channels screen is showing this space", and its one job is
   * to stop the notifier announcing messages you are watching arrive.
   */
  panelOpen: boolean;

  openPanel: (spaceId: string) => Promise<void>;
  closePanel: () => void;
  fetch: (spaceId: string) => Promise<void>;
  fetchOlder: () => Promise<void>;
  post: (spaceId: string, body: string) => Promise<void>;
  edit: (spaceId: string, messageId: string, body: string) => Promise<void>;
  withdraw: (spaceId: string, messageId: string) => Promise<void>;
  markRead: (spaceId: string) => Promise<void>;
  fetchUnread: () => Promise<void>;
  fetchFollowing: () => Promise<void>;
  setFollowing: (spaceId: string, on: boolean) => Promise<void>;
  /**
   * A message arrived on the stream. Echo filtering happens in the events hook,
   * which owns that rule for every event type; by the time it calls this, the
   * message is somebody else's or the panel is open on it.
   */
  onIncoming: (spaceId: string) => Promise<void>;
}

const PAGE = 50;

export const useChatStore = create<ChatState>((set, get) => ({
  messages: [],
  spaceId: null,
  loading: false,
  loadingOlder: false,
  hasMore: true,
  unreadBySpace: {},
  following: [],
  panelOpen: false,

  openPanel: async (spaceId) => {
    set({ panelOpen: true });
    await get().fetch(spaceId);
    // Opening the channel is reading it. Done after the fetch so a failed load
    // doesn't clear a badge for messages the person never saw.
    await get().markRead(spaceId);
  },

  closePanel: () => set({ panelOpen: false }),

  fetch: async (spaceId) => {
    // Switching spaces must not leave the previous channel's lines on screen
    // under the new channel's name.
    set({ loading: true, spaceId, messages: [], hasMore: true });
    try {
      const res = await api.get<{ data: ChatMessage[] }>(
        `/api/v1/task-spaces/${spaceId}/chat?limit=${PAGE}`,
      );
      const msgs = res.data ?? [];
      // A late response for a space the person already navigated away from
      // would otherwise render under the wrong header.
      if (get().spaceId !== spaceId) return;
      set({ messages: msgs, hasMore: msgs.length === PAGE, loading: false });
    } catch (e) {
      if (get().spaceId === spaceId) set({ loading: false });
      throw e;
    }
  },

  fetchOlder: async () => {
    const { spaceId, messages, hasMore, loadingOlder } = get();
    if (!spaceId || !hasMore || loadingOlder || messages.length === 0) return;
    set({ loadingOlder: true });
    try {
      // The cursor is the oldest line on screen: "what came before this".
      const before = encodeURIComponent(messages[0].createdAt);
      const res = await api.get<{ data: ChatMessage[] }>(
        `/api/v1/task-spaces/${spaceId}/chat?limit=${PAGE}&before=${before}`,
      );
      const older = res.data ?? [];
      if (get().spaceId !== spaceId) return;
      set((s) => ({
        messages: [...older, ...s.messages],
        hasMore: older.length === PAGE,
        loadingOlder: false,
      }));
    } catch (e) {
      set({ loadingOlder: false });
      throw e;
    }
  },

  post: async (spaceId, body) => {
    await api.post(`/api/v1/task-spaces/${spaceId}/chat`, { body }, true);
    // Refetch rather than append the response: the server assigns the timestamp,
    // and a locally-appended line would sort wrong against anything that landed
    // in between.
    await get().fetch(spaceId);
  },

  edit: async (spaceId, messageId, body) => {
    await api.patch(`/api/v1/task-spaces/${spaceId}/chat/${messageId}`, { body });
    await get().fetch(spaceId);
  },

  withdraw: async (spaceId, messageId) => {
    await api.delete(`/api/v1/task-spaces/${spaceId}/chat/${messageId}`);
    await get().fetch(spaceId);
  },

  markRead: async (spaceId) => {
    await api.post(`/api/v1/task-spaces/${spaceId}/chat/read`, {}, true);
    // Clear the badge locally instead of refetching every space's count for one
    // known change.
    set((s) => {
      if (!s.unreadBySpace[spaceId]) return s;
      const next = { ...s.unreadBySpace };
      delete next[spaceId];
      return { unreadBySpace: next };
    });
  },

  fetchUnread: async () => {
    const res = await api.get<{ data: { spaceId: string; count: number }[] }>(
      "/api/v1/chat/unread",
    );
    const map: Record<string, number> = {};
    for (const row of res.data ?? []) map[row.spaceId] = row.count;
    set({ unreadBySpace: map });
  },

  fetchFollowing: async () => {
    const res = await api.get<{ data: string[] }>("/api/v1/chat/following");
    set({ following: res.data ?? [] });
  },

  // Optimista y luego confirmado: el botón responde en el acto y, si el
  // servidor dice que no, la lista que vuelve manda. Un botón que tarda medio
  // segundo en cambiar de estado se pulsa dos veces.
  setFollowing: async (spaceId, on) => {
    set((s) => ({
      following: on
        ? [...new Set([...s.following, spaceId])]
        : s.following.filter((id) => id !== spaceId),
    }));
    const path = `/api/v1/task-spaces/${spaceId}/chat/follow`;
    try {
      if (on) await api.post(path, {}, true);
      else await api.delete(path, true);
    } finally {
      await useChatStore.getState().fetchFollowing();
    }
  },

  onIncoming: async (spaceId) => {
    const s = get();
    if (s.panelOpen && s.spaceId === spaceId) {
      // You are looking at it, so it is read the moment it lands.
      await s.fetch(spaceId);
      await s.markRead(spaceId);
      return;
    }
    set((prev) => ({
      unreadBySpace: {
        ...prev.unreadBySpace,
        [spaceId]: (prev.unreadBySpace[spaceId] ?? 0) + 1,
      },
    }));
  },
}));

// Another person's conversation must not be on screen after a logout.
useAuthStore.subscribe((state, prev) => {
  if (prev.accessToken && !state.accessToken) {
    useChatStore.setState({
      messages: [],
      spaceId: null,
      unreadBySpace: {},
  following: [],
      panelOpen: false,
      hasMore: true,
    });
  }
});
