import { fecha } from "@/lib/fechas";
import { useT } from "@/lib/i18n";
import { useTabPage } from "@/components/chat/tab-page";
import { LoadOlder } from "@/components/chat/MediaTab";
import { TabState } from "@/components/chat/TabState";
import type { ChatLinkItem } from "@/store/chat.store";

/**
 * Los enlaces de este canal, cada uno una vez y con las palabras que le
 * pusieron.
 *
 * Lo define la expresión regular del servidor y no el `LIKE '%http%'` de la
 * consulta, que sólo descarta barato: ese `LIKE` casa `![img](https://…)` y el
 * `http` de dentro de una palabra. El rótulo de `[texto](url)` es la otra mitad
 * de por qué esto no se hace en el cliente — una bySpace de cuarenta URLs peladas
 * es una bySpace que nadie lee.
 *
 * Aquí es también donde acaban las imágenes de fuera: ésas no están en
 * `chat_attachments`, así que si no cayeran en Enlaces no estarían en ninguna
 * pestaña. El vacío de Multimedia lo dice con esas palabras.
 */
export default function LinksTab({ spaceId, query }: { spaceId: string; query: string }) {
  const { t } = useT();
  const { items, loading, error, hasMore, more } = useTabPage<ChatLinkItem>(spaceId, "links", query);

  if (items.length === 0) {
    return <TabState loading={loading} error={error} empty={query ? t("chat:noHits") : t("chat:linksEmpty")} />;
  }

  return (
    <div className="space-y-3 p-3">
      <ul className="space-y-1">
        {items.map((l) => (
          <li key={l.url} className="rounded-md border p-2">
            {/* Al navegador de fuera, y no dentro: un enlace externo abierto en
                el webview saca a la persona de la app sin manera de volver. */}
            <a
              href={l.url}
              target="_blank"
              rel="noreferrer"
              title={l.url}
              className="block truncate text-sm text-primary underline decoration-primary/40 hover:decoration-primary"
            >
              {l.label || l.url}
            </a>
            <p className="truncate text-[11px] text-muted-foreground">
              {[l.authorName, fecha(l.postedAt), l.label ? l.url : ""]
                .filter(Boolean)
                .join(" · ")}
            </p>
          </li>
        ))}
      </ul>
      {hasMore && <LoadOlder loading={loading} onClick={more} />}
    </div>
  );
}
