import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { api, apiUrl } from "@/lib/api";
import type { APIResponse } from "@/types/auth";
import type { Server } from "@/types/server";

interface AgentResult {
  stdout: string;
  stderr: string;
}

/**
 * Instalar (o actualizar) el agente de un servidor.
 *
 * Instalar y actualizar son lo mismo desde la versión 2 del agente: se acuña
 * una identidad nueva —lo que tumba la anterior— y se instala con ella. Un
 * agente actualizado sin identidad no abriría su API, así que «sólo cambiar la
 * imagen» ya no existe.
 *
 * Lo usan el panel de servidores y el resumen de cada uno.
 */
export function useAgentLifecycle(onDone?: () => void | Promise<void>) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const install = async (server: Server) => {
    setBusyId(server.id);
    setError(null);
    try {
      const minted = await api.post<APIResponse<{ token: string; sessionKey: string }>>(
        `/api/v1/servers/${server.id}/agent-token`,
        {},
        true,
      );
      if (!minted.success || !minted.data) throw new Error(minted.error ?? "agent-token");
      await invoke<AgentResult>("install_swarm_manage_agent", {
        install: {
          host: server.host,
          sshPort: server.sshPort,
          sshUser: server.sshUser,
          agentPort: server.agentPort,
          // La llave de 1Password del servidor, si tiene: si no, el agente de
          // ssh ofrece todas las que tiene y el servidor puede cortar antes.
          identityKey: await invoke<string | null>("get_server_ssh_key", { serverId: server.id }).catch(() => null),
          serverId: server.id,
          backendUrl: apiUrl(""),
          agentToken: minted.data.token,
          sessionKey: minted.data.sessionKey,
        },
      });
      await onDone?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  };

  return { busyId, error, install };
}
