import { create } from "zustand";
import { persist } from "zustand/middleware";
import { api } from "@/lib/api";
import type { APIResponse } from "@/types/auth";
import type {
  Organization,
  CreateOrganizationPayload,
} from "@/types/organization";

interface OrgsState {
  orgs: Organization[];
  currentOrgId: string | null;
  loading: boolean;

  fetchOrgs: () => Promise<void>;
  setCurrentOrg: (id: string) => void;
  createOrg: (payload: CreateOrganizationPayload) => Promise<Organization>;
  currentOrg: () => Organization | null;
  reset: () => void;
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
        set((s) => ({ orgs: [...s.orgs, org], currentOrgId: org.id }));
        return org;
      },

      currentOrg: () => {
        const { orgs, currentOrgId } = get();
        return orgs.find((o) => o.id === currentOrgId) ?? null;
      },

      reset: () => set({ orgs: [], currentOrgId: null, loading: false }),
    }),
    {
      name: "cac-orgs",
      // Only the selection is persisted; the org list is refetched on load.
      partialize: (state) => ({ currentOrgId: state.currentOrgId }),
    }
  )
);
