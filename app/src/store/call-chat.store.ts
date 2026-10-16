import { create } from "zustand";

import { api } from "@/lib/api";
import { useAuthStore } from "@/store/auth.store";
import type { APIResponse } from "@/types/auth";

/**
 * El chat de la llamada: lo que se escribe mientras dura, para quien está
 * dentro (ver `domain/call_message.go`). Uno a la vez — el de la llamada en la
 * que estás —, y el visor del resumen pide el suyo por su cuenta.
 *
 * El aviso en vivo (`call:message`) no trae el texto: dice de qué llamada es,
 * y si es la tuya se vuelve a pedir el chat entero, que dura lo que dura una
 * llamada.
 */
export interface CallMessage {
  id: string;
  sessionId: string;
  authorUserId?: string;
  authorGuestId?: string;
  authorName: string;
  body: string;
  createdAt: string;
}

interface CallChatState {
  sessionId: string | null;
  messages: CallMessage[];
  loading: boolean;
  /** Abre (o vuelve a pedir) el chat de esta llamada. */
  load: (sessionId: string) => Promise<void>;
  post: (body: string) => Promise<void>;
  withdraw: (messageId: string) => Promise<void>;
  /** Llegó un mensaje: sólo si es de la llamada abierta, se vuelve a pedir. */
  onIncoming: (sessionId: string) => Promise<void>;
  reset: () => void;
}

export function fetchCallMessages(sessionId: string) {
  return api
    .get<APIResponse<CallMessage[]>>(`/api/v1/call-sessions/${sessionId}/messages`, true)
    .then((r) => r?.data ?? []);
}

export const useCallChat = create<CallChatState>((set, get) => ({
  sessionId: null,
  messages: [],
  loading: false,

  load: async (sessionId) => {
    const same = get().sessionId === sessionId;
    set({ sessionId, loading: true, ...(same ? {} : { messages: [] }) });
    try {
      const messages = await fetchCallMessages(sessionId);
      // Se cambió de llamada mientras se pedía: esto ya no es lo que se mira.
      if (get().sessionId === sessionId) set({ messages });
    } finally {
      if (get().sessionId === sessionId) set({ loading: false });
    }
  },

  post: async (body) => {
    const sessionId = get().sessionId;
    if (!sessionId) return;
    await api.post(`/api/v1/call-sessions/${sessionId}/messages`, { body }, true);
    await get().load(sessionId);
  },

  withdraw: async (messageId) => {
    const sessionId = get().sessionId;
    if (!sessionId) return;
    await api.delete(`/api/v1/call-sessions/${sessionId}/messages/${messageId}`);
    await get().load(sessionId);
  },

  onIncoming: async (sessionId) => {
    if (get().sessionId === sessionId) await get().load(sessionId);
  },

  reset: () => set({ sessionId: null, messages: [], loading: false }),
}));

// Lo de una llamada no sobrevive a cerrar la sesión.
useAuthStore.subscribe((state, prev) => {
  if (prev.accessToken && !state.accessToken) useCallChat.getState().reset();
});
