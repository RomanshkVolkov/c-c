import { useCallback, useEffect, useState } from "react";

import Markdown from "@/components/markdown/Markdown";
import { TabState } from "@/components/chat/TabState";
import { LoadOlder } from "@/components/chat/MediaTab";
import { api } from "@/lib/api";
import { fecha, horaCorta } from "@/lib/fechas";
import { useT } from "@/lib/i18n";
import type { ChatMessage } from "@/store/chat.store";

const PAGE = 30;

/**
 * Lo que se dijo en este canal y contiene lo que buscas.
 *
 * **Una bySpace aparte, no el hilo filtrado.** El hilo tiene anclaje de
 * deslizamiento, refresco al llegar un mensaje y fusión de páginas; meterle un
 * filtro encima obligaría a que todo eso supiera de la búsqueda, y un mensaje
 * que llega mientras buscas reordenaría lo que estás leyendo. Aquí no hace
 * falta nada de eso: es una lectura muerta, de arriba abajo.
 *
 * El filtro lo aplica el servidor. Es la única forma de que encuentre lo dicho
 * hace tres pantallas: el hilo va paginado, así que filtrar lo ya cargado
 * respondería «no está» a algo que sí está.
 */
export default function ThreadSearch({ spaceId, query }: { spaceId: string; query: string }) {
  const { t } = useT();
  const [items, setItems] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [hasMore, setHasMore] = useState(false);

  const load = useCallback(
    async (before?: string) => {
      setLoading(true);
      try {
        const params = new URLSearchParams({ q: query.trim(), limit: String(PAGE) });
        if (before) params.set("before", before);
        const r = await api.get<{ data: ChatMessage[] }>(
          `/api/v1/task-spaces/${spaceId}/chat?${params.toString()}`,
        );
        // El servidor devuelve la página en el orden del hilo —lo más viejo
        // primero, que es como se pinta—; en una bySpace de aciertos manda lo más
        // reciente, así que se le da la vuelta.
        const page = [...(r.data ?? [])].reverse();
        setItems((prev) => (before ? [...prev, ...page] : page));
        setHasMore(page.length === PAGE);
        setError(false);
      } catch {
        setError(true);
        setHasMore(false);
      } finally {
        setLoading(false);
      }
    },
    [spaceId, query],
  );

  useEffect(() => {
    void load(undefined);
  }, [load]);

  if (items.length === 0) {
    return <TabState loading={loading} error={error} empty={t("chat:noHits")} />;
  }

  return (
    <div className="space-y-2 p-3">
      {items.map((m) => (
        <article key={m.id} className="rounded-md border p-2">
          <div className="mb-0.5 flex items-center gap-2 text-xs text-muted-foreground">
            <span className="font-medium text-foreground">
              {m.kind === "system" ? t("chat:systemAuthor") : m.authorName || "unknown"}
            </span>
            <span>
              {fecha(m.createdAt)} · {horaCorta(m.createdAt)}
            </span>
          </div>
          {/* Sin `onInternalLink`: esto es una bySpace de aciertos, y saltar a una
              tarjeta desde aquí dejaría la búsqueda a medias sin manera de
              volver a ella. */}
          <Markdown>{m.body}</Markdown>
        </article>
      ))}
      {hasMore && (
        <LoadOlder loading={loading} onClick={() => void load(items[items.length - 1]?.createdAt)} />
      )}
    </div>
  );
}
