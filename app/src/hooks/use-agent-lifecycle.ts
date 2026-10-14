import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { api, apiUrl } from "@/lib/api";
import { AGENT_VERSION_LATEST, agentUpdateOutcome } from "@/lib/deploy";
import { useT } from "@/lib/i18n";
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
 *
 * **Después espera a que el agente nuevo hable** y lo dice: «v4 → v5, en
 * línea», «ya estaba en v5», o que no volvió. Antes acababa al terminar el
 * ssh, y eso sólo dice que se lanzó: un contenedor que no arranca (una imagen
 * que no baja, un secret malo) se veía igual que uno que sí.
 */
/** Cuánto se espera el primer latido del agente nuevo, y cada cuánto se mira. */
export const AGENT_WAIT_MS = 90_000;
const AGENT_POLL_MS = 3_000;
export function useAgentLifecycle(onDone?: () => void | Promise<void>) {
  const { t } = useT();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [waitingId, setWaitingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  /** El primer latido del agente nuevo, o null si no llega a tiempo. */
  const waitForAgent = async (server: Server) => {
    const deadline = Date.now() + AGENT_WAIT_MS;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, AGENT_POLL_MS));
      const res = await api.get<APIResponse<Server>>(`/api/v1/servers/${server.id}`).catch(() => null);
      const outcome = res?.data ? agentUpdateOutcome(server, res.data) : null;
      if (outcome) return outcome;
    }
    return null;
  };

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
      setWaitingId(server.id);
      const outcome = await waitForAgent(server);
      if (!outcome) {
        toast.warning(t("common:servers.agentUpdate.silent", { name: server.name }), {
          description: t("common:servers.agentUpdate.silentHint"),
          duration: 15_000,
        });
      } else if (outcome.from === outcome.to) {
        toast.success(t("common:servers.agentUpdate.same", { name: server.name, version: outcome.to }));
      } else {
        toast.success(t("common:servers.agentUpdate.changed", { name: server.name, from: outcome.from, to: outcome.to }));
      }
      if (outcome && outcome.to < AGENT_VERSION_LATEST) {
        // Volvió, pero con una versión anterior: la imagen nueva no bajó y
        // Swarm se quedó con la que tenía.
        toast.warning(t("common:servers.agentUpdate.behind", { version: outcome.to, latest: AGENT_VERSION_LATEST }));
      }
      await onDone?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
      setWaitingId(null);
    }
  };

  return { busyId, waitingId, error, install };
}
