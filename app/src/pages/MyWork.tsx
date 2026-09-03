import i18next from "i18next";

import { useT, type MessageKey } from "@/lib/i18n";
import { STATUS_LABEL_KEYS } from "@/types/report";
import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { AlertCircle, CalendarDays, Eye, EyeOff, FileText, KanbanSquare, List, Loader2, X } from "lucide-react";
import { toast } from "sonner";
import CopyId from "@/components/CopyId";
import { useReportsStore } from "@/store/reports.store";
import KanbanBoard from "@/components/kanban/KanbanBoard";
import ItemCalendar from "@/components/ItemCalendar";
import PinnedLine from "@/components/docs/PinnedLine";
import NewTaskRow from "@/components/tasks/NewTaskRow";
import TaskCardMini, { cuando } from "@/components/tasks/TaskCardMini";
import { useMyWorkStore, type WorkLens } from "@/store/mywork.store";
import { useOrgsStore } from "@/store/orgs.store";
import { useNavigate } from "react-router-dom";
import { useTasksStore } from "@/store/tasks.store";
import { priorityMeta } from "@/types/task";
import type { OpenTask } from "@/types/task";
import { normalizeStatus, puedeIr, type ReportStatus } from "@/types/report";
import { cn } from "@/lib/utils";

/**
 * Everything open, across every space, one question at a time.
 *
 * The tabs are lenses and not filters over a downloaded list: each one is a
 * different question asked of the server. That matters beyond tidiness — "all
 * the open work in this organization" is not something worth shipping to a
 * client so it can throw most of it away.
 *
 * Grouped by space because that is how people hold their work in their head:
 * not "forty tasks" but "three for this client, two for that one".
 */

const LENSES: { key: WorkLens; labelKey: MessageKey }[] = [
  { key: "assigned", labelKey: "work:myWork.lens.assigned" },
  { key: "created", labelKey: "work:myWork.lens.created" },
  { key: "watching", labelKey: "work:myWork.lens.watching" },
  { key: "clients", labelKey: "work:myWork.lens.clients" },
  { key: "all", labelKey: "work:myWork.lens.all" },
];

/**
 * The three ways to look at the same answer.
 *
 * All three read the rows already fetched — none of them asks the server
 * again. A board across many lists groups by state and not by column, because
 * the columns are a rendering of one shared state machine, so "in progress"
 * means the same thing in every list; grouping by column would invent as many
 * boards as there are lists.
 */
const VISTAS = [
  { key: "list", labelKey: "work:myWork.view.list", icon: List },
  { key: "board", labelKey: "work:myWork.view.board", icon: KanbanSquare },
  { key: "calendar", labelKey: "work:myWork.view.calendar", icon: CalendarDays },
] as const satisfies readonly { key: string; labelKey: MessageKey; icon: unknown }[];

type Vista = (typeof VISTAS)[number]["key"];

/**
 * Las cuatro columnas, por **estado** y no por clase.
 *
 * La clase junta `done` y `closed`, así que una tarea cerrada aparecía dentro
 * de «terminadas» sin forma de distinguirla. Y cerrada no es lo mismo que
 * hecha: un reporte se puede cerrar sin arreglarlo, y por la integración
 * server-to-server llegan así de verdad.
 */
const ESTADOS: { status: ReportStatus; punto: string }[] = [
  { status: "open", punto: "bg-muted-foreground" },
  { status: "in_progress", punto: "bg-primary" },
  { status: "done", punto: "bg-success" },
  { status: "closed", punto: "bg-muted-foreground/60" },
];

/** Terminadas y cerradas sólo se piden cuando pides «todos los estados». */
const CERRADOS: ReportStatus[] = ["done", "closed"];

export default function MyWork() {
  const { t } = useT();
  const [vista, setVista] = useState<Vista>("list");
  const [creando, setCreando] = useState(false);
  const [params, setParams] = useSearchParams();
  useEffect(() => {
    if (params.get("new") !== "1") return;
    setCreando(true);
    const resto = new URLSearchParams(params);
    resto.delete("new");
    setParams(resto, { replace: true });
  }, [params, setParams]);
  const { lens, includeClosed, tasks, loading, error, scope } = useMyWorkStore();
  const setScope = useMyWorkStore((s) => s.setScope);
  const setLens = useMyWorkStore((s) => s.setLens);
  const setIncludeClosed = useMyWorkStore((s) => s.setIncludeClosed);
  const load = useMyWorkStore((s) => s.load);
  const orgId = useOrgsStore((s) => s.currentOrgId);
  const openTask = useTasksStore((s) => s.openTask);
  // El documento se pinta en `/tasks`, así que hay que ir allí además de
  // abrirlo. Abrirlo sin navegar deja el estado puesto y la pantalla igual.
  const openDocEnTareas = useTasksStore((s) => s.openDoc);
  const navigate = useNavigate();
  const statusesOf = useTasksStore((s) => s.statusesOf);
  const moveTask = useTasksStore((s) => s.moveTask);

  /**
   * Arrastrar una tarjeta a otra columna, aquí, significa **cambiarle el estado
   * en su propia lista**.
   *
   * Las columnas de esta pantalla son transversales: las tarjetas vienen de
   * listas y de espacios distintos, y «Done» no es una columna de ningún
   * tablero concreto sino el mismo estado visto en todos a la vez. Soltar algo
   * ahí no lo mueve de lista — eso sería una operación completamente distinta y
   * nadie la pidió arrastrando.
   *
   * El id de la columna de destino se le **pregunta al servidor** en vez de
   * componerlo aquí. Se podría: son `<listId>/<estado>`. Pero esa forma es una
   * regla suya, y copiarla al cliente es cómo se acaba con dos versiones de la
   * misma verdad — hoy mismo costó dos fallos con la API del SFU.
   */
  const mover = async (taskId: string, columna: string) => {
    const t = visibles.find((x) => x.id === taskId);
    if (!t || normalizeStatus(t.status) === columna) return;
    try {
      const columnas = await statusesOf(t.listId);
      const destino = columnas.find((c) => normalizeStatus(c.status) === columna);
      if (!destino) {
        throw new Error(i18next.t("common:crash.columnMissing", { column: columna, list: t.listName }));
      }
      // Sin vecinos: se añade al final. Es el sitio menos sorprendente cuando
      // la columna de la que vienes ni siquiera es del mismo tablero.
      await moveTask(t.id, destino.id, "", "");
      await load(orgId);
    } catch (e) {
      toast.error(String(e));
    }
  };

  // La máquina de estados del servidor, para no ofrecer destinos imposibles.
  //
  // `fetchTransitions` no vuelve a pedirla si ya la tiene, así que llamarla en
  // cada montaje no cuesta nada. Estaba escrita desde hace tiempo y no la
  // llamaba nadie.
  const transiciones = useReportsStore((s) => s.transitions);
  const fetchTransitions = useReportsStore((s) => s.fetchTransitions);
  useEffect(() => {
    fetchTransitions().catch(() => {});
  }, [fetchTransitions]);

  useEffect(() => {
    load(orgId).catch(() => {});
  }, [load, orgId, lens, includeClosed]);

  // Narrowed in the client rather than re-asked: every row already says which
  // space and list it is in, so pointing the same answer at a smaller part of
  // it costs nothing and keeps the tree instant.
  const visibles = useMemo(() => {
    if (!scope) return tasks;
    return tasks.filter((t) =>
      scope.kind === "list" ? t.listId === scope.id : t.spaceId === scope.id,
    );
  }, [tasks, scope]);

  // Grouped in the order the tree shows spaces, so the two read the same way.
  //
  // The tree itself is selected, and the order derived out here. A selector
  // must return the same reference when nothing changed, and `.map()` never
  // does: zustand compares with Object.is, sees a new array every render, and
  // renders again — which is the infinite loop, not a slow one.
  const tree = useTasksStore((s) => s.tree);
  const orden = useMemo(() => tree.map((t) => t.id), [tree]);
  const grupos = useMemo(() => {
    const by = new Map<string, { name: string; items: OpenTask[] }>();
    for (const t of visibles) {
      const g = by.get(t.spaceId) ?? { name: t.spaceName, items: [] };
      g.items.push(t);
      by.set(t.spaceId, g);
    }
    return [...by.entries()].sort(
      (a, b) => (orden.indexOf(a[0]) + 1 || 99) - (orden.indexOf(b[0]) + 1 || 99),
    );
  }, [visibles, orden]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="shrink-0 border-b px-4 pt-3">
        <div className="flex items-baseline gap-2">
          <h1 className="text-lg font-semibold">{t("work:myWork.title")}</h1>
          <span className="text-xs text-muted-foreground">
            {loading ? "…" : `${visibles.length} visible`}
          </span>
          <button
            onClick={() => setCreando(true)}
            className="ml-auto rounded bg-primary px-2 py-1 text-xs font-medium text-primary-foreground"
          >
            New task
          </button>
          <button
            onClick={() => setIncludeClosed(!includeClosed)}
            className="flex items-center gap-1.5 rounded border px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
            title={includeClosed ? t("work:myWork.hideFinished") : t("work:myWork.showFinished")}
          >
            {includeClosed ? <Eye className="size-3" /> : <EyeOff className="size-3" />}
            {includeClosed ? t("work:myWork.allStates") : t("work:myWork.openOnly")}
          </button>
        </div>
        {scope && (
          <div className="mt-1 flex items-center gap-1.5">
            <button
              onClick={() => setScope(null)}
              className="flex items-center gap-1 self-start rounded-full border bg-accent/40 px-2 py-0.5 text-xs hover:bg-accent"
              title={t("work:myWork.showEverything")}
            >
              {/* Says out loud that you are seeing part of it. A filtered list with
                  nothing announcing the filter reads as "there is nothing here". */}
              {scope.kind === "list" ? t("work:myWork.scopeList") : t("work:myWork.scopeSpace")}: {scope.name}
              <X className="size-3" />
            </button>
            {/* El id, para dárselo a un agente. El tablero de Tasks ya lo
                enseña; aquí no, y era donde hacía falta: se llega a esta
                pantalla pinchando una lista del árbol, y copiar el uuid a mano
                de otro sitio es donde se tuerce una sesión de MCP. */}
            <CopyId id={scope.id} label={scope.kind} />
          </div>
        )}
        <nav className="-mb-px flex items-center gap-4 pt-2 text-sm">
          {LENSES.map((l) => (
            <button
              key={l.key}
              onClick={() => setLens(l.key)}
              className={cn(
                "border-b-2 pb-2",
                l.key === lens
                  ? "border-primary font-medium text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              {t(l.labelKey)}
            </button>
          ))}
          <span className="ml-auto flex items-center gap-0.5 pb-1.5">
            {VISTAS.map((v) => (
              <button
                key={v.key}
                onClick={() => setVista(v.key)}
                title={t(v.labelKey)}
                aria-pressed={v.key === vista}
                className={cn(
                  "rounded px-1.5 py-1",
                  v.key === vista
                    ? "bg-accent text-accent-foreground"
                    : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                )}
              >
                <v.icon className="size-3.5" />
              </button>
            ))}
            {/* La documentación, detrás de un divisor.
                Aquí y no sólo en el tablero porque **aquí** es donde se aterriza
                al pulsar una lista en el árbol: el tablero está a dos clics, en
                el menú de la fila. Una cuarta vista que sólo existiera allí es
                una cuarta vista que no ve nadie.
                Sólo con una lista delante: la documentación cuelga de un nodo, y
                «mi trabajo» sin acotar cruza todos. */}
            {scope?.kind === "list" && (
              <>
                <span aria-hidden className="mx-0.5 h-4 w-px bg-border" />
                <button
                  onClick={() => {
                    void openDocEnTareas("list", scope.id, scope.name).catch(() => {});
                    navigate("/tasks");
                  }}
                  title={t("work:board.view.docs")}
                  className="rounded px-1.5 py-1 text-muted-foreground hover:bg-accent/50 hover:text-foreground"
                >
                  <FileText className="size-3.5" />
                </button>
              </>
            )}
          </span>
        </nav>
      </header>

      {/* Lo que hay que saber antes de coger una tarjeta, donde se cogen. */}
      {scope?.kind === "list" && <PinnedLine listId={scope.id} />}

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {creando && (
          <NewTaskRow
            // Tras cada Enter, no sólo al cerrar. La fila se queda abierta a
            // propósito —se escriben cuatro seguidas—, así que preguntar sólo al
            // cerrarla dejaba la tarea recién creada sin aparecer por ninguna
            // parte hasta cambiar de pestaña y volver.
            onCreated={() => load(orgId).catch(() => {})}
            onClose={() => {
              setCreando(false);
              // Re-ask: what you just raised may or may not belong in the lens
              // you are looking at, and guessing which would be a list that
              // disagrees with the server.
              load(orgId).catch(() => {});
            }}
          />
        )}
        {error && (
          <p className="flex items-center gap-1.5 text-xs text-destructive">
            <AlertCircle className="size-3" /> {error}
          </p>
        )}
        {loading && visibles.length === 0 ? (
          <Loader2 className="size-4 animate-spin text-muted-foreground" />
        ) : visibles.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {lens === "watching"
              ? t("work:myWork.nothingFollowed")
              : t("work:myWork.nothingHere")}
          </p>
        ) : (
          vista === "calendar" ? (
            <ItemCalendar
              // Placed by when it is due, not by when it was raised: this
              // screen answers "what is coming", and a month view of creation
              // dates answers nothing anybody asked.
              items={visibles
                .filter((t) => t.dueAt)
                .map((t) => ({
                  id: t.id,
                  title: t.title,
                  at: t.dueAt as string,
                  dotClass: priorityMeta(t.priority).className,
                  label: `#${t.seq}`,
                }))}
              onOpen={(id) => openTask(id).catch(() => {})}
              countKey="common:count.tasks"
            />
          ) : vista === "board" ? (
            <KanbanBoard
              columns={ESTADOS.map((col) => {
                // Con «sólo abiertas» lo terminado ni se pide al servidor, así
                // que esa columna no está vacía: está fuera de la pregunta.
                // Decir «0» era afirmar que no hay ninguna.
                const fuera = !includeClosed && CERRADOS.includes(col.status);
                return {
                  id: col.status,
                  title: t(STATUS_LABEL_KEYS[col.status]),
                  // El guion en vez del cero, y el porqué escrito abajo: «0»
                  // afirmaría que no hay ninguna, y lo que pasa es que no se
                  // preguntó.
                  accessory: fuera ? <span className="text-muted-foreground">—</span> : undefined,
                  emptyHint: fuera ? t("work:myWork.notAsked") : undefined,
                };
              })}
              items={visibles.map((t) => ({
                ...t,
                // La columna es el estado **normalizado**: las tarjetas vienen
                // de listas distintas y cada una trae el suyo en crudo.
                columnId: normalizeStatus(t.status),
              }))}
              renderItem={(t) => (
                <TaskCardMini task={t} onOpen={() => openTask(t.id).catch(() => {})} />
              )}
              onMove={(m) => void mover(m.itemId, m.toColumnId)}
              // Las columnas de aquí ya son el estado plegado, así que la
              // comparación es directa: el mapa que trae `fetchTransitions`
              // viene plegado en las dos direcciones por el mismo motivo.
              puedeSoltar={(t, columna) =>
                puedeIr(transiciones, normalizeStatus(t.status), columna as ReportStatus)
              }
              emptyColumnHint={t("work:myWork.nothing")}
            />
          ) : (
          <div className="space-y-5">
            {grupos.map(([spaceId, g]) => (
              <section key={spaceId}>
                <h2 className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  {g.name} · {g.items.length}
                </h2>
                <ul className="divide-y overflow-hidden rounded-xl border bg-card">
                  {g.items.map((t) => (
                    <li key={t.id}>
                      <button
                        onClick={() => openTask(t.id).catch(() => {})}
                        className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-accent/40"
                      >
                        <span className="w-10 shrink-0 font-mono text-xs text-muted-foreground">
                          #{t.seq}
                        </span>
                        <span className="min-w-0 flex-1 truncate text-sm">{t.title}</span>
                        {/* Through the helper, never indexed: the table has
                            been missing a value the server grew before, and
                            reading a field off the resulting undefined took a
                            whole screen down. */}
                        <span className={cn("shrink-0 text-xs", priorityMeta(t.priority).className)}>
                          {priorityMeta(t.priority).label}
                        </span>
                        {t.dueAt && (
                          <span
                            className={cn(
                              "w-20 shrink-0 text-right text-xs",
                              cuando(t.dueAt).vencida ? "text-destructive" : "text-muted-foreground",
                            )}
                          >
                            {cuando(t.dueAt).texto}
                          </span>
                        )}
                        <span className="w-28 shrink-0 truncate text-right text-xs text-muted-foreground">
                          {t.listName}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
          )
        )}
      </div>
    </div>
  );
}
