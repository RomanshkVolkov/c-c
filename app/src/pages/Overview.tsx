import { useT } from "@/lib/i18n";
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { CalendarClock, CheckSquare, MessageSquare, Server as ServerIcon } from "lucide-react";
import { api } from "@/lib/api";
import { useOrgsStore } from "@/store/orgs.store";
import { useChatStore } from "@/store/chat.store";
import { useDMStore } from "@/store/dm.store";
import { useTasksStore } from "@/store/tasks.store";
import { useServers } from "@/hooks/use-servers";
import { desde, iniciales } from "@/lib/desde";

import { normalizeStatus, STATUS_LABEL_KEYS } from "@/types/report";
import type { APIResponse } from "@/types/auth";
import type { OpenTask } from "@/types/task";
import type { ReportListItem, ReportListResult } from "@/types/report";

/**
 * Con qué te encuentras al abrir la app.
 *
 * Cuatro preguntas y sus respuestas, sin tener que ir a cuatro sitios: qué
 * reportó la gente, qué queda por hacer, quién te habló y si la infraestructura
 * está en pie. Cada tarjeta lleva a la pantalla que la contesta entera; ésta no
 * pretende sustituirlas, sólo evitar el rodeo.
 *
 * Lee por su cuenta y no reutiliza `fetchReports`: aquel aplica los filtros que
 * el tablero de reportes tenga puestos, y un resumen que encoge porque alguien
 * dejó un filtro en otra pantalla estaría mintiendo sobre cuánto hay.
 */

const CERRADOS = new Set(["resolved", "closed"]);

export default function Overview() {
  const { t } = useT();
  const navigate = useNavigate();
  const orgId = useOrgsStore((s) => s.currentOrgId);
  const orgName = useOrgsStore((s) => s.currentOrg()?.name ?? "");
  const { servers } = useServers();

  const [reportes, setReportes] = useState<ReportListItem[]>([]);
  const [tareas, setTareas] = useState<OpenTask[]>([]);

  const unreadBySpace = useChatStore((s) => s.unreadBySpace);
  const fetchUnread = useChatStore((s) => s.fetchUnread);
  const conversations = useDMStore((s) => s.conversations);
  const fetchConversations = useDMStore((s) => s.fetchConversations);
  const tree = useTasksStore((s) => s.tree);
  const fetchTree = useTasksStore((s) => s.fetchTree);

  useEffect(() => {
    if (!orgId) return;
    api
      .get<APIResponse<ReportListResult>>(`/api/v1/reports/?limit=50&orgId=${orgId}`, true)
      .then((res) => {
        const items = (res.success && res.data ? res.data.items : []).map((r) => ({
          ...r,
          status: normalizeStatus(r.status),
        }));
        setReportes(items.filter((r) => !CERRADOS.has(r.status)));
      })
      .catch(() => {});
    api
      .get<APIResponse<OpenTask[]>>(`/api/v1/tasks/?limit=50`, true)
      .then((res) => setTareas(res.success && res.data ? res.data : []))
      .catch(() => {});
    fetchUnread().catch(() => {});
    fetchConversations().catch(() => {});
    fetchTree().catch(() => {});
  }, [orgId, fetchUnread, fetchConversations, fetchTree]);

  const nombreDeEspacio = useMemo(() => {
    const by = new Map(tree.map((s) => [s.id, s.name]));
    return (id: string) => by.get(id) ?? "a space";
  }, [tree]);

  // Canales y directos en una sola lista: al mirar «sin leer» no importa por
  // qué puerta entró, sino quién está esperando respuesta.
  const sinLeer = useMemo(() => {
    const canales = Object.entries(unreadBySpace)
      .filter(([, n]) => n > 0)
      .map(([spaceId, n]) => ({
        key: `c-${spaceId}`,
        donde: `#${nombreDeEspacio(spaceId)}`,
        quien: "channel",
        cuando: "",
        n,
        abrir: () => navigate(`/chat?space=${spaceId}`),
      }));
    const directos = conversations
      .filter((c) => c.unread > 0)
      .map((c) => ({
        key: `d-${c.conversationId}`,
        donde: `@${c.username}`,
        quien: c.username,
        cuando: desde(c.lastMessageAt),
        n: c.unread,
        abrir: () => navigate(`/dm?c=${c.conversationId}`),
      }));
    return [...directos, ...canales];
  }, [unreadBySpace, conversations, nombreDeEspacio, navigate]);

  const enLinea = servers.filter((s) => s.status === "online").length;

  return (
    <div className="flex-1 overflow-auto px-6 py-5">
      <div className="flex flex-col gap-3.5">
        <div className="flex items-baseline gap-2.5">
          <h2 className="text-[19px] font-semibold">{t("common:admin.overview")}</h2>
          <span className="text-xs text-muted-foreground">
            {orgName}
            {orgName && " · "}
            {new Date().toLocaleDateString(undefined, {
              weekday: "long",
              day: "numeric",
              month: "long",
            })}
          </span>
        </div>

        <div className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(320px,1fr))]">
          <Tarjeta
            icono={<CalendarClock className="size-3.5 text-warning" />}
            titulo={t("common:admin.openReports")}
            cuenta={reportes.length}
            enlace="See all →"
            onEnlace={() => navigate("/reports")}
            vacio={t("common:admin.nothingCameIn")}
          >
            {reportes.slice(0, 5).map((r) => (
              <Fila
                key={r.id}
                titulo={r.title}
                meta={r.folio || r.projectName}
                metaMono
                estado={t(STATUS_LABEL_KEYS[r.status])}
                prioridad={r.priority}
                onClick={() => navigate(`/reports?report=${r.id}`)}
              />
            ))}
          </Tarjeta>

          <Tarjeta
            icono={<CheckSquare className="size-3.5 text-primary" />}
            titulo={t("common:admin.openTasks")}
            cuenta={tareas.length}
            enlace="See all →"
            onEnlace={() => navigate("/my-work")}
            vacio={t("common:admin.nothingPending")}
          >
            {tareas.slice(0, 5).map((t) => (
              <Fila
                key={t.id}
                titulo={t.title}
                meta={`${t.spaceName} · ${t.listName}`}
                estado={t.statusName}
                prioridad={t.priority}
                onClick={() => navigate(`/tasks?task=${t.id}`)}
              />
            ))}
          </Tarjeta>
        </div>

        <Tarjeta
          icono={<MessageSquare className="size-3.5 text-destructive" />}
          titulo={t("common:admin.unread")}
          cuenta={sinLeer.reduce((n, u) => n + u.n, 0)}
          enlace="Go to Talk →"
          onEnlace={() => navigate("/chat")}
          vacio={t("common:admin.nothingWaiting")}
        >
          {sinLeer.slice(0, 6).map((u) => (
            <button
              key={u.key}
              onClick={u.abrir}
              className="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-accent/40"
            >
              <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-medium">
                {iniciales(u.quien)}
              </span>
              <span className="min-w-0 flex-1 truncate">{u.donde}</span>
              {u.cuando && (
                <span className="shrink-0 text-[11px] text-muted-foreground">{u.cuando}</span>
              )}
              <span className="shrink-0 rounded-full bg-primary px-1.5 text-[10px] font-medium leading-4 text-primary-foreground">
                {u.n > 99 ? "99+" : u.n}
              </span>
            </button>
          ))}
        </Tarjeta>

        <Tarjeta
          icono={<ServerIcon className="size-3.5 text-muted-foreground" />}
          titulo={t("common:admin.infrastructure")}
          cuenta={servers.length}
          enlace="Open →"
          onEnlace={() => navigate("/dashboard")}
          vacio={t("common:admin.noServersRegistered")}
        >
          <div className="flex flex-wrap gap-x-6 gap-y-2 px-2 py-1.5 text-sm">
            <Cifra n={servers.length} de="server" />
            <Cifra n={enLinea} de="online" total={servers.length} />
            <Cifra n={servers.filter((s) => s.type === "kubernetes").length} de="orchestrator" />
          </div>
        </Tarjeta>
      </div>
    </div>
  );
}

function Tarjeta({
  icono,
  titulo,
  cuenta,
  enlace,
  onEnlace,
  vacio,
  children,
}: {
  icono: React.ReactNode;
  titulo: string;
  cuenta: number;
  enlace: string;
  onEnlace: () => void;
  vacio: string;
  children: React.ReactNode;
}) {
  const vacia = Array.isArray(children) ? children.flat().length === 0 : !children;
  return (
    <section className="flex flex-col rounded-xl border bg-card">
      <div className="flex items-center gap-2 border-b px-3.5 py-3">
        {icono}
        <span className="font-semibold">{titulo}</span>
        <span className="text-xs text-muted-foreground">({cuenta})</span>
        <button
          onClick={onEnlace}
          className="ml-auto text-[11.5px] text-primary hover:underline"
        >
          {enlace}
        </button>
      </div>
      <div className="px-2 pb-2.5 pt-1.5">
        {vacia ? (
          <p className="px-2 py-3 text-xs text-muted-foreground">{vacio}</p>
        ) : (
          children
        )}
      </div>
    </section>
  );
}

function Fila({
  titulo,
  meta,
  metaMono,
  estado,
  prioridad,
  onClick,
}: {
  titulo: string;
  meta: string;
  metaMono?: boolean;
  estado: string;
  prioridad: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-accent/40"
    >
      <span className="min-w-0 flex-1">
        <span className="block truncate">{titulo}</span>
        <span
          className={`block truncate text-[11px] text-muted-foreground ${metaMono ? "font-mono" : ""}`}
        >
          {meta}
        </span>
      </span>
      <span className="shrink-0 rounded border px-1.5 py-0.5 text-[10px] capitalize text-muted-foreground">
        {estado}
      </span>
      <span className="shrink-0 rounded border px-1.5 py-0.5 text-[10px] capitalize text-muted-foreground">
        {prioridad}
      </span>
    </button>
  );
}

function Cifra({ n, de, total }: { n: number; de: string; total?: number }) {
  return (
    <span className="flex items-baseline gap-1.5">
      <span className="text-lg font-semibold tabular-nums">
        {total === undefined ? n : `${n}/${total}`}
      </span>
      <span className="text-xs text-muted-foreground">{de}</span>
    </span>
  );
}
