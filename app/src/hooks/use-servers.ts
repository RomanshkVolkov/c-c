import { useState, useEffect, useCallback } from "react";
import { api } from "@/lib/api";
import type { APIResponse } from "@/types/auth";
import type { Server, CreateServerPayload } from "@/types/server";

export function useServers() {
  const [servers, setServers] = useState<Server[]>([]);
  const [loading, setLoading] = useState(true);

  const fetch = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get<APIResponse<Server[]>>("/api/v1/servers/", true);
      if (res.success && res.data) setServers(res.data);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetch(); }, [fetch]);

  const createServer = async (payload: CreateServerPayload) => {
    const res = await api.post<APIResponse<Server>>("/api/v1/servers/", payload, true);
    if (!res.success || !res.data) throw new Error(res.error ?? "Failed to create server");
    setServers((prev) => [...prev, res.data!]);
    return res.data;
  };

  const deleteServer = async (id: string) => {
    await api.delete<unknown>(`/api/v1/servers/${id}`);
    setServers((prev) => prev.filter((s) => s.id !== id));
  };

  const deployAgent = async (id: string) => {
    const res = await api.post<APIResponse<unknown>>(`/api/v1/servers/${id}/deploy-agent`, {}, true);
    if (!res.success) throw new Error(res.error ?? "Deploy failed");
    await fetch();
  };

  const updateAgent = async (id: string) => {
    const res = await api.post<APIResponse<unknown>>(`/api/v1/servers/${id}/update-agent`, {}, true);
    if (!res.success) throw new Error(res.error ?? "Update failed");
  };

  return { servers, loading, createServer, deleteServer, deployAgent, updateAgent, refresh: fetch };
}
