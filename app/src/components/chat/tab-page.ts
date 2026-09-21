import { useCallback, useEffect, useState } from "react";

import { api } from "@/lib/api";
import type { ChatTabPage } from "@/store/chat.store";

/**
 * Una pestaña paginada del canal — Multimedia y Enlaces.
 *
 * Las dos leen lo mismo de distinta manera, así que la mecánica es una sola: la
 * consulta, el cursor y el pegado de páginas. Lo único que cambia es la ruta y
 * cómo se pinta cada fila.
 *
 * Dos cosas que no son evidentes y sí importan:
 *
 *   - **El cursor es el que manda el servidor, no la fecha del último
 *     elemento.** Una página aquí es una ventana *de canal*, no de resultados,
 *     así que puede volver corta —o vacía— con historial todavía por detrás.
 *     Deducir el cursor de lo que llegó pararía el deslizamiento en la primera
 *     ventana floja y escondería el resto del canal sin decirlo.
 *   - **Se deduplica también al pegar páginas.** El servidor deduplica dentro
 *     de una página, que es lo único que puede ver; el mismo enlace pegado dos
 *     veces con semanas de diferencia cae en dos ventanas distintas.
 */
export function useTabPage<T extends { id?: string; url?: string }>(
  spaceId: string,
  which: "media" | "links",
  query = "",
) {
  const [items, setItems] = useState<T[]>([]);
  const [before, setBefore] = useState<string | undefined>(undefined);
  const [hasMore, setHasMore] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);

  const load = useCallback(
    async (from?: string) => {
      setLoading(true);
      try {
        // La consulta viaja al servidor, no se aplica aquí. Filtrar lo ya
        // cargado sólo miraría la última ventana: lo de hace tres pantallas no
        // saldría, y una búsqueda que no encuentra no dice «no está cargado»,
        // dice «no está».
        const params = new URLSearchParams();
        if (from) params.set("before", from);
        if (query.trim()) params.set("q", query.trim());
        const qs = params.toString();
        const r = await api.get<{ data: ChatTabPage<T> }>(
          `/api/v1/task-spaces/${spaceId}/chat/${which}${qs ? `?${qs}` : ""}`,
        );
        const page = r.data ?? { items: [] };
        setItems((prev) => {
          const key = (x: T) => x.id ?? x.url ?? "";
          const seen = new Set(prev.map(key));
          return [...prev, ...(page.items ?? []).filter((x) => !seen.has(key(x)))];
        });
        setBefore(page.before);
        // Sin cursor de vuelta no queda canal por detrás. Es la única señal de
        // final que hay, precisamente porque una página vacía no lo es.
        setHasMore(Boolean(page.before));
        setError(false);
      } catch {
        // Sin toast: esto pasa al cambiar de pestaña, y un aviso que se va solo
        // deja la pantalla en blanco sin decir por qué.
        setError(true);
        setHasMore(false);
      } finally {
        setLoading(false);
      }
    },
    [spaceId, which, query],
  );

  // Al cambiar de canal se vacía: las fotos de un canal bajo el nombre de otro
  // es el mismo fallo que el hilo ya tiene resuelto en `fetch`.
  useEffect(() => {
    setItems([]);
    setBefore(undefined);
    setHasMore(true);
    void load(undefined);
  }, [load]);

  return { items, loading, error, hasMore: hasMore && !error, more: () => void load(before) };
}
