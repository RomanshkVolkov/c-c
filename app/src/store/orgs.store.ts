import { create } from "zustand";
import { persist } from "zustand/middleware";
import { api, refreshAccessToken } from "@/lib/api";
import type { APIResponse } from "@/types/auth";
import type {
  Organization,
  CreateOrganizationPayload,
  OrgMember,
  OrgRole,
  AddMemberPayload,
  Invitation,
  CreateInvitationPayload,
} from "@/types/organization";

interface OrgsState {
  orgs: Organization[];
  currentOrgId: string | null;
  loading: boolean;

  fetchOrgs: () => Promise<void>;
  setCurrentOrg: (id: string) => void;
  createOrg: (payload: CreateOrganizationPayload) => Promise<Organization>;
  renameOrg: (id: string, name: string) => Promise<void>;
  /**
   * Save the name and any rules that changed.
   *
   * A partial patch: fields the form did not mention are absent, and the server
   * reads "absent" as "leave it alone" rather than "set it to false" — so
   * saving one toggle cannot quietly turn the others off.
   */
  updateOrg: (
    id: string,
    patch: {
      name?: string;
      domain?: string;
      defaultInviteRole?: OrgRole;
      clientsSeeOnlyTheirSpace?: boolean;
      guestsCanUseDevTools?: boolean;
    },
  ) => Promise<void>;
  deleteOrg: (id: string) => Promise<void>;
  currentOrg: () => Organization | null;
  reset: () => void;

  // Members (org admin / superadmin).
  listMembers: (orgId: string) => Promise<OrgMember[]>;
  addMember: (orgId: string, payload: AddMemberPayload) => Promise<void>;
  updateMemberRole: (orgId: string, userId: string, role: OrgRole) => Promise<void>;
  removeMember: (orgId: string, userId: string) => Promise<void>;

  // Invitations (org admin / superadmin).
  listOrgInvitations: (orgId: string) => Promise<Invitation[]>;
  createInvitation: (orgId: string, payload: CreateInvitationPayload) => Promise<void>;
  revokeInvitation: (orgId: string, invitationId: string) => Promise<void>;
  resendInvitation: (orgId: string, invitationId: string) => Promise<void>;
}

export const useOrgsStore = create<OrgsState>()(
  persist(
    (set, get) => ({
      orgs: [],
      currentOrgId: null,
      loading: false,

      fetchOrgs: async () => {
        set({ loading: true });
        try {
          const res = await api.get<APIResponse<Organization[]>>(
            "/api/v1/organizations/",
            true
          );
          const orgs = res.success && res.data ? res.data : [];
          // Keep the persisted selection if it still exists; otherwise fall back
          // to the first org so the app always has an active org context.
          const current = get().currentOrgId;
          const stillValid = orgs.some((o) => o.id === current);
          set({
            orgs,
            currentOrgId: stillValid ? current : (orgs[0]?.id ?? null),
          });
        } finally {
          set({ loading: false });
        }
      },

      setCurrentOrg: (id) => set({ currentOrgId: id }),

      createOrg: async (payload) => {
        const res = await api.post<APIResponse<Organization>>(
          "/api/v1/organizations/",
          payload,
          true
        );
        if (!res.success || !res.data)
          throw new Error(res.error ?? "Failed to create organization");
        const org = res.data;
        // Mismo motivo que al aceptar una invitación: la pertenencia viaja
        // dentro del token, así que sin renovarlo la organización recién creada
        // se abriría vacía —y quien la crea es justo quien no puede achacarlo a
        // «aún no me han dado permisos»—.
        await refreshAccessToken();
        set((s) => ({ orgs: [...s.orgs, org], currentOrgId: org.id }));
        return org;
      },

      renameOrg: async (id, name) => {
        const res = await api.patch<APIResponse<Organization>>(
          `/api/v1/organizations/${id}`,
          { name },
          true,
        );
        if (!res.success) throw new Error(res.error ?? "Rename failed");
        set((s) => ({ orgs: s.orgs.map((o) => (o.id === id ? { ...o, name } : o)) }));
      },

      updateOrg: async (id, patch) => {
        const actual = get().orgs.find((o) => o.id === id);
        const res = await api.patch<APIResponse<Organization>>(
          `/api/v1/organizations/${id}`,
          // The name is required by the server's validator, so it travels even
          // when only a rule changed.
          { name: patch.name ?? actual?.name, ...patch },
          true,
        );
        if (!res.success) throw new Error(res.error ?? "Save failed");
        // The server's answer wins: it decides what a partial patch left alone.
        if (res.data) {
          set((s) => ({ orgs: s.orgs.map((o) => (o.id === id ? { ...o, ...res.data! } : o)) }));
        }
      },

      deleteOrg: async (id) => {
        const res = await api.delete<APIResponse<unknown>>(`/api/v1/organizations/${id}`);
        if (!res.success) throw new Error(res.error ?? "Delete failed");
        set((s) => {
          const orgs = s.orgs.filter((o) => o.id !== id);
          const currentOrgId = s.currentOrgId === id ? (orgs[0]?.id ?? null) : s.currentOrgId;
          return { orgs, currentOrgId };
        });
      },

      currentOrg: () => {
        const { orgs, currentOrgId } = get();
        return orgs.find((o) => o.id === currentOrgId) ?? null;
      },

      reset: () => set({ orgs: [], currentOrgId: null, loading: false }),

      listMembers: async (orgId) => {
        const res = await api.get<APIResponse<OrgMember[]>>(
          `/api/v1/organizations/${orgId}/members`,
          true,
        );
        if (!res.success) throw new Error(res.error ?? "Failed to load members");
        return res.data ?? [];
      },

      addMember: async (orgId, payload) => {
        const res = await api.post<APIResponse<unknown>>(
          `/api/v1/organizations/${orgId}/members`,
          payload,
          true,
        );
        if (!res.success) throw new Error(res.error ?? "Failed to add member");
      },

      updateMemberRole: async (orgId, userId, role) => {
        const res = await api.patch<APIResponse<unknown>>(
          `/api/v1/organizations/${orgId}/members/${userId}`,
          { role },
          true,
        );
        if (!res.success) throw new Error(res.error ?? "Failed to update member");
      },

      removeMember: async (orgId, userId) => {
        const res = await api.delete<APIResponse<unknown>>(
          `/api/v1/organizations/${orgId}/members/${userId}`,
        );
        if (!res.success) throw new Error(res.error ?? "Failed to remove member");
      },

      listOrgInvitations: async (orgId) => {
        const res = await api.get<APIResponse<Invitation[]>>(
          `/api/v1/organizations/${orgId}/invitations`,
          true,
        );
        if (!res.success) throw new Error(res.error ?? "Failed to load invitations");
        return res.data ?? [];
      },

      createInvitation: async (orgId, payload) => {
        const res = await api.post<APIResponse<unknown>>(
          `/api/v1/organizations/${orgId}/invitations`,
          payload,
          true,
        );
        if (!res.success) throw new Error(res.error ?? "Failed to send invitation");
      },

      // «Reenviar» le devuelve el plazo a una invitación. Como se aceptan
      // dentro de la app y no por correo, no hay nada que volver a mandar: lo
      // que se recupera es la vigencia de la que ya caducó.
      resendInvitation: async (orgId, invitationId) => {
        const res = await api.post<APIResponse<unknown>>(
          `/api/v1/organizations/${orgId}/invitations/${invitationId}/resend`,
          {},
          true,
        );
        if (!res.success) throw new Error(res.error ?? "Failed to resend invitation");
      },

      revokeInvitation: async (orgId, invitationId) => {
        const res = await api.delete<APIResponse<unknown>>(
          `/api/v1/organizations/${orgId}/invitations/${invitationId}`,
        );
        if (!res.success) throw new Error(res.error ?? "Failed to revoke invitation");
      },
    }),
    {
      name: "cac-orgs",
      // Only the selection is persisted; the org list is refetched on load.
      partialize: (state) => ({ currentOrgId: state.currentOrgId }),
    }
  )
);
