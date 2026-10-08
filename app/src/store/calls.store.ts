import { create } from "zustand";

import { api } from "@/lib/api";
import type { APIResponse } from "@/types/auth";

/**
 * Las reuniones con invitados (W3): abrirlas, verlas, cerrarlas, y la puerta
 * pública por la que entra quien no tiene cuenta.
 *
 * Una reunión es una sala aparte de la del canal (`meet:<id>`): se reenvía un
 * enlace, no la voz del equipo. Ver `docs/voz.md` §9.
 */

export interface CallOccupant {
  identity: string;
  name: string;
}

export interface CallInvite {
  id: string;
  orgId: string;
  spaceId?: string | null;
  title: string;
  createdBy: string;
  createdByName?: string;
  spaceName?: string;
  expiresAt: string;
  maxGuests: number;
  /** El token del enlace. Sólo lo ve un miembro. */
  link: string;
  occupants: CallOccupant[];
}

/** Lo que ve alguien de fuera antes de entrar. Sin ids, a propósito. */
export interface PublicCallInvite {
  title: string;
  orgName: string;
  hostName: string;
  expiresAt: string;
  recordingActive: boolean;
  recordingPossible: boolean;
}

/** ¿Es de alguien de fuera esta identidad? Por el prefijo, como el servidor. */
export const isGuestIdentity = (identity: string) => identity.startsWith("guest:");

interface CallsState {
  /** Por canal: las reuniones abiertas que cuelgan de él. */
  bySpace: Record<string, CallInvite[]>;
  load: (orgId: string, spaceId: string) => Promise<void>;
  create: (a: { orgId: string; spaceId: string; title: string; ttlHours: number }) => Promise<CallInvite>;
  get: (id: string) => Promise<CallInvite>;
  revoke: (invite: CallInvite) => Promise<void>;
  kick: (inviteId: string, identity: string) => Promise<void>;
}

export const useCalls = create<CallsState>((set) => ({
  bySpace: {},

  load: async (orgId, spaceId) => {
    const r = await api.get<APIResponse<CallInvite[]>>(
      `/api/v1/call-invites?orgId=${encodeURIComponent(orgId)}&spaceId=${encodeURIComponent(spaceId)}`,
    );
    set((s) => ({ bySpace: { ...s.bySpace, [spaceId]: r.data ?? [] } }));
  },

  create: async ({ orgId, spaceId, title, ttlHours }) => {
    const r = await api.post<APIResponse<CallInvite>>(
      "/api/v1/call-invites",
      { orgId, spaceId, title, ttlHours },
      true,
    );
    if (!r.data) throw new Error(r.error ?? "invite-invalid");
    const inv = r.data;
    set((s) => ({ bySpace: { ...s.bySpace, [spaceId]: [inv, ...(s.bySpace[spaceId] ?? [])] } }));
    return inv;
  },

  get: async (id) => {
    const r = await api.get<APIResponse<CallInvite>>(`/api/v1/call-invites/${id}`);
    if (!r.data) throw new Error(r.error ?? "invite-invalid");
    return r.data;
  },

  revoke: async (invite) => {
    await api.delete(`/api/v1/call-invites/${invite.id}`);
    const spaceId = invite.spaceId;
    if (!spaceId) return;
    set((s) => ({
      bySpace: { ...s.bySpace, [spaceId]: (s.bySpace[spaceId] ?? []).filter((i) => i.id !== invite.id) },
    }));
  },

  kick: async (inviteId, identity) => {
    await api.post(`/api/v1/call-invites/${inviteId}/participants/${encodeURIComponent(identity)}/remove`, {}, true);
  },
}));

/**
 * La puerta pública. **Sin sesión** (`auth = false`): quien entra por aquí no
 * tiene cuenta, y mandar un token —si hubiera uno guardado de otra visita— le
 * colaría una identidad que no es la que trae el enlace. Y sin sesión tampoco
 * se dispara el refresco, que en un 401 cerraría una sesión que no existe.
 */
export const publicCalls = {
  inspect: async (token: string) => {
    const r = await api.post<APIResponse<PublicCallInvite>>("/api/v1/public/calls/inspect", { token }, false);
    if (!r.data) throw new Error(r.error ?? "invite-invalid");
    return r.data;
  },
  join: async (token: string, name: string, pass: string | null) => {
    const r = await api.post<
      APIResponse<{ url: string; token: string; room: string; identity: string; name: string; pass: string; title: string }>
    >("/api/v1/public/calls/join", { token, name, pass: pass ?? "" }, false);
    if (!r.data) throw new Error(r.error ?? "invite-invalid");
    return r.data;
  },
};
