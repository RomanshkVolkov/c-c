import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { AtSign, Bot, CalendarClock, CheckSquare, ChevronDown, ChevronRight, Hash, Info, MessageSquare, Settings, UserPlus, Zap } from "lucide-react";
import { groupInbox, summarize, type NotificationGroup } from "@/lib/notification-groups";
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
  // Sin esta entrada caería en DESCONOCIDA: funcionaría, pero sin etiqueta y en
  // «System», que es donde se guarda lo que no se supo clasificar.
  "meeting:reminder": {
    grupo: "talk", tag: "meeting", icono: CalendarClock, color: "text-primary",
  },
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
  /**
   * Qué grupos están abiertos, **por clave de grupo**.
   *
   * Ni por índice ni por id de fila: `releerBandeja()` reemplaza el array entero
   * cada vez que llega un evento, así que cualquier otra llave cerraría el grupo
   * que el usuario acaba de abrir en cuanto alguien escriba. Invisible en
   * desarrollo, insufrible en un canal vivo.
   */
  const [abiertos, setAbiertos] = useState<Set<string>>(new Set());

  const alternar = (clave: string) =>
    setAbiertos((prev) => {
      const siguiente = new Set(prev);
      if (!siguiente.delete(clave)) siguiente.add(clave);
      return siguiente;
    });

  const { sinLeer, leidas } = useMemo(() => {
    const suyas =
      pestana === "all"
        ? items
        : items.filter((n) => (CLASES[n.kind] ?? DESCONOCIDA).grupo === pestana);
    // Se parte **antes** de agrupar. Un grupo con leídas y sin leer a la vez no
    // se puede colocar: arriba subiría lo ya leído por encima del rótulo «Read»,
    // y abajo escondería avisos nuevos debajo de él.
    return {
      sinLeer: groupInbox(suyas.filter((n) => !n.readAt)),
      leidas: groupInbox(suyas.filter((n) => n.readAt)),
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

  /**
   * Pulsar la cabecera de un grupo: se leen todas y se va donde ocurrió lo
   * último. Abrir la conversación **es** haberla leído; dejar el contador
   * puesto obligaría a volver a la campana a limpiarlo a mano.
   */
  const abrirGrupo = (g: NotificationGroup) => {
    const { link } = summarize(g);
    void markRead(g.items.map((n) => n.id));
    if (link) {
      onOpenChange(false);
      navigate(link);
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

          {sinLeer.map((g) => (
            <Bloque
              key={g.key}
              g={g}
              abierto={abiertos.has(g.key)}
              onAlternar={() => alternar(g.key)}
              onAbrirGrupo={() => abrirGrupo(g)}
              onAbrir={abrir}
            />
          ))}

          {leidas.length > 0 && (
            <>
              <p className="px-2 pb-0.5 pt-2 text-[10.5px] uppercase tracking-wider text-muted-foreground">
                Read
              </p>
              {leidas.map((g) => (
                <Bloque
                  key={g.key}
                  g={g}
                  leida
                  abierto={abiertos.has(g.key)}
                  onAlternar={() => alternar(g.key)}
                  onAbrirGrupo={() => abrirGrupo(g)}
                  onAbrir={abrir}
                />
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

/**
 * Un grupo en la lista.
 *
 * Si es uno solo se pinta **exactamente como antes**: sin galón, sin contador y
 * sin sangrado. Un «(1)» junto a un triángulo que despliega la fila que ya estás
 * mirando es cromo puro, y además dejaría cada notificación suelta con más
 * adornos que información.
 */
function Bloque({
  g,
  leida,
  abierto,
  onAlternar,
  onAbrirGrupo,
  onAbrir,
}: {
  g: NotificationGroup;
  leida?: boolean;
  abierto: boolean;
  onAlternar: () => void;
  onAbrirGrupo: () => void;
  onAbrir: (n: InboxItem) => void;
}) {
  if (g.alone) return <Fila n={g.items[0]} leida={leida} onClick={() => onAbrir(g.items[0])} />;

  const s = summarize(g);
  const clase = CLASES[g.items[0].kind] ?? DESCONOCIDA;
  // El icono es el de la familia y no cambia al entrar otro mensaje. La única
  // excepción es una mención: «alguien te nombró ahí dentro» es lo que decide si
  // tienes que abrirlo ya.
  const Icono = s.mention ? AtSign : clase.icono;
  const idLista = `grupo-${g.key}`;

  return (
    <div className={cn(leida && "opacity-55")}>
      {/* Dos botones hermanos y no uno dentro de otro: anidarlos es HTML
          inválido, y el de fuera se comería los clics del de dentro. */}
      <div className="flex items-start gap-1 rounded-lg hover:bg-accent/60">
        <button
          onClick={onAlternar}
          aria-expanded={abierto}
          aria-controls={idLista}
          aria-label={`${abierto ? "Collapse" : "Expand"} ${s.title}`}
          className="mt-2 grid size-5 shrink-0 place-items-center rounded text-muted-foreground hover:text-foreground"
        >
          {abierto ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
        </button>

        <button
          onClick={onAbrirGrupo}
          className="grid min-w-0 flex-1 grid-cols-[22px_minmax(0,1fr)_10px] items-start gap-2 py-2 pr-2 text-left"
        >
          <Icono className={cn("mt-0.5 size-4", s.mention ? "text-primary" : clase.color)} />
          <span className="min-w-0">
            <span className="flex items-center gap-1.5">
              <span className="truncate text-[13px] font-semibold">{s.title}</span>
              <span className="shrink-0 rounded-full bg-primary/15 px-1.5 text-[10px] font-medium leading-4 text-primary">
                {s.count}
              </span>
              <span className="shrink-0 rounded bg-muted px-1 text-[10px] leading-4 text-muted-foreground">
                {clase.tag}
              </span>
              {s.agent && (
                // Frase distinta de la de una fila suelta a propósito: dice que
                // hay algo de un agente **dentro**, no que lo sea la cabecera.
                <span
                  title={`Includes ${g.items.filter((n) => n.via === "mcp").length} written by an agent through the MCP server`}
                  className="flex shrink-0 items-center gap-0.5 rounded bg-muted px-1 text-[10px] leading-4 text-muted-foreground"
                >
                  <Bot className="size-2.5" /> agent
                </span>
              )}
              <span className="ml-auto shrink-0 text-[10.5px] text-muted-foreground">
                {desde(g.items.reduce((a, b) => (b.createdAt > a.createdAt ? b : a)).createdAt)}
              </span>
            </span>
            <span className="mt-0.5 block truncate text-xs text-muted-foreground">{s.detail}</span>
          </span>
          <span className={cn("mt-1.5 size-2 rounded-full", !leida ? "bg-primary" : "bg-transparent")} />
        </button>
      </div>

      {abierto && (
        <div id={idLista} role="group" className="ml-6 border-l pl-1">
          {g.items.map((n) => (
            <Fila key={n.id} n={n} leida={leida} onClick={() => onAbrir(n)} />
          ))}
        </div>
      )}
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
