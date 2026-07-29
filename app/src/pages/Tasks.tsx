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
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import KanbanBoard, { type KanbanColumn } from "@/components/kanban/KanbanBoard";
import TaskDetailDrawer from "@/components/TaskDetailDrawer";
import { useConfirm } from "@/components/ConfirmDialog";
import { useTasksStore } from "@/store/tasks.store";
import { useOrgsStore } from "@/store/orgs.store";
import { PRIORITY_META, type TaskCard } from "@/types/task";
import { cn } from "@/lib/utils";

export default function Tasks() {
  const fetchTree = useTasksStore((s) => s.fetchTree);
  const fetchTags = useTasksStore((s) => s.fetchTags);
  const activeListId = useTasksStore((s) => s.activeListId);
  const refreshBoard = useTasksStore((s) => s.refreshBoard);

  useEffect(() => {
    fetchTree();
    fetchTags();
  }, [fetchTree, fetchTags]);

  // Restore the persisted list on first mount.
  useEffect(() => {
    if (activeListId) refreshBoard();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="flex-1 flex min-h-0">
      <Navigator />
      <Board />
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

  const addSpace = async () => {
    if (!currentOrgId) {
      toast.error("Pick an organization first");
      return;
    }
    const name = window.prompt("Space name:");
    if (!name?.trim()) return;
    try {
      await createSpace(currentOrgId, name.trim());
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
  const confirm = useConfirm();
  const { createFolder, createList, renameSpace, deleteSpace } = useTasksStore.getState();

  const ask = async (label: string, current = "") => {
    const v = window.prompt(label, current);
    return v?.trim() || null;
  };

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
        <span className="flex-1 truncate text-sm font-medium">{space.name}</span>
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
                  const n = await ask("Folder name:");
                  if (n) createFolder(space.id, n).catch((e) => toast.error(String(e)));
                }}
              >
                <FolderPlus className="size-4" /> New folder
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={async () => {
                  const n = await ask("List name:");
                  if (n) createList(space.id, n).catch((e) => toast.error(String(e)));
                }}
              >
                <ListChecks className="size-4" /> New list
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={async () => {
                  const n = await ask("Rename space:", space.name);
                  if (n) renameSpace(space.id, n).catch((e) => toast.error(String(e)));
                }}
              >
                <Pencil className="size-4" /> Rename
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
  const { createList, renameFolder, deleteFolder } = useTasksStore.getState();

  return (
    <div>
      <div className="group flex items-center gap-1 px-2 py-1 hover:bg-accent/50">
        <button onClick={() => setOpen((v) => !v)} className="text-muted-foreground">
          {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
        </button>
        <Folder className="size-3.5 text-muted-foreground" />
        <span className="flex-1 truncate text-sm">{folder.name}</span>
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
                onClick={() => {
                  const n = window.prompt("List name:")?.trim();
                  if (n) createList(spaceId, n, folder.id).catch((e) => toast.error(String(e)));
                }}
              >
                <ListChecks className="size-4" /> New list
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => {
                  const n = window.prompt("Rename folder:", folder.name)?.trim();
                  if (n) renameFolder(folder.id, n).catch((e) => toast.error(String(e)));
                }}
              >
                <Pencil className="size-4" /> Rename
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
              onClick={() => {
                const n = window.prompt("Rename list:", list.name)?.trim();
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
  const board = useTasksStore((s) => s.board);
  const loading = useTasksStore((s) => s.loadingBoard);
  const activeListId = useTasksStore((s) => s.activeListId);
  const moveTask = useTasksStore((s) => s.moveTask);
  const createTask = useTasksStore((s) => s.createTask);
  const openTask = useTasksStore((s) => s.openTask);
  const refreshBoard = useTasksStore((s) => s.refreshBoard);

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
    footer: (
      <button
        className="flex w-full items-center gap-1 rounded px-1 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
        onClick={() => {
          const title = window.prompt("Task title:")?.trim();
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
        <Badge variant="secondary" className="text-[10px]">
          {board.tasks.length} tasks
        </Badge>
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
      </div>
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
  const priority = PRIORITY_META[card.priority];
  return (
    <div
      onClick={onOpen}
      className={cn(
        "cursor-pointer rounded-md border bg-card p-2.5 shadow-sm transition-colors hover:border-primary/50",
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
