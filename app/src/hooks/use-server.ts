import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { registerAgent } from "@/lib/agent";
import type { APIResponse } from "@/types/auth";
import type { Server } from "@/types/server";

/**
 * Un servidor, pedido por su id.
 *
 * Las pantallas de un servidor lo recibían por el `state` del router, y ese
 * estado no sobrevive a recargar ni a un enlace: se volvía al panel sin decir
 * por qué. Ahora la URL basta (`GET /servers/{id}`, que a quien no es de la
 * org le contesta 404).
 */
export function useServer(id: string | undefined) {
  const [server, setServer] = useState<Server | null>(null);
  const [loading, setLoading] = useState(true);
  const [missing, setMissing] = useState(false);

  const refresh = useCallback(async () => {
    if (!id) return;
    try {
      const res = await api.get<APIResponse<Server>>(`/api/v1/servers/${id}`, true);
      if (res.success && res.data) {
        // El agente pide pase, y para firmarlo hay que saber de qué servidor es.
        registerAgent(res.data);
        setServer(res.data);
        setMissing(false);
      } else {
        setMissing(true);
      }
    } catch {
      setMissing(true);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    setLoading(true);
    setServer(null);
    void refresh();
  }, [refresh]);

  return { server, loading, missing, refresh };
}
