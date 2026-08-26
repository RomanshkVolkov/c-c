import { create } from "zustand";
import { api, refreshAccessToken } from "@/lib/api";
import type { APIResponse } from "@/types/auth";
import type { Invitation } from "@/types/organization";

interface InvitationsState {
  pending: Invitation[];
  loading: boolean;

  fetchMine: () => Promise<void>;
  /**
   * Aceptar, y **renovar la sesión** antes de dar la operación por terminada.
   *
   * Devuelve si la renovación salió: sin token nuevo la invitación está
   * aceptada en el servidor y la app sigue sin poder ver nada, y quien llame
   * tiene que poder decirlo en vez de enseñar una pantalla vacía.
   */
  accept: (id: string) => Promise<{ renovado: boolean }>;
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

    // El token **lleva dentro** a qué organizaciones perteneces, y todo lo que
    // autoriza —el árbol, los canales, la voz— se resuelve contra eso y no
    // contra la base. Así que aceptar creaba la membresía en el servidor y
    // dejaba en la mano una credencial que seguía diciendo que no perteneces a
    // nada: la app se veía vacía hasta cerrar sesión y volver a entrar.
    //
    // Es la peor primera impresión posible — alguien acaba de aceptar y no ve
    // nada, y lo natural es pensar que no le dieron permisos.
    const renovado = (await refreshAccessToken()) !== null;
    return { renovado };
  },

  decline: async (id) => {
    const res = await api.post<APIResponse<unknown>>(`/api/v1/invitations/${id}/decline`, {}, true);
    if (!res.success) throw new Error(res.error ?? "Decline failed");
    set((s) => ({ pending: s.pending.filter((i) => i.id !== id) }));
  },

  reset: () => set({ pending: [], loading: false }),
}));
