import { create } from "zustand";

import { api } from "@/lib/api";
import { applyReaction, type Reaction } from "@/lib/reactions";
import { nombreDe } from "@/lib/nombres";
import { useAuthStore } from "@/store/auth.store";
import type { APIResponse } from "@/types/auth";

/**
 * El chat de la llamada: lo que se escribe mientras dura, para quien está
 * dentro (ver `domain/call_message.go`). Uno a la vez — el de la llamada en la
 * que estás —, y el visor del resumen pide el suyo por su cuenta.
 *
 * Dos formas de llegar a él:
 *  - **Un miembro**, por la llamada guardada (`sessionId`) y con su sesión de
 *    cac. El aviso en vivo (`call:message`) no trae el texto: dice de qué
 *    llamada es, y si es la tuya se vuelve a pedir el chat entero.
 *  - **Un invitado**, que no tiene sesión de cac ni avisos en vivo: con el
 *    enlace y su pase, por las rutas públicas, y preguntando cada pocos
 *    segundos mientras está dentro (`CallChat`).
 */
export interface CallMessage {
  id: string;
  sessionId: string;
  authorUserId?: string;
  authorGuestId?: string;
  authorName: string;
  body: string;
  createdAt: string;
  reactions?: Reaction[];
}

/** El invitado: el enlace firmado y su pase. */
export interface GuestChatPass {
  token: string;
  pass: string;
}

type Source = { kind: "member"; sessionId: string } | { kind: "guest"; guest: GuestChatPass };

interface CallChatState {
  source: Source | null;
  messages: CallMessage[];
  loading: boolean;
  /** Abre (o vuelve a pedir) el chat de esta llamada, como miembro. */
  load: (sessionId: string) => Promise<void>;
  /** Lo mismo, como invitado. */
  loadAsGuest: (guest: GuestChatPass) => Promise<void>;
  post: (body: string) => Promise<void>;
  withdraw: (messageId: string) => Promise<void>;
  /** Poner o quitar una reacción. Sólo miembros (v1). */
  react: (messageId: string, emoji: string, on: boolean) => Promise<void>;
  /** Llegó un mensaje: sólo si es de la llamada abierta, se vuelve a pedir. */
  onIncoming: (sessionId: string) => Promise<void>;
  reset: () => void;
}

export function fetchCallMessages(sessionId: string) {
  return api
    .get<APIResponse<CallMessage[]>>(`/api/v1/call-sessions/${sessionId}/messages`, true)
    .then((r) => r?.data ?? []);
}

function fetchAsGuest(guest: GuestChatPass) {
  return api
    .post<APIResponse<CallMessage[]>>("/api/v1/public/calls/chat", { token: guest.token, pass: guest.pass })
    .then((r) => r?.data ?? []);
}

const sameSource = (a: Source | null, b: Source) =>
  !!a &&
  a.kind === b.kind &&
  (a.kind === "member" ? a.sessionId === (b as { sessionId: string }).sessionId : a.guest.pass === (b as { guest: GuestChatPass }).guest.pass);

export const useCallChat = create<CallChatState>((set, get) => {
  const fill = async (source: Source, fetcher: () => Promise<CallMessage[]>) => {
    const same = sameSource(get().source, source);
    set({ source, loading: true, ...(same ? {} : { messages: [] }) });
    try {
      const messages = await fetcher();
      // Se cambió de llamada mientras se pedía: esto ya no es lo que se mira.
      if (sameSource(get().source, source)) set({ messages });
    } finally {
      if (sameSource(get().source, source)) set({ loading: false });
    }
  };
  const reload = () => {
    const s = get().source;
    if (!s) return Promise.resolve();
    return s.kind === "member" ? get().load(s.sessionId) : get().loadAsGuest(s.guest);
  };

  return {
    source: null,
    messages: [],
    loading: false,

    load: (sessionId) => fill({ kind: "member", sessionId }, () => fetchCallMessages(sessionId)),

    loadAsGuest: (guest) => fill({ kind: "guest", guest }, () => fetchAsGuest(guest)),

    post: async (body) => {
      const s = get().source;
      if (!s) return;
      if (s.kind === "member") {
        await api.post(`/api/v1/call-sessions/${s.sessionId}/messages`, { body }, true);
      } else {
        await api.post("/api/v1/public/calls/chat/send", { token: s.guest.token, pass: s.guest.pass, body });
      }
      await reload();
    },

    withdraw: async (messageId) => {
      const s = get().source;
      if (s?.kind !== "member") return;
      await api.delete(`/api/v1/call-sessions/${s.sessionId}/messages/${messageId}`);
      await reload();
    },

    react: async (messageId, emoji, on) => {
      const s = get().source;
      if (s?.kind !== "member") return;
      const before = get().messages.find((m) => m.id === messageId)?.reactions;
      const me = useAuthStore.getState().session;
      const put = (reactions: Reaction[] | undefined) =>
        set((st) => ({ messages: st.messages.map((m) => (m.id === messageId ? { ...m, reactions } : m)) }));
      // Al momento, y vuelta atrás si el servidor dice que no.
      put(applyReaction(before, emoji, on, me ? nombreDe(me) : ""));
      try {
        await api.post(`/api/v1/call-sessions/${s.sessionId}/messages/${messageId}/reactions`, { emoji, on }, true);
      } catch (e) {
        put(before);
        throw e;
      }
    },

    onIncoming: async (sessionId) => {
      const s = get().source;
      if (s?.kind === "member" && s.sessionId === sessionId) await get().load(sessionId);
    },

    reset: () => set({ source: null, messages: [], loading: false }),
  };
});

// Lo de una llamada no sobrevive a cerrar la sesión.
useAuthStore.subscribe((state, prev) => {
  if (prev.accessToken && !state.accessToken) useCallChat.getState().reset();
});
