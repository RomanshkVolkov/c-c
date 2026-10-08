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

/** Alguien de fuera que pidió entrar y espera a que un miembro decida. */
export interface WaitingGuest {
  id: string;
  name: string;
  createdAt: string;
}

/** El aviso de la sala de espera: alguien llegó, o ya se decidió. */
export interface CallKnock {
  inviteId: string;
  title: string;
  createdBy: string;
  guest: WaitingGuest;
  status: "waiting" | "admitted" | "rejected";
}

/** Lo que contesta la puerta pública. **Sin token mientras se espera.** */
export interface GuestEntryResponse {
  status: "waiting" | "admitted" | "rejected";
  url?: string;
  token?: string;
  room?: string;
  identity?: string;
  name: string;
  pass: string;
  title: string;
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
  /** Llamar a un compañero a una reunión, sin la fila del timbre. */
  ring: (inviteId: string, userId: string) => Promise<void>;
  /** Por reunión: quién espera para entrar. */
  waiting: Record<string, WaitingGuest[]>;
  loadWaiting: (inviteId: string) => Promise<void>;
  admit: (inviteId: string, guestId: string) => Promise<void>;
  reject: (inviteId: string, guestId: string) => Promise<void>;
  /** Un `call:knock` del stream: alguien llegó, o otro miembro ya decidió. */
  onKnock: (k: CallKnock) => void;
}

/** Quitar a alguien de la lista de espera de una reunión. */
const sinGuest = (s: CallsState, inviteId: string, guestId: string) => ({
  waiting: { ...s.waiting, [inviteId]: (s.waiting[inviteId] ?? []).filter((g) => g.id !== guestId) },
});

export const useCalls = create<CallsState>((set) => ({
  bySpace: {},
  waiting: {},

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

  ring: async (inviteId, userId) => {
    await api.post(`/api/v1/call-invites/${inviteId}/ring`, { userId }, true);
  },

  loadWaiting: async (inviteId) => {
    const r = await api.get<APIResponse<WaitingGuest[]>>(`/api/v1/call-invites/${inviteId}/guests`);
    set((s) => ({ waiting: { ...s.waiting, [inviteId]: r.data ?? [] } }));
  },

  // La fila se quita al contestar el servidor, no antes: si otro miembro
  // decidió primero, el servidor dice que ya no espera, y la lista se vacía
  // igual por el aviso del stream.
  admit: async (inviteId, guestId) => {
    await api.post(`/api/v1/call-invites/${inviteId}/guests/${guestId}/admit`, {}, true);
    set((s) => sinGuest(s, inviteId, guestId));
  },

  reject: async (inviteId, guestId) => {
    await api.post(`/api/v1/call-invites/${inviteId}/guests/${guestId}/reject`, {}, true);
    set((s) => sinGuest(s, inviteId, guestId));
  },

  onKnock: (k) =>
    set((s) => {
      if (k.status !== "waiting") return sinGuest(s, k.inviteId, k.guest.id);
      const ya = s.waiting[k.inviteId] ?? [];
      if (ya.some((g) => g.id === k.guest.id)) return s;
      return { waiting: { ...s.waiting, [k.inviteId]: [...ya, k.guest] } };
    }),
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
  /** Pedir entrar. Devuelve el pase; el token sólo si ya te dejaron. */
  join: async (token: string, name: string, pass: string | null) => {
    const r = await api.post<APIResponse<GuestEntryResponse>>(
      "/api/v1/public/calls/join",
      { token, name, pass: pass ?? "" },
      false,
    );
    if (!r.data) throw new Error(r.error ?? "invite-invalid");
    return r.data;
  },
  /** Preguntar, con el pase, si ya te dejaron entrar. */
  status: async (token: string, pass: string) => {
    const r = await api.post<APIResponse<GuestEntryResponse>>("/api/v1/public/calls/status", { token, pass }, false);
    if (!r.data) throw new Error(r.error ?? "invite-invalid");
    return r.data;
  },
};
