import { useState, useEffect, useCallback, useMemo } from "react";
import { api } from "@/lib/api";
import type { APIResponse } from "@/types/auth";
import type { Server, CreateServerPayload } from "@/types/server";
import { useOrgsStore } from "@/store/orgs.store";
import { agentResponde } from "@/lib/agent";

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

  /**
   * Comprobar si el agente contesta, y anotarlo.
   *
   * El estado guardado se escribía «pending» al dar de alta el servidor y no lo
   * tocaba nadie más nunca: un agente desplegado y funcionando seguía leyéndose
   * como pendiente para siempre, y «Agents online» contaba 0 de 1 con el
   * servidor en pie. `UpdateStatus` existía en el repositorio sin un solo
   * llamante.
   *
   * Lo comprueba la app y no el servidor porque el agente vive en la VPS del
   * cliente y quien alcanza esa red es este escritorio. Eso hay que decirlo tal
   * cual: el estado es «lo que la última consola que miró pudo alcanzar».
   *
   * Sólo los `docker-swarm`: un servidor de kubernetes no lleva este agente y
   * marcarlo «offline» sería inventarse una avería.
   */
  useEffect(() => {
    const candidatos = allServers.filter((s) => s.type === "docker-swarm");
    if (candidatos.length === 0) return;
    let cancelado = false;

    (async () => {
      const vistos = await Promise.all(
        candidatos.map(async (s) => ({
          id: s.id,
          status: (await agentResponde(s.host, s.agentPort)) ? "online" : "offline",
        })),
      );
      if (cancelado) return;
      // Sólo lo que cambió. Filtrar ya evita las escrituras —una lista vacía
      // no manda nada—; la salida temprana ahorra además reconstruir el estado
      // en el caso normal, que es que todo siga igual.
      const cambios = vistos.filter(
        (v) => candidatos.find((s) => s.id === v.id)?.status !== v.status,
      );
      if (cambios.length === 0) return;
      setAllServers((prev) =>
        prev.map((s) => {
          const v = cambios.find((c) => c.id === s.id);
          return v ? { ...s, status: v.status as Server["status"] } : s;
        }),
      );
      await Promise.all(
        cambios.map((c) =>
          api
            .post(`/api/v1/servers/${c.id}/agent-status`, { status: c.status }, true)
            .catch(() => {}),
        ),
      );
    })();

    return () => {
      cancelado = true;
    };
    // Por la *forma* de la lista y no por su identidad: `allServers` es un array
    // nuevo en cada carga y esto volvería a sondear en bucle.
  }, [allServers.map((s) => `${s.id}:${s.host}:${s.agentPort}:${s.type}`).join(",")]);

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

  const updateServer = async (id: string, input: NewServerInput) => {
    const res = await api.patch<APIResponse<Server>>(`/api/v1/servers/${id}`, input, true);
    if (!res.success || !res.data) throw new Error(res.error ?? "Failed to update server");
    setAllServers((prev) => prev.map((s) => (s.id === id ? res.data! : s)));
    return res.data;
  };

  const deleteServer = async (id: string) => {
    await api.delete<unknown>(`/api/v1/servers/${id}`);
    setAllServers((prev) => prev.filter((s) => s.id !== id));
  };

  return { servers, loading, createServer, updateServer, deleteServer, refresh: fetch };
}
