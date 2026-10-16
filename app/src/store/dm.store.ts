import { create } from "zustand";
import { api } from "@/lib/api";
import { useAuthStore } from "@/store/auth.store";
import { applyReaction, type Reaction } from "@/lib/reactions";
import { nombreDe } from "@/lib/nombres";
import type { APIResponse } from "@/types/auth";
import type { MessageQuote } from "@/store/chat.store";

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
  /** Contadas para mí. Un backend anterior a las reacciones no las manda. */
  reactions?: Reaction[];
  /** A qué contesta, si contesta a algo. */
  replyTo?: MessageQuote;
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
  /** La última línea, recortada, y de quién es: la fila de la lista. */
  lastBody?: string;
  lastAuthorId?: string;
  /** Hasta dónde leyó el otro: lo tuyo de antes de esta hora, leído. */
  otherReadAt?: string | null;
}

interface DMState {
  conversations: DMSummary[];
  /** The open thread, oldest-first — the order it renders in. */
  messages: DMMessage[];
  conversationId: string | null;
  /**
   * De qué organización es la conversación abierta.
   *
   * Un directo es de dos personas **en una org**, y la pantalla sólo lo pinta
   * si es la que está en pantalla. Antes el único que lo cerraba al cambiar de
   * org era `DMSwitcher`, que sólo existe en `/dm`: cambiar desde otra pantalla
   * y volver enseñaba el hilo de la org de antes. Ver `store/org-switch.ts`.
   */
  conversationOrgId: string | null;
  /** Cerrar la conversación abierta. */
  close: () => void;
  loading: boolean;
  hasMore: boolean;
  loadingOlder: boolean;

  fetchConversations: () => Promise<void>;
  /** El otro leyó hasta `at`: las palomitas de lo tuyo pasan a leído. */
  onRead: (conversationId: string, at: string) => void;
  openWith: (orgId: string, userId: string) => Promise<string>;
  /**
   * Abrir una conversación: vacía lo que hubiera y trae la primera página.
   * `orgId` si se sabe; si no, se busca en `conversations`.
   */
  open: (conversationId: string, orgId?: string) => Promise<void>;
  /**
   * Volver a pedir la conversación abierta, **sin vaciarla**.
   *
   * Gemela de `chat.store → refrescar`, y por lo mismo: `open` vacía porque está
   * escrita para cambiar de conversación, y llamarla desde enviar, editar,
   * borrar o un mensaje que llega tiraba el historial cargado y dejaba la lista
   * en blanco mientras volvía la respuesta.
   */
  refrescar: () => Promise<void>;
  /** Poner o quitar mi emoji; optimista, como en el canal (`chat.store`). */
  react: (conversationId: string, messageId: string, emoji: string, on: boolean) => Promise<void>;
  /** Alguien reaccionó en una conversación: si es la abierta, se relee. */
  onReaction: (conversationId: string) => Promise<void>;
  fetchOlder: () => Promise<void>;
  post: (conversationId: string, body: string, replyToId?: string) => Promise<void>;
  /**
   * Sube un fichero a la conversación (una captura pegada, un PDF) y devuelve
   * lo que el editor mete en el texto. Sólo lo ven las dos personas.
   */
  uploadAttachment: (conversationId: string, file: File) => Promise<{ url: string; fileName: string }>;
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
  conversationOrgId: null,
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
    await get().open(id, orgId);
    await get().fetchConversations();
    return id;
  },

  close: () => set({ conversationId: null, conversationOrgId: null, messages: [] }),

  open: async (conversationId, orgId) => {
    const conversationOrgId =
      orgId ?? get().conversations.find((c) => c.conversationId === conversationId)?.orgId ?? null;
    // Clear first: a slow load must not leave the previous thread on screen
    // under this one's name.
    set({ loading: true, conversationId, conversationOrgId, messages: [], hasMore: true });
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

  uploadAttachment: async (conversationId, file) => {
    const form = new FormData();
    form.append("file", file);
    const res = await api.postForm<{ data: { url: string; fileName: string } }>(
      `/api/v1/dm/${conversationId}/attachments`,
      form,
    );
    return { url: res.data.url, fileName: res.data.fileName };
  },

  post: async (conversationId, body, replyToId) => {
    await api.post(`/api/v1/dm/${conversationId}/messages`, replyToId ? { body, replyToId } : { body }, true);
    await get().refrescar();
    // La fila de la lista: lo último ahora es lo mío.
    void get().fetchConversations().catch(() => {});
  },

  edit: async (conversationId, messageId, body) => {
    await api.patch(`/api/v1/dm/${conversationId}/messages/${messageId}`, { body });
    await get().refrescar();
  },

  withdraw: async (conversationId, messageId) => {
    await api.delete(`/api/v1/dm/${conversationId}/messages/${messageId}`);
    await get().refrescar();
  },

  react: async (conversationId, messageId, emoji, on) => {
    const antes = get().messages.find((m) => m.id === messageId)?.reactions;
    const yo = useAuthStore.getState().session;
    const me = yo ? nombreDe(yo) : "";
    const poner = (reactions: Reaction[] | undefined) =>
      set((s) => ({
        messages: s.messages.map((m) => (m.id === messageId ? { ...m, reactions } : m)),
      }));
    poner(applyReaction(antes, emoji, on, me));
    try {
      await api.post(`/api/v1/dm/${conversationId}/messages/${messageId}/reactions`, { emoji, on }, true);
    } catch (e) {
      poner(antes);
      throw e;
    }
  },

  onReaction: async (conversationId) => {
    if (get().conversationId === conversationId) await get().refrescar();
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
      // You are looking at it, so it is read the moment it lands — y el
      // servidor lo sabe, que es lo que pone las palomitas del otro en leído.
      await get().refrescar();
      await get().markRead(conversationId).catch(() => {});
    }
    // La fila de la lista cambia igual: su última línea es la que acaba de llegar.
    await get().fetchConversations();
  },

  onRead: (conversationId, at) =>
    set((s) => ({
      conversations: s.conversations.map((c) =>
        c.conversationId === conversationId ? { ...c, otherReadAt: at } : c,
      ),
    })),
}));

// Somebody else's private conversation must not survive a logout.
useAuthStore.subscribe((state, prev) => {
  if (prev.accessToken && !state.accessToken) {
    useDMStore.setState({ conversations: [], messages: [], conversationId: null, conversationOrgId: null });
  }
});
