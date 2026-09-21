import { Loader2, Paperclip } from "lucide-react";

import { fecha } from "@/lib/fechas";
import { useT } from "@/lib/i18n";
import { mediaSrc } from "@/lib/media";
import { useTabPage } from "@/components/chat/tab-page";
import { TabState } from "@/components/chat/TabState";
import type { ChatMediaItem } from "@/store/chat.store";

/**
 * Lo que se ha enseñado en este canal.
 *
 * No hay tabla que guarde esta relación, y no hace falta: el servidor la lee de
 * los propios cuerpos (ver `repository/chat.go`). De ahí salen dos cosas gratis
 * que una columna `message_id` no daría — un fichero que alguien subió y no
 * llegó a mandar no existe aquí, y retirar un mensaje se lleva sus imágenes.
 *
 * La extracción se queda **en el servidor** a propósito: hacerla aquí sólo
 * podría mirar la página del hilo que estuviera cargada, así que la imagen de
 * hace tres pantallas no aparecería hasta que alguien deslizara hasta ella, que
 * es justo lo que esta pestaña viene a evitar.
 */
export default function MediaTab({ spaceId, query }: { spaceId: string; query: string }) {
  const { t } = useT();
  const { items, loading, error, hasMore, more } = useTabPage<ChatMediaItem>(spaceId, "media", query);

  if (items.length === 0) {
    // El vacío dice dónde buscar lo que no está aquí. Una imagen pegada de otra
    // web no es un fichero de este canal: vive en Enlaces, y quien no lo sepa
    // se queda creyendo que la pestaña se perdió algo.
    return <TabState loading={loading} error={error} empty={query ? t("chat:noHits") : t("chat:mediaEmpty")} />;
  }

  return (
    <div className="space-y-3 p-3">
      <div className="grid grid-cols-2 gap-2">
        {items.map((f) => (
          <Tile key={f.id} f={f} />
        ))}
      </div>
      {hasMore && <LoadOlder loading={loading} onClick={more} />}
    </div>
  );
}

function Tile({ f }: { f: ChatMediaItem }) {
  const isImage = (f.contentType ?? "").startsWith("image/");
  const src = mediaSrc(f.url);
  return (
    <figure className="overflow-hidden rounded-md border">
      {isImage && src ? (
        <img src={src} alt={f.fileName} className="h-28 w-full bg-muted/30 object-cover" />
      ) : (
        // Lo que no es una imagen no se intenta pintar: un `<img>` sobre un PDF
        // da un icono roto, que se lee como «esto se perdió».
        <div className="flex h-28 w-full items-center justify-center bg-muted/30">
          <Paperclip className="size-5 text-muted-foreground" />
        </div>
      )}
      <figcaption className="space-y-0.5 p-1.5">
        <p className="truncate text-xs font-medium" title={f.fileName}>
          {f.fileName}
        </p>
        <p className="truncate text-[11px] text-muted-foreground">
          {[f.authorName, fecha(f.postedAt)].filter(Boolean).join(" · ")}
        </p>
      </figcaption>
    </figure>
  );
}

/** «Cargar lo anterior»: una ventana más de canal hacia atrás. */
export function LoadOlder({ loading, onClick }: { loading: boolean; onClick: () => void }) {
  const { t } = useT();
  return (
    <button
      onClick={onClick}
      disabled={loading}
      className="flex w-full items-center justify-center gap-1 rounded-md border py-1.5 text-xs text-muted-foreground hover:text-foreground"
    >
      {loading && <Loader2 className="size-3 animate-spin" />}
      {t("chat:loadMore")}
    </button>
  );
}
