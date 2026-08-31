import { useT, type MessageKey } from "@/lib/i18n";
import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { AtSign, Bot, CalendarClock, CheckSquare, ChevronDown, ChevronRight, Hash, Info, MessageSquare, Settings, UserPlus, Zap } from "lucide-react";
import { groupInbox, summarize, type NotificationGroup } from "@/lib/notification-groups";
import { useInboxStore, type GroupTally, type InboxItem } from "@/store/inbox.store";
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

type Tab = "all" | "talk" | "tasks" | "system";

/**
 * Las pestañas, por clave. El rótulo sale del catálogo al pintarlas.
 *
 * La clave es la que manda —es la que agrupa las clases y la que se compara— y
 * el texto es sólo cómo se lee. Guardar aquí la palabra traducida haría que
 * cambiar de idioma cambiara la lógica.
 */
const TABS: { key: Tab; labelKey: MessageKey }[] = [
  { key: "all", labelKey: "notifications:tab.all" },
  // «Talk» y no «Mentions», que es como lo llama el prototipo: aquí caen
  // también los directos y los mensajes de los canales que sigues, y ninguno de
  // los dos te nombra. Una pestaña que promete menciones y trae mensajes
  // corrientes deja de servir para encontrar quién te buscaba.
  { key: "talk", labelKey: "notifications:tab.talk" },
  { key: "tasks", labelKey: "notifications:tab.tasks" },
  { key: "system", labelKey: "notifications:tab.system" },
];

/** A qué pestaña pertenece cada clase, y con qué cara se dibuja. */
const KINDS: Record<string, { group: Tab; tagKey?: MessageKey; icon: typeof AtSign; color: string }> = {
  "chat:mention": { group: "talk", tagKey: "notifications:kind.mention", icon: AtSign, color: "text-primary" },
  "dm:message": { group: "talk", tagKey: "notifications:kind.direct", icon: MessageSquare, color: "text-primary" },
  "chat:message": { group: "talk", tagKey: "notifications:kind.channel", icon: Hash, color: "text-muted-foreground" },
  "task:comment": { group: "tasks", tagKey: "notifications:kind.comment", icon: CheckSquare, color: "text-foreground" },
  "task:assigned": { group: "tasks", tagKey: "notifications:kind.assigned", icon: UserPlus, color: "text-primary" },
  "task:status": { group: "tasks", tagKey: "notifications:kind.status", icon: CheckSquare, color: "text-muted-foreground" },
  "report:new": { group: "system", tagKey: "notifications:kind.report", icon: Zap, color: "text-warning" },
  // Sin esta entrada caería en UNKNOWN_KIND: funcionaría, pero sin etiqueta y en
  // «System», que es donde se guarda lo que no se supo clasificar.
  "meeting:reminder": {
    group: "talk", tagKey: "notifications:kind.meeting", icon: CalendarClock, color: "text-primary",
  },
};

// Sin etiqueta a propósito: no hay palabra honesta para «no sé qué es esto».
// Sin `tagKey`: no hay palabra honesta para «no sé qué es esto», y una cadena
// vacía sería una clave de catálogo que no existe.
const UNKNOWN_KIND = { group: "system" as Tab, icon: Info, color: "text-muted-foreground" };

export default function NotificationsPanel({
  open,
  onOpenChange,
  onOpenPrefs,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onOpenPrefs: () => void;
}) {
  const { t } = useT();
  const navigate = useNavigate();
  const items = useInboxStore((s) => s.items);
  const unread = useInboxStore((s) => s.unread);
  const markRead = useInboxStore((s) => s.markRead);
  const markReadGroup = useInboxStore((s) => s.markReadGroup);
  const tallies = useInboxStore((s) => s.groups);
  const markAllRead = useInboxStore((s) => s.markAllRead);
  const [tab, setTab] = useState<Tab>("all");
  /**
   * Qué grupos están abiertos, **por clave de grupo**.
   *
   * Ni por índice ni por id de fila: `releerBandeja()` reemplaza el array entero
   * cada vez que llega un evento, así que cualquier otra llave cerraría el grupo
   * que el usuario acaba de abrir en cuanto alguien escriba. Invisible en
   * desarrollo, insufrible en un canal vivo.
   */
  const [expanded, setAbiertos] = useState<Set<string>>(new Set());

  const toggle = (clave: string) =>
    setAbiertos((prev) => {
      const next = new Set(prev);
      if (!next.delete(clave)) next.add(clave);
      return next;
    });

  const { unreadGroups, readGroups } = useMemo(() => {
    const mine =
      tab === "all"
        ? items
        : items.filter((n) => (KINDS[n.kind] ?? UNKNOWN_KIND).group === tab);
    // Se parte **antes** de agrupar. Un grupo con leídas y sin leer a la vez no
    // se puede colocar: arriba subiría lo ya leído por encima del rótulo «Read»,
    // y abajo escondería avisos nuevos debajo de él.
    return {
      unreadGroups: groupInbox(mine.filter((n) => !n.readAt)),
      readGroups: groupInbox(mine.filter((n) => n.readAt)),
    };
  }, [items, tab]);

  if (!open) return null;

  const openOne = (n: InboxItem) => {
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
  const openGroup = (g: NotificationGroup) => {
    const { link } = summarize(g);
    // Por clave y no por los ids que haya a mano: la página trae 50 y el grupo
    // puede tener trescientos. Quien sabe cuántas hay es el servidor.
    void markReadGroup(g.key);
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
          <span className="font-semibold">{t("notifications:title")}</span>
          {unread > 0 && (
            <span className="rounded-full bg-primary px-1.5 text-[10px] font-medium leading-4 text-primary-foreground">
              {unread > 99 ? "99+" : unread}
            </span>
          )}
          <div className="ml-auto flex items-center gap-2.5 text-[11.5px] text-muted-foreground">
            {unread > 0 && (
              <button className="hover:text-foreground" onClick={() => void markAllRead()}>
                {t("notifications:markAllRead")}
              </button>
            )}
            <button
              title={t("notifications:prefs.title")}
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
          {TABS.map((pestana) => (
            <button
              key={pestana.key}
              onClick={() => setTab(pestana.key)}
              className={cn(
                "rounded-md px-2.5 py-1 text-xs",
                tab === pestana.key
                  ? "bg-accent text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {t(pestana.labelKey)}
            </button>
          ))}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2.5 pt-1.5">
          {unreadGroups.length === 0 && readGroups.length === 0 && (
            <p className="px-2.5 py-5 text-center text-xs text-muted-foreground">
              {t("notifications:empty")}
            </p>
          )}

          {unreadGroups.map((g) => (
            <GroupRow
              key={g.key}
              g={g}
              tally={tallies.find((t) => t.key === g.key)}
              abierto={expanded.has(g.key)}
              onToggle={() => toggle(g.key)}
              onOpenGroup={() => openGroup(g)}
              onOpen={openOne}
            />
          ))}

          {readGroups.length > 0 && (
            <>
              <p className="px-2 pb-0.5 pt-2 text-[10.5px] uppercase tracking-wider text-muted-foreground">
                {t("notifications:read")}
              </p>
              {readGroups.map((g) => (
                <GroupRow
                  key={g.key}
                  g={g}
                  isRead
                  tally={tallies.find((t) => t.key === g.key)}
                  abierto={expanded.has(g.key)}
                  onToggle={() => toggle(g.key)}
                  onOpenGroup={() => openGroup(g)}
                  onOpen={openOne}
                />
              ))}
            </>
          )}
        </div>

        <p className="flex items-start gap-2.5 border-t px-3.5 py-2.5 text-[11.5px] leading-relaxed text-muted-foreground">
          <Info className="mt-0.5 size-3.5 shrink-0 text-primary" />
          {t("notifications:footer")}
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
function GroupRow({
  g,
  isRead,
  tally,
  abierto,
  onToggle,
  onOpenGroup,
  onOpen,
}: {
  g: NotificationGroup;
  isRead?: boolean;
  /** Lo que el servidor cuenta de esta conversación, si lo mandó. */
  tally?: GroupTally;
  abierto: boolean;
  onToggle: () => void;
  onOpenGroup: () => void;
  onOpen: (n: InboxItem) => void;
}) {
  // Antes del return, por lo mismo que en `VozEnCurso`: un grupo de uno salía
  // con un hook menos que uno de varios, y la campana se caía en cuanto una
  // conversación pasaba de un mensaje a dos.
  const { t } = useT();
  if (g.alone) return <Row n={g.items[0]} isRead={isRead} onClick={() => onOpen(g.items[0])} />;

  const s = summarize(g);
  // El contador del servidor manda: cuenta la bandeja entera y no la página.
  // Sin él —una fila de las antiguas, sin clave guardada— se usa lo que hay
  // cargado, que es lo que teníamos antes de contar de verdad.
  const count = isRead ? tally?.total ?? s.count : tally?.unread ?? s.count;
  // Y si el servidor dice que hay más de las que llegaron, se dice: enseñar 47 y
  // desplegar 12 sin avisar parece que faltan.
  const hidden = (tally?.total ?? g.items.length) - g.items.length;
  const kind = KINDS[g.items[0].kind] ?? UNKNOWN_KIND;
  // El icono es el de la familia y no cambia al entrar otro mensaje. La única
  // excepción es una mención: «alguien te nombró ahí dentro» es lo que decide si
  // tienes que abrirlo ya.
  const Icon = s.mention ? AtSign : kind.icon;
  const listId = `group-${g.key}`;

  return (
    <div className={cn(isRead && "opacity-55")}>
      {/* Dos botones hermanos y no uno dentro de otro: anidarlos es HTML
          inválido, y el de fuera se comería los clics del de dentro. */}
      <div className="flex items-start gap-1 rounded-lg hover:bg-accent/60">
        <button
          onClick={onToggle}
          aria-expanded={abierto}
          aria-controls={listId}
          aria-label={t(abierto ? "notifications:collapse" : "notifications:expand", {
            name: s.title,
          })}
          className="mt-2 grid size-5 shrink-0 place-items-center rounded text-muted-foreground hover:text-foreground"
        >
          {abierto ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
        </button>

        <button
          onClick={onOpenGroup}
          className="grid min-w-0 flex-1 grid-cols-[22px_minmax(0,1fr)_10px] items-start gap-2 py-2 pr-2 text-left"
        >
          <Icon className={cn("mt-0.5 size-4", s.mention ? "text-primary" : kind.color)} />
          <span className="min-w-0">
            <span className="flex items-center gap-1.5">
              <span className="truncate text-[13px] font-semibold">{s.title}</span>
              <span className="shrink-0 rounded-full bg-primary/15 px-1.5 text-[10px] font-medium leading-4 text-primary">
                {count}
              </span>
              {kind.tagKey && (
                <span className="shrink-0 rounded bg-muted px-1 text-[10px] leading-4 text-muted-foreground">
                  {t(kind.tagKey)}
                </span>
              )}
              {s.agent && (
                // Frase distinta de la de una fila suelta a propósito: dice que
                // hay algo de un agente **dentro**, no que lo sea la cabecera.
                <span
                  title={t("notifications:byAgent_group", {
                    count: g.items.filter((n) => n.via === "mcp").length,
                  })}
                  className="flex shrink-0 items-center gap-0.5 rounded bg-muted px-1 text-[10px] leading-4 text-muted-foreground"
                >
                  <Bot className="size-2.5" /> {t("notifications:agent")}
                </span>
              )}
              <span className="ml-auto shrink-0 text-[10.5px] text-muted-foreground">
                {desde(g.items.reduce((a, b) => (b.createdAt > a.createdAt ? b : a)).createdAt)}
              </span>
            </span>
            <span className="mt-0.5 block truncate text-xs text-muted-foreground">{s.detail}</span>
          </span>
          <span className={cn("mt-1.5 size-2 rounded-full", !isRead ? "bg-primary" : "bg-transparent")} />
        </button>
      </div>

      {abierto && (
        <div id={listId} role="group" className="ml-6 border-l pl-1">
          {g.items.map((n) => (
            <Row key={n.id} n={n} isRead={isRead} onClick={() => onOpen(n)} />
          ))}
          {hidden > 0 && (
            <p className="px-2 py-1 text-[10.5px] text-muted-foreground">
              {t("notifications:showing", { shown: g.items.length, total: tally?.total })}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function Row({ n, isRead, onClick }: { n: InboxItem; isRead?: boolean; onClick: () => void }) {
  const { t } = useT();
  const kind = KINDS[n.kind] ?? UNKNOWN_KIND;
  const Icon = kind.icon;
  return (
    <button
      onClick={onClick}
      className={cn(
        "grid w-full grid-cols-[26px_minmax(0,1fr)_10px] items-center gap-2.5 rounded-lg p-2 text-left hover:bg-accent/40",
        isRead && "opacity-55",
      )}
    >
      <span className="flex size-[26px] items-center justify-center rounded-lg bg-accent">
        <Icon className={cn("size-3.5", kind.color)} />
      </span>
      <span className="min-w-0">
        <span className="flex items-baseline gap-1.5">
          <span className="truncate text-[12.5px] font-semibold">{n.title}</span>
          {kind.tagKey && (
            <span className="shrink-0 rounded border px-1 text-[10px] text-muted-foreground">
              {t(kind.tagKey)}
            </span>
          )}
          {/* Lo escribió un agente por MCP. Chip aparte y no otro icono: la
              la clase dice *qué* pasó y esto dice *quién* lo hizo, que son dos
              preguntas y se leen mejor separadas. Lo declara el cliente que
              escribió, así que informa; no acredita nada. */}
          {n.via === "mcp" && (
            <span
              title={t("notifications:byAgent")}
              className="flex shrink-0 items-center gap-0.5 rounded border border-primary/40 px-1 text-[10px] text-primary"
            >
              <Bot className="size-2.5" />
              {t("notifications:agent")}
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
