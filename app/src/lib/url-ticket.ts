import { useEffect, useState } from "react";
import { create } from "zustand";
import { api } from "@/lib/api";
import type { APIResponse } from "@/types/auth";

/**
 * Pases de URL (barrido de seguridad, 6-oct-2026).
 *
 * Un `<img>` y un `EventSource` no mandan cabeceras, así que la web llevaba el
 * token de acceso en la URL, y una URL acaba en los logs de cualquier proxy.
 * El servidor ya no lo acepta ahí: por la URL va un pase corto (30 min) que
 * sólo sirve para leer adjuntos (`media`) o escuchar el stream (`events`).
 *
 * El de adjuntos se pide al entrar y se renueva antes de caducar, porque
 * `mediaSrc` es síncrono: una imagen no puede esperar a pedirlo. El del stream
 * se pide en cada conexión. El escritorio no usa nada de esto: sus adjuntos y
 * su stream van con cabecera, desde Rust.
 */
export type URLScope = "media" | "events";

interface Ticket {
  ticket: string;
  expiresAt: number;
}

const useTickets = create<{ media: Ticket | null }>(() => ({ media: null }));

/** Margen: un pase al que le queda menos que esto se renueva. */
const MARGIN_MS = 10 * 60 * 1000;

const vigente = (t: Ticket | null): t is Ticket => !!t && t.expiresAt - Date.now() > MARGIN_MS;

/** Pide un pase al servidor. */
async function fetchTicket(scope: URLScope): Promise<Ticket> {
  const res = await api.post<APIResponse<{ ticket: string; expiresAt: string }>>(
    `/api/v1/auth/url-ticket?scope=${scope}`,
    {},
    true,
  );
  if (!res.success || !res.data) throw new Error(res.error ?? "url-ticket-failed");
  return { ticket: res.data.ticket, expiresAt: Date.parse(res.data.expiresAt) };
}

/** Un pase del alcance pedido, del almacén si aún vale, o uno nuevo. */
export async function urlTicket(scope: URLScope): Promise<string> {
  if (scope === "media") {
    const cached = useTickets.getState().media;
    if (vigente(cached)) return cached.ticket;
    const t = await fetchTicket("media");
    useTickets.setState({ media: t });
    return t.ticket;
  }
  return (await fetchTicket(scope)).ticket;
}

/** El pase de adjuntos que haya ahora, sin esperar. */
export function currentMediaTicket(): string | null {
  return useTickets.getState().media?.ticket ?? null;
}

/**
 * Mantiene el pase de adjuntos de la web: lo pide al entrar y lo renueva antes
 * de que caduque. Devuelve si ya se puede pintar; si pedirlo falla, también
 * (mejor imágenes rotas que una pantalla en blanco), y lo vuelve a intentar.
 */
export function useMediaTicket(enabled: boolean): boolean {
  const tiene = useTickets((s) => !!s.media);
  const [fallo, setFallo] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    let vivo = true;
    const pedir = () =>
      urlTicket("media")
        .then(() => vivo && setFallo(false))
        .catch(() => vivo && setFallo(true));
    void pedir();
    const id = setInterval(pedir, 60_000);
    return () => {
      vivo = false;
      clearInterval(id);
    };
  }, [enabled]);
  return !enabled || tiene || fallo;
}
