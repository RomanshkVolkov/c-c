import { create } from "zustand";
import { api } from "@/lib/api";
import { useAuthStore } from "@/store/auth.store";
import type { APIResponse } from "@/types/auth";

/**
 * Private conversations: two people, one organization.
 *
 * Deliberately a separate store from the channels, mirroring the separate
 * tables. The two look alike on screen and are the same act of writing, but
 * "who may read this" is a different question for each, and a single store
 * would end up with one `messages` array that both fill — which is one careless
 * render away from showing a private thread under a channel's name.
 */

export interface DMMessage {
  id: string;
  conversationId: string;
  authorUserId: string;
  authorName: string;
  body: string;
  createdAt: string;
  updatedAt: string;
}

export interface DMSummary {
  conversationId: string;
  orgId: string;
  /** The other person. */
  userId: string;
  username: string;
  unread: number;
  lastMessageAt?: string | null;
  /** Del otro, no tuyo: es la mitad de decidir si escribirle ahora. */
  lastSeenAt?: string | null;
}

interface DMState {
  conversations: DMSummary[];
  /** The open thread, oldest-first — the order it renders in. */
  messages: DMMessage[];
  conversationId: string | null;
  loading: boolean;
  hasMore: boolean;
  loadingOlder: boolean;

  fetchConversations: () => Promise<void>;
  openWith: (orgId: string, userId: string) => Promise<string>;
  /** Abrir una conversación: vacía lo que hubiera y trae la primera página. */
  open: (conversationId: string) => Promise<void>;
  /**
   * Volver a pedir la conversación abierta, **sin vaciarla**.
   *
   * Gemela de `chat.store → refrescar`, y por lo mismo: `open` vacía porque está
   * escrita para cambiar de conversación, y llamarla desde enviar, editar,
   * borrar o un mensaje que llega tiraba el historial cargado y dejaba la lista
   * en blanco mientras volvía la respuesta.
   */
  refrescar: () => Promise<void>;
  fetchOlder: () => Promise<void>;
  post: (conversationId: string, body: string) => Promise<void>;
  edit: (conversationId: string, messageId: string, body: string) => Promise<void>;
  withdraw: (conversationId: string, messageId: string) => Promise<void>;
  markRead: (conversationId: string) => Promise<void>;
  /** A message arrived. Echo filtering happens in the events hook, as elsewhere. */
  onIncoming: (conversationId: string) => Promise<void>;
}

const PAGE = 50;

export const useDMStore = create<DMState>((set, get) => ({
  conversations: [],
  messages: [],
  conversationId: null,
  loading: false,
  hasMore: true,
  loadingOlder: false,

  fetchConversations: async () => {
    const res = await api.get<APIResponse<DMSummary[]>>("/api/v1/dm/");
    set({ conversations: res.data ?? [] });
  },

  openWith: async (orgId, userId) => {
    const res = await api.post<APIResponse<{ id: string }>>(
      "/api/v1/dm/open",
      { orgId, userId },
      true,
    );
    const id = res.data?.id;
    if (!id) throw new Error("the conversation could not be opened");
    await get().open(id);
    await get().fetchConversations();
    return id;
  },

  open: async (conversationId) => {
    // Clear first: a slow load must not leave the previous thread on screen
    // under this one's name.
    set({ loading: true, conversationId, messages: [], hasMore: true });
    try {
      const res = await api.get<APIResponse<DMMessage[]>>(
        `/api/v1/dm/${conversationId}/messages?limit=${PAGE}`,
      );
      const msgs = res.data ?? [];
      if (get().conversationId !== conversationId) return; // moved on already
      set({ messages: msgs, hasMore: msgs.length === PAGE, loading: false });
      await get().markRead(conversationId);
    } catch (e) {
      if (get().conversationId === conversationId) set({ loading: false });
      throw e;
    }
  },

  refrescar: async () => {
    const conversationId = get().conversationId;
    if (!conversationId) return;
    const res = await api.get<{ data: DMMessage[] }>(
      `/api/v1/dm/${conversationId}/messages?limit=${PAGE}`,
    );
    const frescos = res.data ?? [];
    if (get().conversationId !== conversationId) return;
    set((prev) => {
      const porId = new Map(prev.messages.map((m) => [m.id, m]));
      for (const m of frescos) porId.set(m.id, m);
      // Lo desaparecido **dentro de la ventana que acaba de llegar** se borró;
      // lo de más atrás son páginas viejas que siguen valiendo.
      const masViejoFresco = frescos[0]?.createdAt;
      const vivos = [...porId.values()].filter(
        (m) =>
          !masViejoFresco ||
          m.createdAt < masViejoFresco ||
          frescos.some((f) => f.id === m.id),
      );
      vivos.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      return { messages: vivos };
    });
  },

  fetchOlder: async () => {
    const { conversationId, messages, hasMore, loadingOlder } = get();
    if (!conversationId || !hasMore || loadingOlder || messages.length === 0) return;
    set({ loadingOlder: true });
    try {
      const before = encodeURIComponent(messages[0].createdAt);
      const res = await api.get<APIResponse<DMMessage[]>>(
        `/api/v1/dm/${conversationId}/messages?limit=${PAGE}&before=${before}`,
      );
      const older = res.data ?? [];
      if (get().conversationId !== conversationId) return;
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

  post: async (conversationId, body) => {
    await api.post(`/api/v1/dm/${conversationId}/messages`, { body }, true);
    await get().refrescar();
  },

  edit: async (conversationId, messageId, body) => {
    await api.patch(`/api/v1/dm/${conversationId}/messages/${messageId}`, { body });
    await get().refrescar();
  },

  withdraw: async (conversationId, messageId) => {
    await api.delete(`/api/v1/dm/${conversationId}/messages/${messageId}`);
    await get().refrescar();
  },

  markRead: async (conversationId) => {
    await api.post(`/api/v1/dm/${conversationId}/read`, {}, true);
    set((s) => ({
      conversations: s.conversations.map((c) =>
        c.conversationId === conversationId ? { ...c, unread: 0 } : c,
      ),
    }));
  },

  onIncoming: async (conversationId) => {
    if (get().conversationId === conversationId) {
      // You are looking at it, so it is read the moment it lands.
      await get().refrescar();
      return;
    }
    await get().fetchConversations();
  },
}));

// Somebody else's private conversation must not survive a logout.
useAuthStore.subscribe((state, prev) => {
  if (prev.accessToken && !state.accessToken) {
    useDMStore.setState({ conversations: [], messages: [], conversationId: null });
  }
});
