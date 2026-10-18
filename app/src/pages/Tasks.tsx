import { showListInMyWork } from "@/lib/list-in-my-work";
import { BoardSkeleton } from "@/components/ui/skeletons";
import TagChip from "@/components/tasks/TagChip";
import PriorityChip from "@/components/tasks/PriorityChip";
import { cuando, dueClass } from "@/components/tasks/TaskCardMini";
import { fecha } from "@/lib/fechas";
import { enterOrg } from "@/lib/ir-en-org";
import { dueDay } from "@/lib/month";
import { useT } from "@/lib/i18n";
import { useCallback, useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  ListChecks,
  Plus,
  MessageSquare,
  Paperclip,
  FileText,
  RefreshCw,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import KanbanBoard, { type KanbanColumn } from "@/components/kanban/KanbanBoard";
import DocTabs from "@/components/docs/DocTabs";
import ViewSwitch, { type ListView } from "@/components/tasks/ViewSwitch";
import ListToolbar from "@/components/tasks/ListToolbar";
import TaskFilters from "@/components/tasks/TaskFilters";
import { EMPTY_FILTER, matchesFilter, type TaskFilter } from "@/lib/task-filter";
import PinnedLine from "@/components/docs/PinnedLine";
import CopyId from "@/components/CopyId";
import Initials from "@/components/ui/initials";
import ItemCalendar from "@/components/ItemCalendar";
import { useConfirm } from "@/components/ConfirmDialog";
import { usePrompt } from "@/components/PromptDialog";
import { useTasksStore } from "@/store/tasks.store";
import { useDocPages } from "@/store/doc-pages.store";
import { PrChip } from "@/components/TaskGitPanel";
import { useOrgsStore } from "@/store/orgs.store";
import { useReportsStore } from "@/store/reports.store";
import { faltanSubtareas, normalizeStatus, puedeIr, type ReportStatus } from "@/types/report";
import { isDocOwnerKind, type ItemVisibility, type TaskCard } from "@/types/task";
import { cn } from "@/lib/utils";
import { statusTone } from "@/lib/status-color";

export default function Tasks() {
  const fetchTags = useTasksStore((s) => s.fetchTags);
  const activeListId = useTasksStore((s) => s.activeListId);
  const refreshBoard = useTasksStore((s) => s.refreshBoard);

  // Only the tags: the tree, its doc index and the unread counts moved to the
  // navigator when that moved to the sidebar, because they have to be there
  // whether or not this screen is open.
  const currentOrgId = useOrgsStore((s) => s.currentOrgId);
  useEffect(() => {
    fetchTags();
  }, [currentOrgId, fetchTags]);

  // Restore the persisted list on first mount.
  useEffect(() => {
    if (activeListId) refreshBoard();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ?task=<id> — the dashboard's pending list jumps straight into the drawer.
  // The board behind it stays on whatever list was last open: the task may
  // live somewhere else entirely, and yanking the board around underneath
  // would lose the place the user was actually working in.
  const openTask = useTasksStore((s) => s.openTask);
  const [params, setParams] = useSearchParams();
  useEffect(() => {
    const id = params.get("task");
    if (!id) return;
    // Consumed once, or closing the drawer here would reopen it immediately.
    setParams({}, { replace: true });
    // Y en su org: el enlace puede venir de otra (un aviso, un canal). La org
    // se sabe al cargar la tarea; hasta entonces el cajón no la pinta.
    openTask(id)
      .then(() => enterOrg(useTasksStore.getState().detail?.task.orgId))
      .catch(() => {});
  }, [params, setParams, openTask]);

  // ?doc=<kind>:<id> — el enlace que se pega en un canal al compartir.
  //
  // Se consume una sola vez, igual que ?task=: si se quedara en la URL, cerrar
  // el documento lo reabriría en el mismo instante.
  const openDoc = useTasksStore((s) => s.openDoc);
  useEffect(() => {
    const ref = params.get("doc");
    if (!ref) return;
    const [kind, id] = ref.split(":");
    // Se leen antes de vaciar: después ya no están.
    const page = params.get("page");
    const tab = params.get("tab") ?? undefined;
    setParams({}, { replace: true });
    if (!id || !isDocOwnerKind(kind)) return;
    if (page) useDocPages.getState().openPage({ kind, id }, page).catch(() => {});
    else useDocPages.getState().requestTab(tab);
    // El nombre lo pone el documento al cargar; aquí todavía no se sabe, y
    // poner el identificador en el título sería peor que dejarlo vacío.
    openDoc(kind, id, "")
      .then(() => enterOrg(useTasksStore.getState().activeDoc?.orgId))
      .catch(() => {});
  }, [params, setParams, openDoc]);

  // A document takes over the right pane: it belongs to a space or folder, which
  // have no board of their own, and for a list it's an alternative view of the
  // same node rather than something to show beside it.
  // Sólo si es de la org en pantalla: está persistido y sobrevivía a cambiar
  // de org. Ver `store/org-switch.ts`.
  const activeDoc = useTasksStore((s) => (s.activeDoc?.orgId === currentOrgId ? s.activeDoc : null));

  // La vista vive en el store y no aquí por dos razones que se juntan.
  //
  // `docs` es una de las cuatro: si viviera dentro del tablero, abrir la
  // documentación lo desmontaría y volver te dejaría siempre en Board, hubieras
  // estado donde hubieras estado. Y además tiene que sobrevivir al arranque —
  // quien prefiere el kanban lo prefiere siempre. Sigue siendo de quien mira y
  // no del equipo: se guarda en local, así que dos personas pueden ver la misma
  // lista de formas distintas.
  const view = useTasksStore((s) => s.boardView);
  const setView = useTasksStore((s) => s.setBoardView);
  const navigate = useNavigate();

  return (
    <div className="flex-1 flex min-h-0">
      {activeDoc ? (
        <DocTabs
          onView={(v) => {
            // Las tareas de la lista del documento, en «Mi trabajo» acotado a
            // ella: es la pantalla a la que lleva pulsar la lista en el árbol, y
            // pasar de Documentación a Tablero no puede llevar a otra distinta
            // (jose, 18-oct-2026). La lista del documento y no la que
            // estuviera abierta: se puede llegar aquí desde un enlace de otra.
            if (activeDoc.kind === "list") {
              showListInMyWork(activeDoc, v);
              navigate("/my-work");
              return;
            }
            setView(v);
          }}
        />
      ) : (
        <Board view={view} setView={setView} />
      )}
    </div>
  );
}


/** The colour of the column a card sits in, so the calendar reads like the board. */
function dotForStatus(statuses: { id: string; status: string }[], statusId: string): string {
  return statusTone(statuses.find((s) => s.id === statusId)?.status).dot;
}

// ─── Board ────────────────────────────────────────────────────────────────────

function Board({
  view,
  setView,
}: {
  view: Exclude<ListView, "docs">;
  setView: (v: Exclude<ListView, "docs">) => void;
}) {
  const { t } = useT();
  const board = useTasksStore((s) => s.board);
  // El filtro es de la lista en la que se puso: al cambiar de lista vuelve a
  // vacío, o una búsqueda olvidada dejaría la lista nueva en blanco sin decir
  // por qué. Se guarda con su id y no con un efecto que lo borre, para que no
  // haya ni un render de la lista nueva filtrada por lo de la anterior.
  const [filterOf, setFilterOf] = useState<{ listId: string; filter: TaskFilter }>({
    listId: "",
    filter: EMPTY_FILTER,
  });
  const filter = board && filterOf.listId === board.list.id ? filterOf.filter : EMPTY_FILTER;

  // La máquina de estados del servidor, para no ofrecer destinos imposibles.
  const transitions = useReportsStore((s) => s.transitions);
  const internalTransitions = useReportsStore((s) => s.internalTransitions);
  const requiresSubtasks = useOrgsStore((s) => s.currentOrg()?.doneNeedsSubtasksDone ?? false);
  // Ante la duda, la estricta: proteger de más no rompe nada de nadie, y es lo
  // que contesta un servidor anterior a que existieran las dos.
  const machineFor = (flow?: string) =>
    flow === "internal" && internalTransitions ? internalTransitions : transitions;
  const fetchTransitions = useReportsStore((s) => s.fetchTransitions);
  useEffect(() => {
    fetchTransitions().catch(() => {});
  }, [fetchTransitions]);

  /** De un id de columna al estado que representa, según lo que dijo el servidor. */
  const statusOfColumn = useCallback(
    (id: string): ReportStatus | null => {
      const col = board?.statuses.find((s) => s.id === id);
      return col ? normalizeStatus(col.status) : null;
    },
    [board],
  );
  const loading = useTasksStore((s) => s.loadingBoard);
  const activeListId = useTasksStore((s) => s.activeListId);
  const moveTask = useTasksStore((s) => s.moveTask);
  const createTask = useTasksStore((s) => s.createTask);
  const openTask = useTasksStore((s) => s.openTask);
  const refreshBoard = useTasksStore((s) => s.refreshBoard);
  const openDoc = useTasksStore((s) => s.openDoc);
  const tree = useTasksStore((s) => s.tree);
  const prompt = usePrompt();
  const confirm = useConfirm();

  if (!activeListId) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <p className="text-sm text-muted-foreground">
          {t("work:board.pickAList")}
        </p>
      </div>
    );
  }
  if (loading && !board) {
    return (
      <div className="min-w-0 flex-1">
        <BoardSkeleton label={t("work:tree.loading")} />
      </div>
    );
  }
  if (!board) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2">
        <p className="text-sm text-muted-foreground">{t("work:board.couldNotLoad")}</p>
        <Button size="sm" variant="outline" onClick={() => refreshBoard()}>
          <RefreshCw className="size-3 mr-1" /> Retry
        </Button>
      </div>
    );
  }

  // Does the list this board belongs to reach a client? The tree carries the
  // answer, including a binding inherited from the space above.
  const channelOfList = (() => {
    for (const sp of tree) {
      for (const l of sp.lists) if (l.id === activeListId) return l.projectId ?? sp.projectId;
      for (const f of sp.folders) {
        for (const l of f.lists) if (l.id === activeListId) return l.projectId ?? sp.projectId;
      }
    }
    return undefined;
  })();

  const columns: KanbanColumn[] = board.statuses.map((s) => ({
    id: s.id,
    title: s.name,
    tone: statusTone(s.status),
    action: (
      <button
        className="flex w-full items-center gap-1 rounded px-1 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
        onClick={async () => {
          const title = await prompt({
            title: t("work:board.newTaskTitle"),
            label: t("work:board.newTaskLabel"),
            confirmText: t("work:board.create"),
            description: channelOfList
              ? t("work:board.clientListHint")
              : undefined,
          });
          if (!title) return;
          // In a client's list the choice is asked, never assumed. The server's
          // default is "they see it", which is right — and a default that
          // publishes to a customer is not something to apply silently on their
          // behalf from a screen that didn't mention it.
          let visibility: ItemVisibility | undefined;
          if (channelOfList) {
            const share = await confirm({
              title: t("work:board.clientSeesTitle"),
              description: t("work:board.clientSeesBody"),
              confirmText: t("work:board.visibleToThem"),
              cancelText: t("work:board.internal"),
            });
            visibility = share ? "public" : "internal";
          }
          createTask(title, s.id, visibility).catch((e) => toast.error(String(e)));
        }}
      >
        <Plus className="size-3" /> {t("work:board.addTask")}
      </button>
    ),
  }));

  const visible = board.tasks.filter((c) => matchesFilter(c, filter));
  const items = visible.map((t) => ({ ...t, columnId: t.statusId }));

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      {/* La misma cabecera que la documentación de la lista (`DocTabs`):
          icono, nombre, id y los botones a la derecha, y debajo las cuatro
          pestañas. Pasar de Tablero a Documentación no mueve nada de sitio; la
          cuenta de tareas bajó a la fila de los filtros, que es donde dice
          cuántas se ven. En una sola fila con las pestañas, en una ventana
          normal, el nombre era lo que cedía y quedaba en «t…». */}
      <header className="flex h-12 shrink-0 items-center gap-2 px-4">
        <ListChecks className="size-4 shrink-0 text-muted-foreground" />
        <h1 className="min-w-0 truncate text-sm font-medium">{board.list.name}</h1>
        {/* create_task takes this listId. */}
        <CopyId id={board.list.id} label="list" />
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <Button
            size="icon-xs"
            variant="ghost"
            title={t("work:board.refresh")}
            aria-label={t("work:board.refresh")}
            disabled={loading}
            onClick={() => refreshBoard()}
          >
            <RefreshCw className={cn("size-3.5", loading && "animate-spin")} />
          </Button>
        </div>
      </header>
      <ListToolbar
        views={
          <ViewSwitch
            value={view}
            onChange={(v) =>
              v === "docs" ? openDoc("list", board.list.id, board.list.name) : setView(v)
            }
          />
        }
      />
      <TaskFilters
        cards={board.tasks}
        shown={visible.length}
        value={filter}
        onChange={(f) => setFilterOf({ listId: board.list.id, filter: f })}
      />

      <PinnedLine listId={board.list.id} />

      <div className="min-h-0 flex-1">
        {/* Con el filtro dejándolo todo fuera, dicho una vez en vez de un
            tablero de columnas vacías que parece una lista sin trabajo. */}
        {visible.length === 0 && board.tasks.length > 0 ? (
          <p className="p-6 text-center text-sm text-muted-foreground">{t("work:board.filter.noMatch")}</p>
        ) : view === "board" ? (
          <KanbanBoard
            columns={columns}
            items={items}
            emptyColumnHint={t("work:board.noTasks")}
            onMove={({ itemId, toColumnId, afterId, beforeId }) =>
              moveTask(itemId, toColumnId, afterId, beforeId).catch((e) =>
                toast.error(t("work:board.errMove"), { description: String(e) }),
              )
            }
            renderItem={(item, dragging) => (
              <TaskCardView card={item} dragging={dragging} onOpen={() => openTask(item.id)} />
            )}
            // Aquí las columnas son ids opacos `<lista>/<estado>`, así que el
            // estado se resuelve por `board.statuses` y **no partiendo el id
            // por la barra**: esa forma es una regla del servidor, y copiarla
            // al cliente es cómo se acaba con dos versiones de la misma verdad.
            puedeSoltar={(item, toColumn) => {
              const from = statusOfColumn(item.columnId);
              const to = statusOfColumn(toColumn);
              if (!from || !to) return true;
              // Lo que pide la organización, comprobado antes de dejar soltar:
              // si no, la tarjeta viaja, la rechazan y vuelve sola — que se lee
              // como que la app va mal, no como una regla.
              if (faltanSubtareas(requiresSubtasks, to, item.subtaskCount, item.subtaskDone)) {
                return false;
              }
              // La máquina de **esta** tarjeta. Un tablero mezcla trabajo
              // interno y tickets de un cliente, así que preguntar con una sola
              // para todas obligaba a elegir a quién mentirle: con la estricta,
              // una tarea interna no podía ir de Open a Done; con la otra, el
              // ticket de un cliente saltaría a resuelto sin tocarlo.
              return puedeIr(machineFor(item.flow), from, to);
            }}
          />
        ) : view === "calendar" ? (
          <div className="h-full overflow-auto p-4">
            <ItemCalendar
              countKey="common:count.cards"
              onOpen={openTask}
              items={visible.map((t) => ({
                id: t.id,
                title: t.title,
                at: t.createdAt,
                // Coloured by the column it sits in, so the month reads the same
                // way the board does.
                dotClass: dotForStatus(board.statuses, t.statusId),
                label: `#${t.seq}`,
              }))}
            />
          </div>
        ) : (
          <ListView board={{ ...board, tasks: visible }} onOpen={openTask} />
        )}
      </div>
    </div>
  );
}

// Dense table for scanning a whole list at once — the board is for moving work,
// this is for reading it. Grouped by column so the flow still reads top to
// bottom, and rows carry the fields you'd otherwise have to open a card to see.
function ListView({
  board,
  onOpen,
}: {
  board: NonNullable<ReturnType<typeof useTasksStore.getState>["board"]>;
  onOpen: (id: string) => void;
}) {
  const { t } = useT();
  return (
    <div className="h-full overflow-auto p-4">
      {board.statuses.map((status) => {
        const rows = board.tasks.filter((t) => t.statusId === status.id);
        return (
          <section key={status.id} className="mb-5">
            <div className="mb-1 flex items-center gap-2">
              <span className={cn("size-2 rounded-full", statusTone(status.status).dot)} />
              <h3 className="text-xs font-semibold uppercase tracking-wide">{status.name}</h3>
              <span className={cn("rounded-full px-1.5 text-xs font-medium tabular-nums", statusTone(status.status).chip)}>
                {rows.length}
              </span>
            </div>
            {rows.length === 0 ? (
              <p className="px-1 py-2 text-xs text-muted-foreground">{t("work:board.empty")}</p>
            ) : (
              <div className="divide-y rounded-md border">
                {rows.map((t) => (
                  <button
                    key={t.id}
                    onClick={() => onOpen(t.id)}
                    className="flex w-full items-center gap-3 px-3 py-2 text-left text-sm hover:bg-accent/50"
                  >
                    <span className="w-10 shrink-0 font-mono text-xs text-muted-foreground">
                      #{t.seq}
                    </span>
                    <span className="min-w-0 flex-1 truncate">{t.title}</span>
                    {t.tags.slice(0, 3).map((g) => (
                      <TagChip key={g.id} name={g.name} color={g.color} className="hidden sm:inline-flex" />
                    ))}
                    <PriorityChip priority={t.priority} />
                    {t.dueAt && (
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {fecha(dueDay(t.dueAt))}
                      </span>
                    )}
                    <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
                      <PrChip git={t.git} />
                      {t.commentCount > 0 && (
                        <>
                          <MessageSquare className="size-3" />
                          {t.commentCount}
                        </>
                      )}
                      {t.assignees.slice(0, 2).map((a) => (
                        <Initials
                          key={a.id}
                          colorKey={a.username}
                          title={a.username}
                          text={a.username.slice(0, 2)}
                          className="size-4 text-[9px]"
                        />
                      ))}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}

function TaskCardView({
  card,
  dragging,
  onOpen,
}: {
  card: TaskCard;
  dragging?: boolean;
  onOpen: () => void;
}) {
  const { t } = useT();
  const due = cuando(card.dueAt);
  return (
    <div
      onClick={onOpen}
      className={cn(
        // Se levanta al pasar por encima y se hunde al pulsarla, con muelle:
        // se lee como algo que se coge, no como una fila de una tabla.
        "motion-press rounded-md border bg-raised p-2.5 shadow-sm hover:-translate-y-px hover:border-primary/50 hover:shadow-md",
        dragging && "shadow-lg",
      )}
    >
      <p className="line-clamp-3 text-sm">{card.title}</p>

      {card.tags.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {card.tags.map((t) => (
            <TagChip key={t.id} name={t.name} color={t.color} />
          ))}
        </div>
      )}

      <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
        {card.hasDescription && <FileText className="size-3" />}
        {card.commentCount > 0 && (
          <span className="flex items-center gap-0.5">
            <MessageSquare className="size-3" />
            {card.commentCount}
          </span>
        )}
        {card.attachmentCount > 0 && (
          <span className="flex items-center gap-0.5">
            <Paperclip className="size-3" />
            {card.attachmentCount}
          </span>
        )}
        <PrChip git={card.git} />
        {card.subtaskCount > 0 && (
          <span
            className={cn(
              "flex items-center gap-0.5",
              card.subtaskDone === card.subtaskCount && "text-success",
            )}
            title={t("work:board.subtasksDone")}
          >
            <ListChecks className="size-3" />
            {card.subtaskDone}/{card.subtaskCount}
          </span>
        )}
        <PriorityChip priority={card.priority} />
        {due.texto && <span className={cn("shrink-0", dueClass(due))}>{due.texto}</span>}
        <span className="ml-auto">#{card.seq}</span>
        {card.assignees.length > 0 && (
          <span className="flex items-center gap-0.5">
            {card.assignees.slice(0, 2).map((a) => (
              <Initials
                key={a.id}
                colorKey={a.username}
                title={a.username}
                text={a.username.slice(0, 2)}
                className="size-4 text-[9px]"
              />
            ))}
          </span>
        )}
      </div>
    </div>
  );
}
