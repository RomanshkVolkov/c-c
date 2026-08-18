/**
 * The spaces navigator: spaces → folders → lists.
 *
 * Lived inside `pages/Tasks.tsx` until now, which is why the redesign could not
 * put it in the sidebar without dragging the whole board along with it. Moved
 * here unchanged: any difference in behaviour at this point is a mistake in the
 * move, not a decision.
 */
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  ChevronDown,
  ChevronRight,
  Folder,
  FolderPlus,
  ListChecks,
  Eye,
  Plus,
  MoreHorizontal,
  Pencil,
  Trash2,
  FileText,
  ArrowUp,
  ArrowDown,
  AlertCircle,
  MessageSquare,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import ChannelDialog from "@/components/ChannelDialog";
import { useConfirm } from "@/components/ConfirmDialog";
import { useTasksStore } from "@/store/tasks.store";
import { useChatStore } from "@/store/chat.store";
import { useOrgsStore } from "@/store/orgs.store";
import { docKey } from "@/types/task";
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
} from "@/components/ui/sidebar";
import { cn } from "@/lib/utils";
import InlineName from "@/components/tree/InlineName";

/** Reports a failed write and keeps the inline row open with what was typed. */
const avisando = (p: Promise<unknown>) =>
  p.catch((e) => {
    toast.error(String(e));
    throw e;
  });

// ─── Left navigator: spaces → folders → lists ────────────────────────────────

export default function SpacesNavigator() {
  const tree = useTasksStore((s) => s.tree);
  const loading = useTasksStore((s) => s.loadingTree);
  const error = useTasksStore((s) => s.error);
  const createSpace = useTasksStore((s) => s.createSpace);
  const currentOrgId = useOrgsStore((s) => s.currentOrgId);
  const [addingSpace, setAddingSpace] = useState(false);

  // Asked for here rather than by the Tasks screen, which is where it used to
  // live. Now that the tree is in the global sidebar it is on screen from the
  // moment you sign in, and a tree that only loads once you visit Tasks would
  // simply look empty everywhere else. Re-asked when the org changes: spaces
  // belong to one organization and a stale one is somebody else's work.
  const fetchTree = useTasksStore((s) => s.fetchTree);
  const fetchDocIndex = useTasksStore((s) => s.fetchDocIndex);
  const fetchUnread = useChatStore((s) => s.fetchUnread);
  useEffect(() => {
    fetchTree();
    fetchDocIndex();
    fetchUnread().catch(() => {});
  }, [currentOrgId, fetchTree, fetchDocIndex, fetchUnread]);

  const addSpace = () => {
    if (!currentOrgId) {
      toast.error("Pick an organization first");
      return;
    }
    setAddingSpace(true);
  };

  return (
    <SidebarGroup>
      <SidebarGroupLabel className="flex items-center">
        Spaces
        <Button
          size="icon-xs"
          variant="ghost"
          className="ml-auto"
          title="New space"
          onClick={addSpace}
        >
          <Plus className="size-3.5" />
        </Button>
      </SidebarGroupLabel>
      <SidebarGroupContent>
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
        {addingSpace && currentOrgId && (
          <InlineName
            mode="create"
            placeholder="New space"
            onSubmit={(name) => avisando(createSpace(currentOrgId, name))}
            onClose={() => setAddingSpace(false)}
          />
        )}
      </SidebarGroupContent>
    </SidebarGroup>
  );
}

function SpaceNode({ space }: { space: ReturnType<typeof useTasksStore.getState>["tree"][number] }) {
  const [open, setOpen] = useState(true);
  const openDoc = useTasksStore((s) => s.openDoc);
  const activeDoc = useTasksStore((s) => s.activeDoc);
  const docIndex = useTasksStore((s) => s.docIndex);
  const confirm = useConfirm();
  const { createFolder, createList, renameSpace, deleteSpace, moveSpace } = useTasksStore.getState();
  const [channelOpen, setChannelOpen] = useState(false);
  const [adding, setAdding] = useState<null | "folder" | "list">(null);
  const [renaming, setRenaming] = useState(false);

  const empezarA = (que: "folder" | "list") => {
    setOpen(true); // or the new row would appear inside a collapsed node
    setAdding(que);
  };

  return (
    <div className="mb-0.5">
      <ChannelDialog
        kind="space"
        id={space.id}
        name={space.name}
        open={channelOpen}
        onOpenChange={setChannelOpen}
      />
      {renaming ? (
        <InlineName
          mode="rename"
          defaultValue={space.name}
          placeholder="Space name"
          onSubmit={(name) => avisando(renameSpace(space.id, name))}
          onClose={() => setRenaming(false)}
        />
      ) : (
      <div className="group flex items-center gap-1 px-2 py-1 hover:bg-accent/50">
        <button
          onClick={() => setOpen((v) => !v)}
          className="text-muted-foreground hover:text-foreground"
          aria-expanded={open}
          aria-label={`${open ? "Collapse" : "Expand"} ${space.name}`}
        >
          {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
        </button>
        <span
          className="size-2 shrink-0 rounded-sm"
          style={{ backgroundColor: space.color || "var(--primary)" }}
        />
        {/* A bound space is one a client can see into. The list already said so;
            without this the space it hangs under looked like any other. */}
        {space.projectId && (
          <Eye className="size-3 shrink-0 text-primary" aria-label="A client can see this space" />
        )}
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
        <SpaceChatButton spaceId={space.id} spaceName={space.name} />
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <button className="text-muted-foreground hover:text-foreground" aria-label="Space menu">
                <MoreHorizontal className="size-3.5" />
              </button>
            }
          />
          <DropdownMenuContent align="start">
            <DropdownMenuGroup>
              <DropdownMenuItem
                onClick={async () => {
                  empezarA("folder");
                }}
              >
                <FolderPlus className="size-4" /> New folder
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={async () => {
                  empezarA("list");
                }}
              >
                <ListChecks className="size-4" /> New list
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={async () => {
                  setRenaming(true);
                }}
              >
                <Pencil className="size-4" /> Rename
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setChannelOpen(true)}>
                <Eye className="size-4" /> Channel{space.projectId ? "" : "…"}
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
      )}

      {open && (
        <div className="ml-4">
          {space.folders.map((folder) => (
            <FolderNode
              key={folder.id}
              spaceId={space.id}
              folder={folder}
              spaceName={space.name}
              spaceProjectId={space.projectId}
            />
          ))}
          {space.lists.map((list) => (
            <ListNode
              key={list.id}
              list={list}
              spaceName={space.name}
              spaceProjectId={space.projectId}
            />
          ))}
          {adding && (
            <InlineName
              mode="create"
              placeholder={adding === "folder" ? "New folder" : "New list"}
              onSubmit={(name) =>
                avisando(adding === "folder" ? createFolder(space.id, name) : createList(space.id, name))
              }
              onClose={() => setAdding(null)}
            />
          )}
          {!adding && space.folders.length === 0 && space.lists.length === 0 && (
            <p className="px-2 py-1 text-xs text-muted-foreground">Empty</p>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The space's channel: one button, no creating and no joining.
 *
 * The badge stays visible when there's something unread — unlike the menu
 * button, which only appears on hover. A count you have to hover to discover is
 * not a notification.
 */
function SpaceChatButton({ spaceId, spaceName }: { spaceId: string; spaceName: string }) {
  const unread = useChatStore((s) => s.unreadBySpace[spaceId] ?? 0);
  const openPanel = useChatStore((s) => s.openPanel);
  const panelOpen = useChatStore((s) => s.panelOpen);
  const openSpaceId = useChatStore((s) => s.spaceId);
  const closePanel = useChatStore((s) => s.closePanel);
  const showing = panelOpen && openSpaceId === spaceId;

  return (
    <button
      className={cn(
        "flex shrink-0 items-center gap-1 text-muted-foreground hover:text-foreground",
        // Clicking the space you're already reading closes it, so the same
        // button is the way back out.
        showing && "text-primary opacity-100",
        unread === 0 && !showing && "text-muted-foreground/60 hover:text-foreground",
      )}
      aria-label={`Chat in ${spaceName}`}
      title={`#${spaceName} — team channel`}
      onClick={(e) => {
        // The row opens the space's overview; this is a different destination.
        e.stopPropagation();
        if (showing) {
          closePanel();
          return;
        }
        openPanel(spaceId).catch((err) => toast.error(String(err)));
      }}
    >
      <MessageSquare className="size-3.5" />
      {unread > 0 && (
        <span className="rounded-full bg-primary px-1 text-[10px] font-medium leading-4 text-primary-foreground">
          {unread > 99 ? "99+" : unread}
        </span>
      )}
    </button>
  );
}

function FolderNode({
  spaceId,
  folder,
  spaceName,
  spaceProjectId,
}: {
  spaceId: string;
  folder: {
    id: string;
    name: string;
    lists: { id: string; name: string; taskCount: number; projectId?: string }[];
  };
  // Passed straight through: a folder can't hold a channel, but the lists inside
  // it still inherit the space's.
  spaceName?: string;
  spaceProjectId?: string;
}) {
  const [open, setOpen] = useState(true);
  const [addingList, setAddingList] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const confirm = useConfirm();
  const openDoc = useTasksStore((s) => s.openDoc);
  const activeDoc = useTasksStore((s) => s.activeDoc);
  const docIndex = useTasksStore((s) => s.docIndex);
  const { createList, renameFolder, deleteFolder, moveFolder } = useTasksStore.getState();

  return (
    <div>
      {renaming ? (
        <InlineName
          mode="rename"
          defaultValue={folder.name}
          placeholder="Folder name"
          onSubmit={(name) => avisando(renameFolder(folder.id, name))}
          onClose={() => setRenaming(false)}
        />
      ) : (
      <div className="group flex items-center gap-1 px-2 py-1 hover:bg-accent/50">
        <button
          onClick={() => setOpen((v) => !v)}
          className="text-muted-foreground hover:text-foreground"
          aria-expanded={open}
          aria-label={`${open ? "Collapse" : "Expand"} ${folder.name}`}
        >
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
              <button className="text-muted-foreground hover:text-foreground" aria-label="Folder menu">
                <MoreHorizontal className="size-3.5" />
              </button>
            }
          />
          <DropdownMenuContent align="start">
            <DropdownMenuGroup>
              <DropdownMenuItem
                onClick={async () => {
                  setOpen(true);
                  setAddingList(true);
                }}
              >
                <ListChecks className="size-4" /> New list
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={async () => {
                  setRenaming(true);
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
      )}
      {open && (
        <div className="ml-4">
          {folder.lists.map((l) => (
            <ListNode key={l.id} list={l} spaceName={spaceName} spaceProjectId={spaceProjectId} />
          ))}
          {addingList && (
            <InlineName
              mode="create"
              placeholder="New list"
              onSubmit={(name) => avisando(createList(spaceId, name, folder.id))}
              onClose={() => setAddingList(false)}
            />
          )}
        </div>
      )}
    </div>
  );
}

function ListNode({
  list,
  spaceName,
  spaceProjectId,
}: {
  list: { id: string; name: string; taskCount: number; projectId?: string };
  /** Named so an inherited channel can say where it comes from. */
  spaceName?: string;
  spaceProjectId?: string;
}) {
  const activeListId = useTasksStore((s) => s.activeListId);
  const selectList = useTasksStore((s) => s.selectList);
  const navigate = useNavigate();
  const confirm = useConfirm();
  const docIndex = useTasksStore((s) => s.docIndex);
  const { renameList, deleteList } = useTasksStore.getState();
  const [channelOpen, setChannelOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const active = activeListId === list.id;
  // Its own binding, or the space's. The eye means "a client sees this" either
  // way — where it was configured is a detail for the dialog, not the tree.
  const channel = list.projectId ?? spaceProjectId;

  return (
    <>
      <ChannelDialog
        kind="list"
        id={list.id}
        name={list.name}
        // Only when the channel isn't the list's own: that's what makes
        // "inherited from X" true rather than decorative.
        inheritedFrom={!list.projectId && spaceProjectId ? spaceName : undefined}
        open={channelOpen}
        onOpenChange={setChannelOpen}
      />
    {renaming ? (
      <InlineName
        mode="rename"
        defaultValue={list.name}
        placeholder="List name"
        onSubmit={(name) => avisando(renameList(list.id, name))}
        onClose={() => setRenaming(false)}
      />
    ) : (
    <div
      className={cn(
        "group flex cursor-pointer items-center gap-1.5 rounded px-2 py-1 hover:bg-accent/50",
        active && "bg-accent",
      )}
      onClick={() => {
        selectList(list.id);
        // The tree is in the global sidebar now, so this can be clicked from
        // Notes or Diagnostics. Changing the board of a screen nobody is
        // looking at is not what "open this list" means.
        navigate("/tasks");
      }}
    >
      <ListChecks className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="flex-1 truncate text-sm">{list.name}</span>
      {/* Work raised here is visible to a client unless someone says otherwise.
          That has to be legible from the tree: it is the difference between a
          note to the team and a message to the customer. */}
      {channel && (
        <Eye
          className="size-3 shrink-0 text-primary"
          aria-label="A client can see this list"
        />
      )}
      {docIndex[docKey("list", list.id)] && (
        <FileText className="size-3 shrink-0 text-muted-foreground" />
      )}
      {list.taskCount > 0 && (
        <span className="text-xs text-muted-foreground">{list.taskCount}</span>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <button
              className="text-muted-foreground hover:text-foreground"
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
                setRenaming(true);
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
    )}
    </>
  );
}
