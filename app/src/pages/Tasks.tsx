import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  ListChecks,
  Plus,
  Loader2,
  MessageSquare,
  Paperclip,
  FileText,
  Flag,
  RefreshCw,
} from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import KanbanBoard, { type KanbanColumn } from "@/components/kanban/KanbanBoard";
import DocView from "@/components/DocView";
import CopyId from "@/components/CopyId";
import ItemCalendar from "@/components/ItemCalendar";
import { useConfirm } from "@/components/ConfirmDialog";
import { usePrompt } from "@/components/PromptDialog";
import { useTasksStore } from "@/store/tasks.store";
import { useOrgsStore } from "@/store/orgs.store";
import { useReportsStore } from "@/store/reports.store";
import { normalizeStatus, puedeIr, type ReportStatus } from "@/types/report";
import { priorityMeta, type ItemVisibility, type TaskCard } from "@/types/task";
import { cn } from "@/lib/utils";

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
    openTask(id).catch(() => {});
  }, [params, setParams, openTask]);

  // A document takes over the right pane: it belongs to a space or folder, which
  // have no board of their own, and for a list it's an alternative view of the
  // same node rather than something to show beside it.
  const activeDoc = useTasksStore((s) => s.activeDoc);


  return (
    <div className="flex-1 flex min-h-0">
      {activeDoc ? <DocView /> : <Board />}
    </div>
  );
}


/**
 * A filter over the report taxonomy, shown only when the cards carry one.
 *
 * Work raised inside cac has no category or area — nobody classifies it that
 * way — so on an ordinary list these render nothing rather than two empty
 * dropdowns that never do anything.
 */
function TaxonomyPicker({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: string[];
  onChange: (v: string) => void;
}) {
  if (options.length === 0) return null;
  return (
    <select
      className="h-7 rounded-md border bg-background px-1.5 text-xs capitalize"
      value={value}
      onChange={(e) => onChange(e.target.value)}
    >
      <option value="">{label}</option>
      {options.map((o) => (
        <option key={o} value={o}>
          {o}
        </option>
      ))}
    </select>
  );
}

/** The colour of the column a card sits in, so the calendar reads like the board. */
function dotForStatus(
  statuses: { id: string; color: string }[],
  statusId: string,
): string {
  const found = statuses.find((s) => s.id === statusId);
  // A bare class name can't carry an arbitrary hex, and the column colours are
  // user-chosen, so this maps to the two states the month view actually needs
  // to distinguish at a glance.
  return found ? "bg-primary" : "bg-muted-foreground/40";
}

// ─── Board ────────────────────────────────────────────────────────────────────

function Board() {
  // Board vs list is a per-user viewing preference, not shared state — keeping
  // it local means two people can look at the same list differently.
  const [view, setView] = useState<"board" | "list" | "calendar">("board");
  // The report taxonomy, as a filter over the cards already on screen. Client
  // work carries it and internal work doesn't, so the controls only appear when
  // there is something to filter by — an always-visible pair of empty selects
  // on a plain board would be furniture.
  const [category, setCategory] = useState("");
  const [area, setArea] = useState("");
  const board = useTasksStore((s) => s.board);

  // La máquina de estados del servidor, para no ofrecer destinos imposibles.
  const transiciones = useReportsStore((s) => s.transitions);
  const fetchTransitions = useReportsStore((s) => s.fetchTransitions);
  useEffect(() => {
    fetchTransitions().catch(() => {});
  }, [fetchTransitions]);

  /** De un id de columna al estado que representa, según lo que dijo el servidor. */
  const estadoDeColumna = useCallback(
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
          Pick a list on the left, or create one to get started.
        </p>
      </div>
    );
  }
  if (loading && !board) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
        <Loader2 className="mr-2 size-4 animate-spin" /> Loading board…
      </div>
    );
  }
  if (!board) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2">
        <p className="text-sm text-muted-foreground">Could not load this board.</p>
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
    color: s.color,
    action: (
      <button
        className="flex w-full items-center gap-1 rounded px-1 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
        onClick={async () => {
          const title = await prompt({
            title: "New task",
            label: "Title",
            confirmText: "Create",
            description: channelOfList
              ? "This list belongs to a client. You'll choose next whether they see it."
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
              title: "Can the client see this?",
              description:
                "Visible puts it on their board and takes one of their ticket numbers — permanently, " +
                "even if you withdraw it later. Internal keeps it to the team.",
              confirmText: "Visible to them",
              cancelText: "Internal",
            });
            visibility = share ? "public" : "internal";
          }
          createTask(title, s.id, visibility).catch((e) => toast.error(String(e)));
        }}
      >
        <Plus className="size-3" /> Add task
      </button>
    ),
  }));

  const categories = [...new Set(board.tasks.map((t) => t.category).filter(Boolean))] as string[];
  const areas = [...new Set(board.tasks.map((t) => t.area).filter(Boolean))] as string[];
  const visible = board.tasks.filter(
    (t) => (!category || t.category === category) && (!area || t.area === area),
  );
  const items = visible.map((t) => ({ ...t, columnId: t.statusId }));

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
        <h1 className="truncate text-sm font-medium">{board.list.name}</h1>
        {/* create_task takes this listId. */}
        <CopyId id={board.list.id} label="list" />
        <Badge variant="secondary" className="text-xs">
          {board.tasks.length} tasks
        </Badge>
        <div className="ml-2 flex rounded-md border p-0.5">
          {(["board", "list", "calendar"] as const).map((v) => (
            <button
              key={v}
              onClick={() => setView(v)}
              className={cn(
                "rounded px-2 py-0.5 text-xs capitalize",
                view === v ? "bg-accent text-foreground" : "text-muted-foreground",
              )}
            >
              {v}
            </button>
          ))}
        </div>
        <TaxonomyPicker label="Any kind" value={category} options={categories} onChange={setCategory} />
        <TaxonomyPicker label="Any area" value={area} options={areas} onChange={setArea} />
        <Button
          size="sm"
          variant="ghost"
          className="h-7 text-xs"
          title="This list's overview"
          onClick={() => openDoc("list", board.list.id, board.list.name)}
        >
          <FileText className="mr-1 size-3" /> Overview
        </Button>
        <Button
          size="icon-xs"
          variant="ghost"
          className="ml-auto"
          title="Refresh"
          disabled={loading}
          onClick={() => refreshBoard()}
        >
          <RefreshCw className={cn("size-3", loading && "animate-spin")} />
        </Button>
      </header>

      <div className="min-h-0 flex-1">
        {view === "board" ? (
          <KanbanBoard
            columns={columns}
            items={items}
            emptyColumnHint="No tasks"
            onMove={({ itemId, toColumnId, afterId, beforeId }) =>
              moveTask(itemId, toColumnId, afterId, beforeId).catch((e) =>
                toast.error("Could not move task", { description: String(e) }),
              )
            }
            renderItem={(item, dragging) => (
              <TaskCardView card={item} dragging={dragging} onOpen={() => openTask(item.id)} />
            )}
            // Aquí las columnas son ids opacos `<lista>/<estado>`, así que el
            // estado se resuelve por `board.statuses` y **no partiendo el id
            // por la barra**: esa forma es una regla del servidor, y copiarla
            // al cliente es cómo se acaba con dos versiones de la misma verdad.
            puedeSoltar={(item, aColumna) => {
              const de = estadoDeColumna(item.columnId);
              const a = estadoDeColumna(aColumna);
              if (!de || !a) return true;
              return puedeIr(transiciones, de, a);
            }}
          />
        ) : view === "calendar" ? (
          <div className="h-full overflow-auto p-4">
            <ItemCalendar
              noun="card"
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
  return (
    <div className="h-full overflow-auto p-4">
      {board.statuses.map((status) => {
        const rows = board.tasks.filter((t) => t.statusId === status.id);
        return (
          <section key={status.id} className="mb-5">
            <div className="mb-1 flex items-center gap-2">
              <span className="size-2 rounded-full" style={{ backgroundColor: status.color }} />
              <h3 className="text-xs font-semibold uppercase tracking-wide">{status.name}</h3>
              <span className="text-xs text-muted-foreground">{rows.length}</span>
            </div>
            {rows.length === 0 ? (
              <p className="px-1 py-2 text-xs text-muted-foreground">Empty</p>
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
                      <span
                        key={g.id}
                        className="hidden rounded px-1.5 py-0.5 text-xs sm:inline"
                        style={{ backgroundColor: `${g.color || "#8B5CF6"}22`, color: g.color || undefined }}
                      >
                        {g.name}
                      </span>
                    ))}
                    {t.priority !== "none" && (
                      <span className={cn("shrink-0 text-xs", priorityMeta(t.priority).className)}>
                        {priorityMeta(t.priority).label}
                      </span>
                    )}
                    {t.dueAt && (
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {new Date(t.dueAt).toLocaleDateString()}
                      </span>
                    )}
                    <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
                      {t.commentCount > 0 && (
                        <>
                          <MessageSquare className="size-3" />
                          {t.commentCount}
                        </>
                      )}
                      {t.assignees.slice(0, 2).map((a) => (
                        <span
                          key={a.id}
                          title={a.username}
                          className="inline-flex size-4 items-center justify-center rounded-full bg-primary/20 text-xs uppercase text-foreground"
                        >
                          {a.username.slice(0, 2)}
                        </span>
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
  const priority = priorityMeta(card.priority);
  return (
    <div
      onClick={onOpen}
      className={cn(
        "rounded-md border bg-card p-2.5 shadow-sm transition-colors hover:border-primary/50",
        dragging && "shadow-lg",
      )}
    >
      <p className="line-clamp-3 text-sm">{card.title}</p>

      {card.tags.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {card.tags.map((t) => (
            <span
              key={t.id}
              className="rounded px-1.5 py-0.5 text-xs"
              style={{
                backgroundColor: `${t.color || "#8B5CF6"}22`,
                color: t.color || "var(--foreground)",
              }}
            >
              {t.name}
            </span>
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
        {card.subtaskCount > 0 && (
          <span
            className={cn(
              "flex items-center gap-0.5",
              card.subtaskDone === card.subtaskCount && "text-success",
            )}
            title="Subtasks completed"
          >
            <ListChecks className="size-3" />
            {card.subtaskDone}/{card.subtaskCount}
          </span>
        )}
        {card.priority !== "none" && (
          <span className={cn("flex items-center gap-0.5", priority.className)}>
            <Flag className="size-3" />
            {priority.label}
          </span>
        )}
        <span className="ml-auto">#{card.seq}</span>
        {card.assignees.length > 0 && (
          <span className="flex items-center gap-0.5">
            {card.assignees.slice(0, 2).map((a) => (
              <span
                key={a.id}
                title={a.username}
                className="inline-flex size-4 items-center justify-center rounded-full bg-primary/20 text-xs uppercase text-foreground"
              >
                {a.username.slice(0, 2)}
              </span>
            ))}
          </span>
        )}
      </div>
    </div>
  );
}
