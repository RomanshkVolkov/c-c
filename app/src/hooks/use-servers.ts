import { useState, useEffect, useCallback, useMemo } from "react";
import { api } from "@/lib/api";
import type { APIResponse } from "@/types/auth";
import type { Server, CreateServerPayload } from "@/types/server";
import { useOrgsStore } from "@/store/orgs.store";

/** Form payload without orgId — the hook injects the active org automatically. */
export type NewServerInput = Omit<CreateServerPayload, "orgId">;

export function useServers() {
  const [allServers, setAllServers] = useState<Server[]>([]);
  const [loading, setLoading] = useState(true);
  const currentOrgId = useOrgsStore((s) => s.currentOrgId);

  const fetch = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get<APIResponse<Server[]>>("/api/v1/servers/", true);
      if (res.success && res.data) setAllServers(res.data);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetch(); }, [fetch]);

  // The backend returns servers across every org the user belongs to; the UI
  // shows only the active org's servers so the switcher scopes the dashboard.
  const servers = useMemo(
    () =>
      currentOrgId
        ? allServers.filter((s) => s.orgId === currentOrgId)
        : allServers,
    [allServers, currentOrgId]
  );

  const createServer = async (input: NewServerInput) => {
    if (!currentOrgId) throw new Error("No organization selected");
    const payload: CreateServerPayload = { ...input, orgId: currentOrgId };
    const res = await api.post<APIResponse<Server>>("/api/v1/servers/", payload, true);
    if (!res.success || !res.data) throw new Error(res.error ?? "Failed to create server");
    setAllServers((prev) => [...prev, res.data!]);
    return res.data;
  };

  const deleteServer = async (id: string) => {
    await api.delete<unknown>(`/api/v1/servers/${id}`);
    setAllServers((prev) => prev.filter((s) => s.id !== id));
  };

  return { servers, loading, createServer, deleteServer, refresh: fetch };
}
