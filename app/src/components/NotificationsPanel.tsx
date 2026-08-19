import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { AtSign, Bot, CheckSquare, Hash, Info, MessageSquare, Settings, UserPlus, Zap } from "lucide-react";
import { useInboxStore, type InboxItem } from "@/store/inbox.store";
import { desde } from "@/lib/desde";
import { cn } from "@/lib/utils";

/**
 * Lo que pasó mientras no mirabas, colgando de la campana.
 *
 * Cuelga de arriba a la derecha y no es un cajón de altura completa: esto se
 * consulta de pasada —¿me habló alguien?— y un panel que tapa la pantalla
 * obliga a cerrarlo para volver a lo que estabas haciendo.
 *
 * El registro de entrega —«¿el sistema llegó a enseñar el aviso?»— se fue al
 * diálogo de preferencias. Es un diagnóstico, no una noticia, y mezclarlo con
 * lo que ocurrió hacía leer el doble para encontrar lo mismo; junto a «qué
 * avisos quiero» es donde la pregunta se contesta sola.
 */

type Pestana = "all" | "talk" | "tasks" | "system";

const PESTANAS: { key: Pestana; label: string }[] = [
  { key: "all", label: "All" },
  // «Talk» y no «Mentions», que es como lo llama el prototipo: aquí caen
  // también los directos y los mensajes de los canales que sigues, y ninguno de
  // los dos te nombra. Una pestaña que promete menciones y trae mensajes
  // corrientes deja de servir para encontrar quién te buscaba.
  { key: "talk", label: "Talk" },
  { key: "tasks", label: "Tasks" },
  { key: "system", label: "System" },
];

/** A qué pestaña pertenece cada clase, y con qué cara se dibuja. */
const CLASES: Record<string, { grupo: Pestana; tag: string; icono: typeof AtSign; color: string }> = {
  "chat:mention": { grupo: "talk", tag: "mention", icono: AtSign, color: "text-primary" },
  "dm:message": { grupo: "talk", tag: "direct", icono: MessageSquare, color: "text-primary" },
  "chat:message": { grupo: "talk", tag: "channel", icono: Hash, color: "text-muted-foreground" },
  "task:comment": { grupo: "tasks", tag: "comment", icono: CheckSquare, color: "text-foreground" },
  "task:assigned": { grupo: "tasks", tag: "assigned", icono: UserPlus, color: "text-primary" },
  "task:status": { grupo: "tasks", tag: "status", icono: CheckSquare, color: "text-muted-foreground" },
  "report:new": { grupo: "system", tag: "report", icono: Zap, color: "text-warning" },
};

const DESCONOCIDA = { grupo: "system" as Pestana, tag: "", icono: Info, color: "text-muted-foreground" };

export default function NotificationsPanel({
  open,
  onOpenChange,
  onOpenPrefs,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onOpenPrefs: () => void;
}) {
  const navigate = useNavigate();
  const items = useInboxStore((s) => s.items);
  const unread = useInboxStore((s) => s.unread);
  const markRead = useInboxStore((s) => s.markRead);
  const markAllRead = useInboxStore((s) => s.markAllRead);
  const [pestana, setPestana] = useState<Pestana>("all");

  const { sinLeer, leidas } = useMemo(() => {
    const suyas =
      pestana === "all"
        ? items
        : items.filter((n) => (CLASES[n.kind] ?? DESCONOCIDA).grupo === pestana);
    return {
      sinLeer: suyas.filter((n) => !n.readAt),
      leidas: suyas.filter((n) => n.readAt),
    };
  }, [items, pestana]);

  if (!open) return null;

  const abrir = (n: InboxItem) => {
    void markRead([n.id]);
    if (n.link) {
      onOpenChange(false);
      navigate(n.link);
    }
  };

  return (
    <div className="fixed inset-0 z-50">
      {/* El fondo se oscurece y cierra al pulsarlo: sin él, un panel flotante
          sobre una pantalla viva no se sabe si está abierto o pegado. */}
      <div className="absolute inset-0 bg-black/35" onClick={() => onOpenChange(false)} />
      <div className="absolute right-3 top-11 flex max-h-[calc(100%-3.5rem)] w-[392px] flex-col overflow-hidden rounded-xl border bg-card shadow-2xl">
        <div className="flex items-center gap-2.5 border-b px-3.5 py-2.5">
          <span className="font-semibold">Notifications</span>
          {unread > 0 && (
            <span className="rounded-full bg-primary px-1.5 text-[10px] font-medium leading-4 text-primary-foreground">
              {unread > 99 ? "99+" : unread}
            </span>
          )}
          <div className="ml-auto flex items-center gap-2.5 text-[11.5px] text-muted-foreground">
            {unread > 0 && (
              <button className="hover:text-foreground" onClick={() => void markAllRead()}>
                Mark all read
              </button>
            )}
            <button
              title="Notification settings"
              className="hover:text-foreground"
              onClick={() => {
                onOpenChange(false);
                onOpenPrefs();
              }}
            >
              <Settings className="size-3.5" />
            </button>
          </div>
        </div>

        <div className="flex gap-0.5 border-b px-2.5 py-2">
          {PESTANAS.map((t) => (
            <button
              key={t.key}
              onClick={() => setPestana(t.key)}
              className={cn(
                "rounded-md px-2.5 py-1 text-xs",
                pestana === t.key
                  ? "bg-accent text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2.5 pt-1.5">
          {sinLeer.length === 0 && leidas.length === 0 && (
            <p className="px-2.5 py-5 text-center text-xs text-muted-foreground">
              Nothing pending in this organization.
            </p>
          )}

          {sinLeer.map((n) => (
            <Fila key={n.id} n={n} onClick={() => abrir(n)} />
          ))}

          {leidas.length > 0 && (
            <>
              <p className="px-2 pb-0.5 pt-2 text-[10.5px] uppercase tracking-wider text-muted-foreground">
                Read
              </p>
              {leidas.map((n) => (
                <Fila key={n.id} n={n} leida onClick={() => abrir(n)} />
              ))}
            </>
          )}
        </div>

        <p className="flex items-start gap-2.5 border-t px-3.5 py-2.5 text-[11.5px] leading-relaxed text-muted-foreground">
          <Info className="mt-0.5 size-3.5 shrink-0 text-primary" />
          Clicking a system notification opens the thread here, in the app.
        </p>
      </div>
    </div>
  );
}

function Fila({ n, leida, onClick }: { n: InboxItem; leida?: boolean; onClick: () => void }) {
  const clase = CLASES[n.kind] ?? DESCONOCIDA;
  const Icono = clase.icono;
  return (
    <button
      onClick={onClick}
      className={cn(
        "grid w-full grid-cols-[26px_minmax(0,1fr)_10px] items-center gap-2.5 rounded-lg p-2 text-left hover:bg-accent/40",
        leida && "opacity-55",
      )}
    >
      <span className="flex size-[26px] items-center justify-center rounded-lg bg-accent">
        <Icono className={cn("size-3.5", clase.color)} />
      </span>
      <span className="min-w-0">
        <span className="flex items-baseline gap-1.5">
          <span className="truncate text-[12.5px] font-semibold">{n.title}</span>
          {clase.tag && (
            <span className="shrink-0 rounded border px-1 text-[10px] text-muted-foreground">
              {clase.tag}
            </span>
          )}
          {/* Lo escribió un agente por MCP. Chip aparte y no otro icono: la
              clase dice *qué* pasó y esto dice *quién* lo hizo, que son dos
              preguntas y se leen mejor separadas. Lo declara el cliente que
              escribió, así que informa; no acredita nada. */}
          {n.via === "mcp" && (
            <span
              title="Written by an agent through the MCP server"
              className="flex shrink-0 items-center gap-0.5 rounded border border-primary/40 px-1 text-[10px] text-primary"
            >
              <Bot className="size-2.5" />
              agent
            </span>
          )}
          <span className="ml-auto shrink-0 whitespace-nowrap text-[10.5px] text-muted-foreground">
            {desde(n.createdAt)}
          </span>
        </span>
        {n.body && (
          <span className="mt-0.5 block text-xs leading-snug text-muted-foreground">{n.body}</span>
        )}
      </span>
      <span
        className={cn(
          "size-1.5 rounded-full",
          !n.readAt ? "bg-primary" : "bg-transparent",
        )}
      />
    </button>
  );
}
