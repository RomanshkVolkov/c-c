/**
 * The spaces navigator: spaces → folders → lists.
 *
 * Lived inside `pages/Tasks.tsx` until now, which is why the redesign could not
 * put it in the sidebar without dragging the whole board along with it. Moved
 * here unchanged: any difference in behaviour at this point is a mistake in the
 * move, not a decision.
 */
import { hueVar } from "@/lib/person-color";
import { useT } from "@/lib/i18n";
import { createContext, useContext, useEffect, useMemo, useState } from "react";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  pointerWithin,
  useDraggable,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { sortableKeyboardCoordinates } from "@dnd-kit/sortable";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import {
  ChevronDown,
  ChevronRight,
  Folder,
  FolderPlus,
  ListChecks,
  Eye,
  Copy,
  ArrowDownAZ,
  Lock,
  LockOpen,
  FolderInput,
  Plus,
  MoreHorizontal,
  Pencil,
  Trash2,
  FileText,
  ArrowUp,
  ArrowDown,
  AlertCircle,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import ChannelDialog from "@/components/ChannelDialog";
import { useConfirm } from "@/components/ConfirmDialog";
import { useTasksStore, type DropWhere, type TreeNodeRef } from "@/store/tasks.store";
import { useOrgsStore } from "@/store/orgs.store";
import { docsRoute } from "@/lib/doc-mode";
import { docKey, type FolderTree, type SpaceTree } from "@/types/task";
import DropZone from "@/components/dnd/DropZone";
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
} from "@/components/ui/sidebar";
import { cn } from "@/lib/utils";
import InlineName from "@/components/tree/InlineName";
import { useTreeExpansion } from "@/components/sidebar/useTreeExpansion";
import { filterTree, pathTo } from "@/lib/tree-path";

/**
 * Whether reordering is unlocked.
 *
 * Closed by default and deliberately: the tree is mostly something you click,
 * and a click that starts a drag by accident moves somebody's work. The lock
 * makes rearranging a thing you decide to do, and while it is closed there are
 * no drag handles and no drop zones at all — not disabled ones, none.
 */
const Ordering = createContext(false);

/**
 * Las filas que sobreviven al filtro del panel, o `null` sin filtro.
 *
 * Por contexto y no por prop: el árbol es recursivo y cada nodo decide solo
 * si se pinta. Con filtro, una rama con algo dentro se pinta abierta pase lo
 * que pase con lo plegado a mano: esconder la coincidencia bajo un chevrón
 * cerrado es no haberla encontrado.
 */
const Visible = createContext<Set<string> | null>(null);

/**
 * Las ramas abiertas por defecto: el camino hasta lo que se está mirando.
 *
 * Sólo la rama activa, y no todo el árbol como antes (12-oct-2026): con
 * veinte espacios desplegados lo que buscabas quedaba tres pantallas más
 * abajo. Sin nada activo en esta org, `null`, y entonces los espacios van
 * abiertos y las carpetas cerradas, que enseña qué hay sin enseñarlo todo.
 */
const ActivePath = createContext<Set<string> | null>(null);

/** Abierto por defecto, según la regla de arriba. */
function openByDefault(activePath: Set<string> | null, id: string, kind: "space" | "folder"): boolean {
  return activePath ? activePath.has(id) : kind === "space";
}

/** What is in the air, so every row can tell whether it is a legal landing. */
const DraggedNode = createContext<Located | null>(null);

/**
 * Where a node lives, worked out from the tree already on screen.
 *
 * Carries the space too, because crossing spaces is the one move a drag must
 * refuse — that is what "move to another space" is for, and doing it by
 * accident can change which client sees the work. And how many things travel
 * with it, so the drag can say so instead of quietly taking a whole branch.
 */
interface Located extends TreeNodeRef {
  spaceId: string;
  /** Folders and lists underneath. Zero for a list. */
  carries: number;
}

function countDescendants(f: FolderTree): number {
  return (
    f.lists.length +
    (f.folders ?? []).reduce((n, h) => n + 1 + countDescendants(h), 0)
  );
}

function locate(tree: SpaceTree[], id: string): Located | null {
  for (const space of tree) {
    const inFolders = (folders: FolderTree[], parent: string | null): Located | null => {
      for (const f of folders) {
        if (f.id === id) {
          return { id, kind: "folder", parentId: parent, spaceId: space.id, carries: countDescendants(f) };
        }
        for (const l of f.lists) {
          if (l.id === id) {
            return { id, kind: "list", parentId: f.id, spaceId: space.id, carries: 0 };
          }
        }
        const nested = inFolders(f.folders ?? [], f.id);
        if (nested) return nested;
      }
      return null;
    };
    const inSpace = inFolders(space.folders, null);
    if (inSpace) return inSpace;
    for (const l of space.lists) {
      if (l.id === id) {
        return { id, kind: "list", parentId: null, spaceId: space.id, carries: 0 };
      }
    }
  }
  return null;
}

/**
 * A row you can pick up, and the three places you can put one down.
 *
 * `inside` is offered only by folders: a list holds tasks, not other nodes, so
 * a "drop into this list" target would promise something the tree cannot do.
 *
 * When the lock is closed this renders the row untouched — no handle, no zones,
 * no listeners. Reordering that is merely disabled still moves under the
 * pointer and still answers to the keyboard; this simply is not there.
 */
function Reorderable({
  id,
  spaceId,
  canNest,
  children,
}: {
  id: string;
  /** The space this row is in, which is what makes a drop legal or not. */
  spaceId: string;
  canNest: boolean;
  children: React.ReactNode;
}) {
  const rearranging = useContext(Ordering);
  const inFlight = useContext(DraggedNode);
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id });
  if (!rearranging) return <>{children}</>;

  // Landing in another space is refused: it is what "move to another space" is
  // for, and doing it with a drag can change which client sees the work. Drawn
  // in red rather than made inert, because a target that stops responding
  // reads as a broken drag instead of an answer.
  const forbidden = !!inFlight && inFlight.spaceId !== spaceId;

  return (
    <div
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      className={cn(
        "relative cursor-grab",
        // The whole branch dims, not just its top row: a folder takes its
        // contents with it, and dimming only the row it was grabbed by would
        // understate what is about to move.
        isDragging && "opacity-40",
      )}
    >
      <DropZone id={`before:${id}`} className="top-0 h-1/4" line="top" blocked={forbidden} />
      {canNest && (
        <DropZone id={`inside:${id}`} className="inset-y-1/4" nest blocked={forbidden} />
      )}
      <DropZone id={`after:${id}`} className="bottom-0 h-1/4" line="bottom" blocked={forbidden} />
      {children}
    </div>
  );
}

/**
 * "Move to another space", as a submenu of the spaces you could move it to.
 *
 * A submenu rather than a dialog because the answer is always one of a short
 * list you are already looking at. The space it is already in is left out: it
 * is the one choice that does nothing.
 *
 * Dragging across spaces is refused on purpose — the design marks it in red —
 * so this is the only way, and it being deliberate is the point: crossing
 * spaces can change which client sees the work.
 */
function MoveToSpace({ currentSpaceId, onPick }: { currentSpaceId: string; onPick: (id: string) => void }) {
  const { t } = useT();
  const tree = useTasksStore((s) => s.tree);
  // Sin la sala general: no acepta listas ni carpetas, así que ofrecerla como
  // destino sería ofrecer un movimiento que el servidor rechaza.
  const others = tree.filter((s) => s.id !== currentSpaceId && s.kind !== "general");
  if (others.length === 0) return null;
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        <FolderInput className="size-4" /> {t("work:tree.moveToSpace")}
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent>
        {others.map((s) => (
          <DropdownMenuItem key={s.id} onClick={() => onPick(s.id)}>
            <span className="truncate">{s.name}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

/** Reports a failed write and keeps the inline row open with what was typed. */
const reportingFailure = (p: Promise<unknown>) =>
  p.catch((e) => {
    toast.error(String(e));
    throw e;
  });

// ─── Left navigator: spaces → folders → lists ────────────────────────────────

export default function SpacesNavigator({ filter = "" }: { filter?: string } = {}) {
  const { t } = useT();
  const tree = useTasksStore((s) => s.tree);
  /**
   * Sin la sala general: aquí se organiza trabajo, y ella no lo tiene.
   *
   * Se filtra **en la pantalla y no en el store** a propósito. La sala viaja en
   * el árbol como cualquier espacio, que es lo que le permite a `VoiceMini`
   * resolver su nombre y a `Channels` pintarla; recortarla en `fetchTree` la
   * dejaría sin nombre en la barra de la llamada y sin sitio al que volver.
   */
  const workSpaces = tree.filter((s) => s.kind !== "general");
  const loading = useTasksStore((s) => s.loadingTree);
  const error = useTasksStore((s) => s.error);
  const createSpace = useTasksStore((s) => s.createSpace);
  const currentOrgId = useOrgsStore((s) => s.currentOrgId);
  const [addingSpace, setAddingSpace] = useState(false);
  const [rearranging, setRearranging] = useState(false);
  // The palette can ask for a new space without knowing how one is made: it
  // says so in the address and the tree, which does know, opens its own row.
  const [params, setParams] = useSearchParams();
  useEffect(() => {
    if (params.get("newSpace") !== "1") return;
    setAddingSpace(true);
    // Consumed once, or coming back to this screen would reopen it.
    const rest = new URLSearchParams(params);
    rest.delete("newSpace");
    setParams(rest, { replace: true });
  }, [params, setParams]);
  const dropNode = useTasksStore((s) => s.dropNode);
  const sensors = useSensors(
    // Same threshold as the notes tree and the board: under it a pointer-down
    // is a click that opens a list, not the start of a drag.
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const [dragging, setDragging] = useState<Located | null>(null);

  // El árbol, el índice de documentos y lo no leído los pide `useNavData`
  // desde el sidebar, que está siempre montado; aquí sólo se leen. Lo pedía
  // este componente al montarse, y con un panel por módulo dejó de estar en
  // pantalla en Documentación y en Comunicación, que también leen el árbol.

  // Lo que se está mirando: el documento si se lee documentación, si no la
  // lista activa. Su camino es lo que va abierto por defecto, y al cambiar se
  // olvida lo plegado a mano sobre él (`reveal`): una lista abierta desde la
  // paleta no puede quedar escondida bajo un espacio que plegaste ayer.
  const activeListId = useTasksStore((s) => s.activeListId);
  const activeDoc = useTasksStore((s) => s.activeDoc);
  const { pathname } = useLocation();
  const docsScreen = docsRoute(activeDoc, currentOrgId, pathname);
  const activePath = useMemo(() => {
    const target = docsScreen && activeDoc
      ? { kind: activeDoc.kind as "space" | "folder" | "list", id: activeDoc.id }
      : activeListId
        ? { kind: "list" as const, id: activeListId }
        : null;
    const path = target ? pathTo(tree, target) : [];
    return path.length > 0 ? new Set(path) : null;
  }, [tree, activeListId, activeDoc, docsScreen]);
  const expansion = useTreeExpansion("work");
  const activeKey = activePath ? [...activePath].join("/") : "";
  useEffect(() => {
    if (activePath) expansion.reveal([...activePath]);
    // Sólo cuando cambia el camino, no cada vez que se pliega algo.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeKey]);
  const visible = useMemo(() => filterTree(tree, filter), [tree, filter]);
  const shownSpaces = visible ? workSpaces.filter((sp) => visible.has(sp.id)) : workSpaces;

  const addSpace = () => {
    if (!currentOrgId) {
      toast.error(t("work:tree.pickOrg"));
      return;
    }
    setAddingSpace(true);
  };

  return (
    <SidebarGroup>
      <SidebarGroupLabel className="flex items-center">
        {t("nav:panel.spaces")}
        <Button
          size="icon-xs"
          variant="ghost"
          className="ml-auto"
          title={rearranging ? t("work:tree.finishRearranging") : t("work:tree.rearrange")}
          aria-pressed={rearranging}
          onClick={() => setRearranging((v) => !v)}
        >
          {rearranging ? <LockOpen className="size-3.5 text-primary" /> : <Lock className="size-3.5" />}
        </Button>
        <Button size="icon-xs" variant="ghost" title={t("work:tree.newSpace")} onClick={addSpace}>
          <Plus className="size-3.5" />
        </Button>
      </SidebarGroupLabel>
      <SidebarGroupContent>
      <Visible.Provider value={visible}>
      <ActivePath.Provider value={activePath}>
      <Ordering.Provider value={rearranging}>
      <DraggedNode.Provider value={dragging}>
      <DndContext
        sensors={sensors}
        collisionDetection={pointerWithin}
        onDragStart={(e) => setDragging(locate(tree, String(e.active.id)))}
        onDragCancel={() => setDragging(null)}
        onDragEnd={(e) => {
          setDragging(null);
          if (!e.over) return;
          const [where, targetId] = String(e.over.id).split(":");
          const dragged = locate(tree, String(e.active.id));
          const target = locate(tree, targetId);
          if (!dragged || !target || dragged.id === target.id) return;
          // Silently, as the design says: the red zone already said no while
          // the pointer was over it, and a toast afterwards would be telling
          // somebody off for something they were shown they could not do.
          if (dragged.spaceId !== target.spaceId) return;
          dropNode(dragged, target, where as DropWhere).catch((err) =>
            toast.error(t("work:tree.couldNotMove"), { description: String(err) }),
          );
        }}
      >
        {error && (
          <p className="flex items-center gap-1.5 px-3 py-2 text-xs text-destructive">
            <AlertCircle className="size-3" /> {error}
          </p>
        )}
        {loading && tree.length === 0 ? (
          <p className="px-3 py-2 text-xs text-muted-foreground">{t("work:tree.loading")}</p>
        ) : workSpaces.length === 0 ? (
          <p className="px-3 py-3 text-xs text-muted-foreground">
            {t("common:misc.noSpacesYet")}
          </p>
        ) : shownSpaces.length === 0 ? (
          <p className="px-3 py-3 text-xs text-muted-foreground">{t("nav:panel.noMatches")}</p>
        ) : (
          shownSpaces.map((space) => <SpaceNode key={space.id} space={space} />)
        )}
        {addingSpace && currentOrgId && (
          <InlineName
            mode="create"
            placeholder={t("work:tree.newSpace")}
            onSubmit={(name) => reportingFailure(createSpace(currentOrgId, name))}
            onClose={() => setAddingSpace(false)}
          />
        )}
        <DragOverlay dropAnimation={null}>
          {dragging ? (
            <div className="rounded bg-background/95 px-2 py-1 text-xs shadow ring-1 ring-border">
              {dragging.kind === "folder" ? t("work:tree.folder") : t("work:tree.list")}
              {/* What travels with it. A folder that quietly takes eleven other
                  things is worth saying out loud before it lands. */}
              {dragging.carries > 0 && (
                <span className="ml-1 text-muted-foreground">
                  · {t("nav:panel.moving", { count: dragging.carries + 1 })}
                </span>
              )}
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>
      </DraggedNode.Provider>
      </Ordering.Provider>
      </ActivePath.Provider>
      </Visible.Provider>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}

function SpaceNode({ space }: { space: ReturnType<typeof useTasksStore.getState>["tree"][number] }) {
  const { t } = useT();
  const visible = useContext(Visible);
  const activePath = useContext(ActivePath);
  const expansion = useTreeExpansion("work");
  const byDefault = openByDefault(activePath, space.id, "space");
  // Con filtro, abierto: si se pinta es porque algo de dentro casa.
  const open = visible ? true : expansion.isOpen(space.id, byDefault);
  const setOpen = (v: boolean | ((was: boolean) => boolean)) =>
    expansion.set(space.id, typeof v === "function" ? v(open) : v);
  const openDoc = useTasksStore((s) => s.openDoc);
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const activeDoc = useTasksStore((s) => s.activeDoc);
  const docIndex = useTasksStore((s) => s.docIndex);
  const confirm = useConfirm();
  const { createFolder, createList, renameSpace, deleteSpace, moveSpace, sortChildren } =
    useTasksStore.getState();
  const [channelOpen, setChannelOpen] = useState(false);
  const [adding, setAdding] = useState<null | "folder" | "list">(null);
  const [renaming, setRenaming] = useState(false);

  const startAdding = (what: "folder" | "list") => {
    setOpen(true); // or the new row would appear inside a collapsed node
    setAdding(what);
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
          placeholder={t("work:tree.spaceName")}
          onSubmit={(name) => reportingFailure(renameSpace(space.id, name))}
          onClose={() => setRenaming(false)}
        />
      ) : (
      <div className="group flex items-center gap-1 px-2 py-1 hover:bg-accent/50">
        <button
          onClick={() => setOpen((v) => !v)}
          className="text-muted-foreground hover:text-foreground"
          aria-expanded={open}
          aria-label={open ? t("work:tree.collapse", { name: space.name }) : t("work:tree.expand", { name: space.name })}
        >
          {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
        </button>
        <span
          className="size-2 shrink-0 rounded-sm"
          style={{ backgroundColor: space.color || hueVar(space.id) }}
        />
        {/* A bound space is one a client can see into. The list already said so;
            without this the space it hangs under looked like any other. */}
        {space.projectId && (
          <Eye className="size-3 shrink-0 text-primary" aria-label={t("work:tree.clientSeesSpace")} />
        )}
        <button
          className={cn(
            "flex-1 truncate text-left text-sm font-medium hover:underline",
            activeDoc?.kind === "space" && activeDoc.id === space.id && "text-primary",
          )}
          title={t("work:tree.openOverview")}
          onClick={() => {
            void openDoc("space", space.id, space.name).catch(() => {});
            // Sin esto no pasaba nada salvo que ya estuvieras en una pantalla
            // que pinta un documento. En la de Documentación (`/docs`), se
            // queda en ella.
            navigate(pathname.startsWith("/docs") ? "/docs" : "/tasks");
          }}
        >
          {space.name}
        </button>
        {docIndex[docKey("space", space.id)] && (
          <FileText className="size-3 shrink-0 text-muted-foreground" />
        )}
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <button className="text-muted-foreground hover:text-foreground" aria-label={t("work:tree.spaceMenu")}>
                <MoreHorizontal className="size-3.5" />
              </button>
            }
          />
          <DropdownMenuContent align="start">
            <DropdownMenuGroup>
              <DropdownMenuItem
                onClick={async () => {
                  startAdding("folder");
                }}
              >
                <FolderPlus className="size-4" /> {t("work:tree.newFolder")}
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={async () => {
                  startAdding("list");
                }}
              >
                <ListChecks className="size-4" /> {t("work:tree.newList")}
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={async () => {
                  setRenaming(true);
                }}
              >
                <Pencil className="size-4" /> {t("work:tree.rename")}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setChannelOpen(true)}>
                <Eye className="size-4" /> {t("work:tree.channel")}{space.projectId ? "" : "…"}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => moveSpace(space.id, "up").catch((e) => toast.error(String(e)))}>
                <ArrowUp className="size-4" /> {t("work:tree.moveUp")}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => moveSpace(space.id, "down").catch((e) => toast.error(String(e)))}>
                <ArrowDown className="size-4" /> {t("work:tree.moveDown")}
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => sortChildren("space", space.id).catch((e) => toast.error(String(e)))}
              >
                <ArrowDownAZ className="size-4" /> {t("work:tree.sortAZ")}
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={async () => {
                  const ok = await confirm({
                    title: t("work:tree.deleteSpaceTitle", { name: space.name }),
                    description: t("work:tree.deleteSpaceBody"),
                    confirmText: t("work:tree.delete"),
                    destructive: true,
                  });
                  if (ok) deleteSpace(space.id).catch((e) => toast.error(String(e)));
                }}
              >
                <Trash2 className="size-4 text-destructive" /> {t("work:tree.deleteSpace")}
              </DropdownMenuItem>
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      )}

      {open && (
        <div className="ml-4">
          {space.folders.filter((f) => !visible || visible.has(f.id)).map((folder) => (
            <FolderNode
              key={folder.id}
              spaceId={space.id}
              folder={folder}
              spaceName={space.name}
              spaceProjectId={space.projectId}
            />
          ))}
          {space.lists.filter((l) => !visible || visible.has(l.id)).map((list) => (
            <ListNode
              key={list.id}
              list={list}
              spaceId={space.id}
              spaceName={space.name}
              spaceProjectId={space.projectId}
            />
          ))}
          {adding && (
            <InlineName
              mode="create"
              placeholder={adding === "folder" ? t("work:tree.newFolder") : t("work:tree.newList")}
              canNest={adding === "folder"}
              onSubmit={(name, nestUnder) =>
                reportingFailure(
                  adding === "folder"
                    ? createFolder(space.id, name, nestUnder ?? undefined)
                    : createList(space.id, name),
                )
              }
              onClose={() => setAdding(null)}
            />
          )}
          {!adding && space.folders.length === 0 && space.lists.length === 0 && (
            <p className="px-2 py-1 text-xs text-muted-foreground">{t("work:tree.empty")}</p>
          )}
        </div>
      )}
    </div>
  );
}

function FolderNode({
  spaceId,
  folder,
  spaceName,
  spaceProjectId,
  depth,
}: {
  spaceId: string;
  folder: FolderTree;
  /** How deep this folder sits, only so the row can be indented. */
  depth?: number;
  // Passed straight through: a folder can't hold a channel, but the lists inside
  // it still inherit the space's.
  spaceName?: string;
  spaceProjectId?: string;
}) {
  const { t } = useT();
  const visible = useContext(Visible);
  const activePath = useContext(ActivePath);
  const expansion = useTreeExpansion("work");
  const byDefault = openByDefault(activePath, folder.id, "folder");
  const open = visible ? true : expansion.isOpen(folder.id, byDefault);
  const setOpen = (v: boolean | ((was: boolean) => boolean)) =>
    expansion.set(folder.id, typeof v === "function" ? v(open) : v);
  const [adding, setAdding] = useState<null | "folder" | "list">(null);
  const [renaming, setRenaming] = useState(false);

  const startAdding = (what: "folder" | "list") => {
    setOpen(true);
    setAdding(what);
  };
  const confirm = useConfirm();
  const openDoc = useTasksStore((s) => s.openDoc);
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const activeDoc = useTasksStore((s) => s.activeDoc);
  const docIndex = useTasksStore((s) => s.docIndex);
  const {
    createFolder, createList, renameFolder, deleteFolder, moveFolder,
    duplicateFolder, moveFolderToSpace, sortChildren,
  } = useTasksStore.getState();

  return (
    <div>
      {renaming ? (
        <InlineName
          mode="rename"
          defaultValue={folder.name}
          placeholder={t("work:tree.folderName")}
          onSubmit={(name) => reportingFailure(renameFolder(folder.id, name))}
          onClose={() => setRenaming(false)}
        />
      ) : (
      <Reorderable id={folder.id} spaceId={spaceId} canNest>
      <div className="group flex items-center gap-1 px-2 py-1 hover:bg-accent/50">
        <button
          onClick={() => setOpen((v) => !v)}
          className="text-muted-foreground hover:text-foreground"
          aria-expanded={open}
          aria-label={open ? t("work:tree.collapse", { name: folder.name }) : t("work:tree.expand", { name: folder.name })}
        >
          {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
        </button>
        <Folder className="size-3.5 text-muted-foreground" />
        <button
          className={cn(
            "flex-1 truncate text-left text-sm hover:underline",
            activeDoc?.kind === "folder" && activeDoc.id === folder.id && "text-primary",
          )}
          title={t("work:tree.openOverview")}
          onClick={() => {
            void openDoc("folder", folder.id, folder.name).catch(() => {});
            navigate(pathname.startsWith("/docs") ? "/docs" : "/tasks");
          }}
        >
          {folder.name}
        </button>
        {docIndex[docKey("folder", folder.id)] && (
          <FileText className="size-3 shrink-0 text-muted-foreground" />
        )}
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <button className="text-muted-foreground hover:text-foreground" aria-label={t("work:tree.folderMenu")}>
                <MoreHorizontal className="size-3.5" />
              </button>
            }
          />
          <DropdownMenuContent align="start">
            <DropdownMenuGroup>
              <DropdownMenuItem
                onClick={() => {
                  startAdding("folder");
                }}
              >
                <FolderPlus className="size-4" /> {t("work:tree.newFolder")}
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={async () => {
                  startAdding("list");
                }}
              >
                <ListChecks className="size-4" /> {t("work:tree.newList")}
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={async () => {
                  setRenaming(true);
                }}
              >
                <Pencil className="size-4" /> {t("work:tree.rename")}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => moveFolder(folder.id, "up").catch((e) => toast.error(String(e)))}>
                <ArrowUp className="size-4" /> {t("work:tree.moveUp")}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => moveFolder(folder.id, "down").catch((e) => toast.error(String(e)))}>
                <ArrowDown className="size-4" /> {t("work:tree.moveDown")}
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() =>
                  duplicateFolder(folder.id, `${folder.name} copy`).catch((e) => toast.error(String(e)))
                }
              >
                <Copy className="size-4" /> {t("work:tree.duplicate")}
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => sortChildren("folder", folder.id).catch((e) => toast.error(String(e)))}
              >
                <ArrowDownAZ className="size-4" /> {t("work:tree.sortAZ")}
              </DropdownMenuItem>
              <MoveToSpace
                currentSpaceId={spaceId}
                onPick={(target) =>
                  moveFolderToSpace(folder.id, target).catch((e) => toast.error(String(e)))
                }
              />
              <DropdownMenuItem
                onClick={async () => {
                  const ok = await confirm({
                    title: t("work:tree.deleteFolderTitle", { name: folder.name }),
                    description: t("work:tree.deleteFolderBody"),
                    confirmText: t("work:tree.deleteFolder"),
                    destructive: true,
                  });
                  if (ok) deleteFolder(folder.id).catch((e) => toast.error(String(e)));
                }}
              >
                <Trash2 className="size-4 text-destructive" /> {t("work:tree.deleteFolder")}
              </DropdownMenuItem>
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      </Reorderable>
      )}
      {open && (
        <div className="ml-4">
          {folder.folders?.filter((f) => !visible || visible.has(f.id)).map((f) => (
            <FolderNode
              key={f.id}
              spaceId={spaceId}
              folder={f}
              spaceName={spaceName}
              spaceProjectId={spaceProjectId}
              depth={(depth ?? 0) + 1}
            />
          ))}
          {folder.lists.filter((l) => !visible || visible.has(l.id)).map((l) => (
            <ListNode
              key={l.id}
              list={l}
              spaceId={spaceId}
              spaceName={spaceName}
              spaceProjectId={spaceProjectId}
            />
          ))}
          {adding && (
            <InlineName
              mode="create"
              placeholder={adding === "folder" ? t("work:tree.newFolder") : t("work:tree.newList")}
              canNest={adding === "folder"}
              onSubmit={(name, nestUnder) =>
                reportingFailure(
                  adding === "folder"
                    ? createFolder(spaceId, name, nestUnder ?? folder.id)
                    : createList(spaceId, name, folder.id),
                )
              }
              onClose={() => setAdding(null)}
            />
          )}
        </div>
      )}
    </div>
  );
}

function ListNode({
  list,
  spaceId,
  spaceName,
  spaceProjectId,
}: {
  list: { id: string; name: string; taskCount: number; openCount: number; projectId?: string };
  /** Passed down rather than read off the list: the summary the tree gets does
      not carry it, and both callers already know which space they are in. */
  spaceId: string;
  /** Named so an inherited channel can say where it comes from. */
  spaceName?: string;
  spaceProjectId?: string;
}) {
  const { t } = useT();
  const activeListId = useTasksStore((s) => s.activeListId);
  // `selectList` y no sólo marcarla: si `Tasks` ya está montado, su efecto de
  // montaje no vuelve a correr y nadie más pediría el tablero.
  const selectList = useTasksStore((s) => s.selectList);
  const navigate = useNavigate();
  const confirm = useConfirm();
  const docIndex = useTasksStore((s) => s.docIndex);
  const openListDoc = useTasksStore((s) => s.openDoc);
  const activeDoc = useTasksStore((s) => s.activeDoc);
  const currentOrgId = useOrgsStore((s) => s.currentOrgId);
  const { pathname } = useLocation();
  const { renameList, deleteList, moveListToSpace } = useTasksStore.getState();
  const [channelOpen, setChannelOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const docsScreen = docsRoute(activeDoc, currentOrgId, pathname);
  // En documentación, la lista marcada es la del documento abierto: el tablero
  // que recuerda `activeListId` no es lo que se está mirando.
  const active = docsScreen
    ? activeDoc?.kind === "list" && activeDoc.id === list.id
    : activeListId === list.id;
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
        placeholder={t("work:tree.listName")}
        onSubmit={(name) => reportingFailure(renameList(list.id, name))}
        onClose={() => setRenaming(false)}
      />
    ) : (
    <Reorderable id={list.id} spaceId={spaceId} canNest={false}>
    <div
      className={cn(
        "group flex cursor-pointer items-center gap-1.5 rounded px-2 py-1 hover:bg-accent/50",
        active && "bg-accent",
      )}
      onClick={() => {
        // Abre la lista, en la vista que se usó la última vez (tablero, lista
        // o calendario: `boardView`). Hasta el 18-oct-2026 acotaba «Mi
        // trabajo» a la lista, y pulsar una lista llevaba a otra pantalla con
        // otra cabecera, otras pestañas y la lista convertida en un chip: jose
        // no sabía de dónde salía. Lo que es mío dentro de una lista se busca
        // ahora con el filtro de responsable de la propia lista.
        // Salvo que se esté leyendo documentación: entonces se abre la de esta
        // lista y se queda ahí (ver `docsRoute`).
        if (docsScreen) {
          void openListDoc("list", list.id, list.name).catch(() => {});
          navigate(docsScreen);
          return;
        }
        void selectList(list.id).catch(() => {});
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
          aria-label={t("work:tree.clientSeesList")}
        />
      )}
      {docIndex[docKey("list", list.id)] && (
        <FileText className="size-3 shrink-0 text-muted-foreground" />
      )}
      {/* Lo que queda por hacer, no cuántas tareas caben ahí dentro.
          Decía el total y no coincidía con «Mi trabajo», que enseña lo abierto:
          la misma lista contaba 9 en el árbol y 1 en la pantalla de al lado sin
          que nada explicara la diferencia. El total sigue estando, en el
          título, para quien lo busque. */}
      {list.openCount > 0 && (
        <span
          className="text-xs text-muted-foreground"
          title={t("nav:panel.openOfTotal", { open: list.openCount, total: list.taskCount })}
        >
          {list.openCount}
        </span>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <button
              className="text-muted-foreground hover:text-foreground"
              aria-label={t("work:tree.listMenu")}
              onClick={(e) => e.stopPropagation()}
            >
              <MoreHorizontal className="size-3.5" />
            </button>
          }
        />
        <DropdownMenuContent align="start">
          <DropdownMenuGroup>
            {/* Faltaba, y era el sitio obvio: una lista tiene tablero y tiene
                documentación, y sólo una de las dos se podía abrir desde aquí.
                Con `navigate`, porque abrir un documento sólo cambia el estado
                — sin ir a la pantalla que lo pinta no pasa nada visible. */}
            <DropdownMenuItem
              onClick={() => {
                selectList(list.id);
                void openListDoc("list", list.id, list.name).catch(() => {});
                navigate("/tasks");
              }}
            >
              <FileText className="size-4" /> {t("work:tree.openDocs")}
            </DropdownMenuItem>
            {/* Faltaba, y el diálogo llevaba tiempo montado unas líneas más
                abajo sin nada que lo abriera: el canal sólo se podía configurar
                en el espacio, que lo hereda **todo** lo que hay dentro. Quien
                necesitaba que los reportes de un cliente entraran en una lista
                concreta no tenía forma de decirlo.

                Y el nombre importa: «Channel» en cac ya son los canales de
                chat, así que nadie lo buscaba aquí. */}
            <DropdownMenuItem onClick={() => setChannelOpen(true)}>
              <Eye className="size-4" /> {t("work:tree.clientReports")}{channel ? "" : "…"}
            </DropdownMenuItem>
            <MoveToSpace
              currentSpaceId={spaceId}
              onPick={(target) => moveListToSpace(list.id, target).catch((e) => toast.error(String(e)))}
            />
            <DropdownMenuItem
              onClick={async () => {
                setRenaming(true);
              }}
            >
              <Pencil className="size-4" /> {t("work:tree.rename")}
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={async () => {
                const ok = await confirm({
                  title: t("work:tree.deleteListTitle", { name: list.name }),
                  description: t("common:count.deletesTasks", { count: list.taskCount }),
                  confirmText: t("work:tree.deleteList"),
                  destructive: true,
                });
                if (ok) deleteList(list.id).catch((e) => toast.error(String(e)));
              }}
            >
              <Trash2 className="size-4 text-destructive" /> {t("work:tree.deleteList")}
            </DropdownMenuItem>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
    </Reorderable>
    )}
    </>
  );
}
