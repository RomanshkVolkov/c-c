import { useEffect, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Folder,
  FolderPlus,
  ListChecks,
  Plus,
  MoreHorizontal,
  Pencil,
  Trash2,
  Loader2,
  AlertCircle,
  MessageSquare,
  Paperclip,
  FileText,
  Flag,
  Check,
  ArrowUp,
  ArrowDown,
  RefreshCw,
} from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import KanbanBoard, { type KanbanColumn } from "@/components/kanban/KanbanBoard";
import TaskDetailDrawer from "@/components/TaskDetailDrawer";
import DocView from "@/components/DocView";
import CopyId from "@/components/CopyId";
import { useConfirm } from "@/components/ConfirmDialog";
import { usePrompt } from "@/components/PromptDialog";
import { useTasksStore } from "@/store/tasks.store";
import { useOrgsStore } from "@/store/orgs.store";
import { PRIORITY_META, docKey, type TaskCard } from "@/types/task";
import { cn } from "@/lib/utils";

export default function Tasks() {
  const fetchTree = useTasksStore((s) => s.fetchTree);
  const fetchTags = useTasksStore((s) => s.fetchTags);
  const activeListId = useTasksStore((s) => s.activeListId);
  const refreshBoard = useTasksStore((s) => s.refreshBoard);
  const fetchDocIndex = useTasksStore((s) => s.fetchDocIndex);

  // Re-scope when the org switcher changes: spaces, tags and the open board all
  // belong to one org, so a stale selection has to be dropped, not carried over.
  const currentOrgId = useOrgsStore((s) => s.currentOrgId);
  useEffect(() => {
    fetchTree();
    fetchTags();
    fetchDocIndex();
  }, [currentOrgId, fetchTree, fetchTags, fetchDocIndex]);

  // Restore the persisted list on first mount.
  useEffect(() => {
    if (activeListId) refreshBoard();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A document takes over the right pane: it belongs to a space or folder, which
  // have no board of their own, and for a list it's an alternative view of the
  // same node rather than something to show beside it.
  const activeDoc = useTasksStore((s) => s.activeDoc);

  return (
    <div className="flex-1 flex min-h-0">
      <Navigator />
      {activeDoc ? <DocView /> : <Board />}
      <TaskDetailDrawer />
    </div>
  );
}

// ─── Left navigator: spaces → folders → lists ────────────────────────────────

function Navigator() {
  const tree = useTasksStore((s) => s.tree);
  const loading = useTasksStore((s) => s.loadingTree);
  const error = useTasksStore((s) => s.error);
  const createSpace = useTasksStore((s) => s.createSpace);
  const currentOrgId = useOrgsStore((s) => s.currentOrgId);
  const prompt = usePrompt();

  const addSpace = async () => {
    if (!currentOrgId) {
      toast.error("Pick an organization first");
      return;
    }
    const name = await prompt({ title: "New space", label: "Name", placeholder: "Engineering", confirmText: "Create" });
    if (!name) return;
    try {
      await createSpace(currentOrgId, name);
    } catch (e) {
      toast.error("Could not create space", { description: String(e) });
    }
  };

  return (
    <aside className="flex w-64 shrink-0 flex-col border-r bg-muted/10">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b px-3">
        <span className="text-sm font-medium">Spaces</span>
        <Button size="icon-xs" variant="ghost" className="ml-auto" title="New space" onClick={addSpace}>
          <Plus className="size-3.5" />
        </Button>
      </header>
      <div className="flex-1 overflow-auto py-1">
        {error && (
          <p className="flex items-center gap-1.5 px-3 py-2 text-xs text-destructive">
            <AlertCircle className="size-3" /> {error}
          </p>
        )}
        {loading && tree.length === 0 ? (
          <p className="px-3 py-2 text-xs text-muted-foreground">Loading…</p>
        ) : tree.length === 0 ? (
          <p className="px-3 py-3 text-xs text-muted-foreground">
            No spaces yet. Create one to start organizing work.
          </p>
        ) : (
          tree.map((space) => <SpaceNode key={space.id} space={space} />)
        )}
      </div>
    </aside>
  );
}

function SpaceNode({ space }: { space: ReturnType<typeof useTasksStore.getState>["tree"][number] }) {
  const [open, setOpen] = useState(true);
  const openDoc = useTasksStore((s) => s.openDoc);
  const activeDoc = useTasksStore((s) => s.activeDoc);
  const docIndex = useTasksStore((s) => s.docIndex);
  const confirm = useConfirm();
  const { createFolder, createList, renameSpace, deleteSpace, moveSpace } = useTasksStore.getState();

  const prompt = usePrompt();

  return (
    <div className="mb-0.5">
      <div className="group flex items-center gap-1 px-2 py-1 hover:bg-accent/50">
        <button onClick={() => setOpen((v) => !v)} className="text-muted-foreground">
          {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
        </button>
        <span
          className="size-2 shrink-0 rounded-sm"
          style={{ backgroundColor: space.color || "var(--primary)" }}
        />
        <button
          className={cn(
            "flex-1 truncate text-left text-sm font-medium hover:underline",
            activeDoc?.kind === "space" && activeDoc.id === space.id && "text-primary",
          )}
          title="Open overview"
          onClick={() => openDoc("space", space.id, space.name)}
        >
          {space.name}
        </button>
        {docIndex[docKey("space", space.id)] && (
          <FileText className="size-3 shrink-0 text-muted-foreground" />
        )}
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <button className="text-muted-foreground opacity-0 group-hover:opacity-100" aria-label="Space menu">
                <MoreHorizontal className="size-3.5" />
              </button>
            }
          />
          <DropdownMenuContent align="start">
            <DropdownMenuGroup>
              <DropdownMenuItem
                onClick={async () => {
                  const n = await prompt({ title: "New folder", label: "Name", confirmText: "Create" });
                  if (n) createFolder(space.id, n).catch((e) => toast.error(String(e)));
                }}
              >
                <FolderPlus className="size-4" /> New folder
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={async () => {
                  const n = await prompt({ title: "New list", label: "Name", confirmText: "Create" });
                  if (n) createList(space.id, n).catch((e) => toast.error(String(e)));
                }}
              >
                <ListChecks className="size-4" /> New list
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={async () => {
                  const n = await prompt({ title: "Rename space", label: "Name", defaultValue: space.name });
                  if (n) renameSpace(space.id, n).catch((e) => toast.error(String(e)));
                }}
              >
                <Pencil className="size-4" /> Rename
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => moveSpace(space.id, "up").catch((e) => toast.error(String(e)))}>
                <ArrowUp className="size-4" /> Move up
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => moveSpace(space.id, "down").catch((e) => toast.error(String(e)))}>
                <ArrowDown className="size-4" /> Move down
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={async () => {
                  const ok = await confirm({
                    title: `Delete space "${space.name}"?`,
                    description: "Deletes its folders, lists and every task inside. This can't be undone.",
                    confirmText: "Delete",
                    destructive: true,
                  });
                  if (ok) deleteSpace(space.id).catch((e) => toast.error(String(e)));
                }}
              >
                <Trash2 className="size-4 text-destructive" /> Delete space
              </DropdownMenuItem>
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {open && (
        <div className="ml-4">
          {space.folders.map((folder) => (
            <FolderNode key={folder.id} spaceId={space.id} folder={folder} />
          ))}
          {space.lists.map((list) => (
            <ListNode key={list.id} list={list} />
          ))}
          {space.folders.length === 0 && space.lists.length === 0 && (
            <p className="px-2 py-1 text-[11px] text-muted-foreground">Empty</p>
          )}
        </div>
      )}
    </div>
  );
}

function FolderNode({
  spaceId,
  folder,
}: {
  spaceId: string;
  folder: { id: string; name: string; lists: { id: string; name: string; taskCount: number }[] };
}) {
  const [open, setOpen] = useState(true);
  const confirm = useConfirm();
  const prompt = usePrompt();
  const openDoc = useTasksStore((s) => s.openDoc);
  const activeDoc = useTasksStore((s) => s.activeDoc);
  const docIndex = useTasksStore((s) => s.docIndex);
  const { createList, renameFolder, deleteFolder, moveFolder } = useTasksStore.getState();

  return (
    <div>
      <div className="group flex items-center gap-1 px-2 py-1 hover:bg-accent/50">
        <button onClick={() => setOpen((v) => !v)} className="text-muted-foreground">
          {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
        </button>
        <Folder className="size-3.5 text-muted-foreground" />
        <button
          className={cn(
            "flex-1 truncate text-left text-sm hover:underline",
            activeDoc?.kind === "folder" && activeDoc.id === folder.id && "text-primary",
          )}
          title="Open overview"
          onClick={() => openDoc("folder", folder.id, folder.name)}
        >
          {folder.name}
        </button>
        {docIndex[docKey("folder", folder.id)] && (
          <FileText className="size-3 shrink-0 text-muted-foreground" />
        )}
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <button className="text-muted-foreground opacity-0 group-hover:opacity-100" aria-label="Folder menu">
                <MoreHorizontal className="size-3.5" />
              </button>
            }
          />
          <DropdownMenuContent align="start">
            <DropdownMenuGroup>
              <DropdownMenuItem
                onClick={async () => {
                  const n = await prompt({ title: "New list", label: "Name", confirmText: "Create" });
                  if (n) createList(spaceId, n, folder.id).catch((e) => toast.error(String(e)));
                }}
              >
                <ListChecks className="size-4" /> New list
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={async () => {
                  const n = await prompt({ title: "Rename folder", label: "Name", defaultValue: folder.name });
                  if (n) renameFolder(folder.id, n).catch((e) => toast.error(String(e)));
                }}
              >
                <Pencil className="size-4" /> Rename
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => moveFolder(folder.id, "up").catch((e) => toast.error(String(e)))}>
                <ArrowUp className="size-4" /> Move up
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => moveFolder(folder.id, "down").catch((e) => toast.error(String(e)))}>
                <ArrowDown className="size-4" /> Move down
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={async () => {
                  const ok = await confirm({
                    title: `Delete folder "${folder.name}"?`,
                    description: "Its lists move up to the space — no tasks are deleted.",
                    confirmText: "Delete folder",
                    destructive: true,
                  });
                  if (ok) deleteFolder(folder.id).catch((e) => toast.error(String(e)));
                }}
              >
                <Trash2 className="size-4 text-destructive" /> Delete folder
              </DropdownMenuItem>
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {open && (
        <div className="ml-4">
          {folder.lists.map((l) => (
            <ListNode key={l.id} list={l} />
          ))}
        </div>
      )}
    </div>
  );
}

function ListNode({ list }: { list: { id: string; name: string; taskCount: number } }) {
  const activeListId = useTasksStore((s) => s.activeListId);
  const selectList = useTasksStore((s) => s.selectList);
  const confirm = useConfirm();
  const prompt = usePrompt();
  const docIndex = useTasksStore((s) => s.docIndex);
  const { renameList, deleteList } = useTasksStore.getState();
  const active = activeListId === list.id;

  return (
    <div
      className={cn(
        "group flex cursor-pointer items-center gap-1.5 rounded px-2 py-1 hover:bg-accent/50",
        active && "bg-accent",
      )}
      onClick={() => selectList(list.id)}
    >
      <ListChecks className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="flex-1 truncate text-sm">{list.name}</span>
      {docIndex[docKey("list", list.id)] && (
        <FileText className="size-3 shrink-0 text-muted-foreground" />
      )}
      {list.taskCount > 0 && (
        <span className="text-[11px] text-muted-foreground">{list.taskCount}</span>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <button
              className="text-muted-foreground opacity-0 group-hover:opacity-100"
              aria-label="List menu"
              onClick={(e) => e.stopPropagation()}
            >
              <MoreHorizontal className="size-3.5" />
            </button>
          }
        />
        <DropdownMenuContent align="start">
          <DropdownMenuGroup>
            <DropdownMenuItem
              onClick={async () => {
                const n = await prompt({ title: "Rename list", label: "Name", defaultValue: list.name });
                if (n) renameList(list.id, n).catch((e) => toast.error(String(e)));
              }}
            >
              <Pencil className="size-4" /> Rename
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={async () => {
                const ok = await confirm({
                  title: `Delete list "${list.name}"?`,
                  description: `Deletes its ${list.taskCount} task(s) and columns. This can't be undone.`,
                  confirmText: "Delete list",
                  destructive: true,
                });
                if (ok) deleteList(list.id).catch((e) => toast.error(String(e)));
              }}
            >
              <Trash2 className="size-4 text-destructive" /> Delete list
            </DropdownMenuItem>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

// ─── Board ────────────────────────────────────────────────────────────────────

function Board() {
  // Board vs list is a per-user viewing preference, not shared state — keeping
  // it local means two people can look at the same list differently.
  const [view, setView] = useState<"board" | "list">("board");
  const board = useTasksStore((s) => s.board);
  const loading = useTasksStore((s) => s.loadingBoard);
  const activeListId = useTasksStore((s) => s.activeListId);
  const moveTask = useTasksStore((s) => s.moveTask);
  const createTask = useTasksStore((s) => s.createTask);
  const openTask = useTasksStore((s) => s.openTask);
  const refreshBoard = useTasksStore((s) => s.refreshBoard);
  const openDoc = useTasksStore((s) => s.openDoc);
  const prompt = usePrompt();

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

  const columns: KanbanColumn[] = board.statuses.map((s) => ({
    id: s.id,
    title: s.name,
    color: s.color,
    accessory: <ColumnMenu status={s} statuses={board.statuses} />,
    action: (
      <button
        className="flex w-full items-center gap-1 rounded px-1 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
        onClick={async () => {
          const title = await prompt({ title: "New task", label: "Title", confirmText: "Create" });
          if (title) createTask(title, s.id).catch((e) => toast.error(String(e)));
        }}
      >
        <Plus className="size-3" /> Add task
      </button>
    ),
  }));

  const items = board.tasks.map((t) => ({ ...t, columnId: t.statusId }));

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
        <h1 className="truncate text-sm font-medium">{board.list.name}</h1>
        {/* create_task takes this listId. */}
        <CopyId id={board.list.id} label="list" />
        <Badge variant="secondary" className="text-[10px]">
          {board.tasks.length} tasks
        </Badge>
        <div className="ml-2 flex rounded-md border p-0.5">
          {(["board", "list"] as const).map((v) => (
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
          size="sm"
          variant="ghost"
          className="ml-auto h-7 text-xs"
          onClick={async () => {
            const name = await prompt({ title: "New column", label: "Name", confirmText: "Create" });
            if (!name) return;
            // New columns default to "open": only the user knows whether a column
            // means finished, and `kind` drives the completed-at stamp.
            useTasksStore
              .getState()
              .createStatus(name, "#7D8BA3", "open")
              .catch((e) => toast.error(String(e)));
          }}
        >
          <Plus className="size-3 mr-1" /> Column
        </Button>
        <Button
          size="icon-xs"
          variant="ghost"
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
          />
        ) : (
          <ListView board={board} onOpen={openTask} />
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
                    <span className="w-10 shrink-0 font-mono text-[11px] text-muted-foreground">
                      #{t.seq}
                    </span>
                    <span className="min-w-0 flex-1 truncate">{t.title}</span>
                    {t.tags.slice(0, 3).map((g) => (
                      <span
                        key={g.id}
                        className="hidden rounded px-1.5 py-0.5 text-[10px] sm:inline"
                        style={{ backgroundColor: `${g.color || "#8B5CF6"}22`, color: g.color || undefined }}
                      >
                        {g.name}
                      </span>
                    ))}
                    {t.priority !== "none" && (
                      <span className={cn("shrink-0 text-[11px]", PRIORITY_META[t.priority].className)}>
                        {PRIORITY_META[t.priority].label}
                      </span>
                    )}
                    {t.dueAt && (
                      <span className="shrink-0 text-[11px] text-muted-foreground">
                        {new Date(t.dueAt).toLocaleDateString()}
                      </span>
                    )}
                    <span className="flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground">
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
                          className="inline-flex size-4 items-center justify-center rounded-full bg-primary/20 text-[9px] uppercase text-foreground"
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

// Per-column menu: rename, recolour, set what the column *means* (kind), and
// delete. `kind` is separate from the name on purpose — renaming "Done" to
// "Shipped" must not stop it counting as finished.
function ColumnMenu({
  status,
  statuses,
}: {
  status: { id: string; name: string; color: string; kind: string };
  statuses: { id: string; name: string }[];
}) {
  const confirm = useConfirm();
  const prompt = usePrompt();
  const { updateStatus, deleteStatus } = useTasksStore.getState();

  const KINDS: { value: "open" | "active" | "done"; label: string }[] = [
    { value: "open", label: "Not started" },
    { value: "active", label: "In progress" },
    { value: "done", label: "Completed" },
  ];
  const COLORS = ["#7D8BA3", "#20D9E8", "#8B5CF6", "#34D399", "#FBBF24", "#FB7185", "#38BDF8"];

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <button className="text-muted-foreground hover:text-foreground" aria-label="Column menu">
            <MoreHorizontal className="size-3.5" />
          </button>
        }
      />
      <DropdownMenuContent align="end">
        <DropdownMenuGroup>
          <DropdownMenuItem
            onClick={async () => {
              const n = await prompt({ title: "Rename column", label: "Name", defaultValue: status.name });
              if (n) updateStatus(status.id, n, status.color, status.kind as "open").catch((e) => toast.error(String(e)));
            }}
          >
            <Pencil className="size-4" /> Rename
          </DropdownMenuItem>

          <DropdownMenuLabel className="text-[11px] text-muted-foreground">Means</DropdownMenuLabel>
          {KINDS.map((k) => (
            <DropdownMenuItem
              key={k.value}
              onClick={() =>
                updateStatus(status.id, status.name, status.color, k.value).catch((e) =>
                  toast.error(String(e)),
                )
              }
            >
              {k.label}
              {status.kind === k.value && <Check className="ml-auto size-3.5" />}
            </DropdownMenuItem>
          ))}

          <DropdownMenuLabel className="text-[11px] text-muted-foreground">Colour</DropdownMenuLabel>
          <div className="flex gap-1 px-2 pb-1">
            {COLORS.map((c) => (
              <button
                key={c}
                aria-label={`Colour ${c}`}
                className={cn(
                  "size-4 rounded-full ring-offset-1",
                  status.color === c && "ring-2 ring-ring",
                )}
                style={{ backgroundColor: c }}
                onClick={() =>
                  updateStatus(status.id, status.name, c, status.kind as "open").catch((e) =>
                    toast.error(String(e)),
                  )
                }
              />
            ))}
          </div>

          <DropdownMenuItem
            onClick={async () => {
              const others = statuses.filter((s) => s.id !== status.id);
              if (others.length === 0) {
                toast.error("A list needs at least one column");
                return;
              }
              // Tasks can't be orphaned, so ask where they go before deleting.
              const target = others[0];
              const ok = await confirm({
                title: `Delete column "${status.name}"?`,
                description: `Its tasks move to "${target.name}".`,
                confirmText: "Delete column",
                destructive: true,
              });
              if (ok) deleteStatus(status.id, target.id).catch((e) => toast.error(String(e)));
            }}
          >
            <Trash2 className="size-4 text-destructive" /> Delete column
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
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
  const priority = PRIORITY_META[card.priority];
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
              className="rounded px-1.5 py-0.5 text-[10px]"
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

      <div className="mt-2 flex items-center gap-2 text-[11px] text-muted-foreground">
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
                className="inline-flex size-4 items-center justify-center rounded-full bg-primary/20 text-[9px] uppercase text-foreground"
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
