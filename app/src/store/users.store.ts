import { create } from "zustand";
import { api } from "@/lib/api";
import type { APIResponse } from "@/types/auth";
import type { AdminUser, CreateUserPayload, UpdateUserPayload } from "@/types/user";
import type { UserSummary } from "@/types/collections";

interface UsersState {
  users: AdminUser[];
  loading: boolean;
  error: string | null;

  fetchUsers: () => Promise<void>;
  createUser: (payload: CreateUserPayload) => Promise<AdminUser>;
  updateUser: (id: string, payload: UpdateUserPayload) => Promise<void>;
  deleteUser: (id: string) => Promise<void>;
  /**
   * Buscar personas. Con `orgId` busca **colegas**; sin él, toda la
   * plataforma.
   *
   * No es un detalle: el servidor responde cosas distintas y una de ellas te
   * deja fuera a ti. Sin acotar, el buscador es el de «encontrar a alguien para
   * meterlo en la organización», que excluye a quien pregunta —tú no te
   * invitas— y ofrece gente de otras organizaciones. Eso llegaba al selector de
   * responsables, así que asignarte una tarea a ti mismo era imposible y
   * asignársela a un desconocido acababa en error del servidor.
   */
  search: (query: string, orgId?: string) => Promise<UserSummary[]>;
}

export const useUsersStore = create<UsersState>()((set) => ({
  users: [],
  loading: false,
  error: null,

  fetchUsers: async () => {
    set({ loading: true, error: null });
    try {
      const res = await api.get<APIResponse<AdminUser[]>>("/api/v1/users/", true);
      if (!res.success) throw new Error(res.error ?? "Failed to load users");
      set({ users: res.data ?? [] });
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
    } finally {
      set({ loading: false });
    }
  },

  createUser: async (payload) => {
    const res = await api.post<APIResponse<AdminUser>>("/api/v1/users/", payload, true);
    if (!res.success || !res.data) throw new Error(res.error ?? "Create failed");
    set((s) => ({ users: [...s.users, res.data!].sort((a, b) => a.username.localeCompare(b.username)) }));
    return res.data;
  },

  updateUser: async (id, payload) => {
    const res = await api.patch<APIResponse<unknown>>(`/api/v1/users/${id}`, payload, true);
    if (!res.success) throw new Error(res.error ?? "Update failed");
    set((s) => ({
      users: s.users.map((u) =>
        u.id === id
          ? {
              ...u,
              ...(payload.email !== undefined ? { email: payload.email } : {}),
              ...(payload.name !== undefined ? { name: payload.name } : {}),
              ...(payload.isSuperadmin !== undefined ? { isSuperadmin: payload.isSuperadmin } : {}),
            }
          : u,
      ),
    }));
  },

  deleteUser: async (id) => {
    const res = await api.delete<APIResponse<unknown>>(`/api/v1/users/${id}`);
    if (!res.success) throw new Error(res.error ?? "Delete failed");
    set((s) => ({ users: s.users.filter((u) => u.id !== id) }));
  },

  search: async (query, orgId) => {
    const q = query.trim();
    if (!q) return [];
    const res = await api.get<APIResponse<UserSummary[]>>(
      `/api/v1/users/search?q=${encodeURIComponent(q)}${orgId ? `&orgId=${orgId}` : ""}`,
      true,
    );
    if (!res.success) throw new Error(res.error ?? "Search failed");
    return res.data ?? [];
  },
}));
