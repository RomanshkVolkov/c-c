import { useEffect, useState } from "react";
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
import {
  ChevronDown,
  ChevronRight,
  FileText,
  FolderInput,
  Home,
  MoreHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";

import DropZone from "@/components/dnd/DropZone";
import DocPageTrash from "@/components/docs/DocPageTrash";
import MovePageDialog from "@/components/docs/MovePageDialog";
import { useTrashPage } from "@/components/docs/use-trash-page";
import { usePrompt } from "@/components/PromptDialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { childrenOf, descendantsOf, useDocPages } from "@/store/doc-pages.store";
import type { DropWhere } from "@/store/tasks.store";
import type { DocOwnerKind, DocPageTreeItem } from "@/types/task";

/**
 * El árbol de páginas de un documento, en el lateral, como el de Confluence.
 *
 * Arriba, la **portada** (las cuatro pestañas de siempre); debajo, las páginas
 * que cuelgan de ella, anidadas sin límite. El «+» de cada fila crea una página
 * dentro de esa fila —lo que hace Confluence: la página nueva es hija de la que
 * estás mirando—, y la página se abre ya, con el título para escribir.
 *
 * Se reordena arrastrando, con las tres zonas de Notas en cada fila (encima,
 * dentro, debajo), y también desde el menú con «Mover a…»: arrastrar en un
 * árbol largo es fallar a la tercera, y con teclado no se puede.
 */
export default function DocPageTree({ kind, ownerId }: { kind: DocOwnerKind; ownerId: string }) {
  const { t } = useT();
  const tree = useDocPages((s) => s.tree);
  const activePageId = useDocPages((s) => s.activePageId);
  const closePage = useDocPages((s) => s.closePage);
  const createPage = useDocPages((s) => s.createPage);
  const dropPage = useDocPages((s) => s.dropPage);
  const [dragging, setDragging] = useState<string | null>(null);
  const [moviendo, setMoviendo] = useState<DocPageTreeItem | null>(null);
  const [papelera, setPapelera] = useState(false);
  const treeCollapsed = useDocPages((s) => s.treeCollapsed);
  const setTreeCollapsed = useDocPages((s) => s.setTreeCollapsed);
  // Desplegado a mano en un documento sin páginas: vale para esta vez y este
  // documento, y no se recuerda. Si se recordara, el siguiente documento vacío
  // volvería a salir abierto y a comerse el ancho por nada.
  const [abiertoAhora, setAbiertoAhora] = useState(false);
  useEffect(() => setAbiertoAhora(false), [kind, ownerId]);
  const owner = { kind, id: ownerId };

  // Plegado a un riel delgado: el árbol abierto se come ~220px que en una
  // tablet son el texto. Sin páginas sale plegado (no hay nada que navegar);
  // con páginas, como lo dejó quien mira la última vez.
  const vacio = tree.length === 0;
  const plegado = vacio ? !abiertoAhora : (treeCollapsed ?? false);
  const plegar = (v: boolean) => (vacio ? setAbiertoAhora(!v) : setTreeCollapsed(v));

  const sensors = useSensors(
    // Como en Notas y en el tablero: por debajo de 4px es un clic que abre la
    // página, no el principio de un arrastre.
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  // Lo que no se puede soltar —la página en sí misma o dentro de su propio
  // subárbol— se pinta en rojo mientras se arrastra, en vez de no reaccionar.
  const bloqueadas = dragging ? descendantsOf(tree, dragging) : [];

  const nueva = (parentId: string | null) => {
    createPage(owner, parentId, t("work:docs.untitled")).catch((e) => toast.error(String(e)));
  };

  const dialogos = (
    <>
      <MovePageDialog kind={kind} ownerId={ownerId} page={moviendo} onClose={() => setMoviendo(null)} />
      <DocPageTrash kind={kind} ownerId={ownerId} open={papelera} onOpenChange={setPapelera} />
    </>
  );

  if (plegado) {
    // El riel nunca deja el documento sin puerta a sus páginas: desplegar, la
    // portada, crear una y la papelera siguen a un clic.
    const icono = "grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground";
    return (
      <aside
        className="flex w-10 shrink-0 flex-col items-center gap-1 border-r py-2"
        aria-label={t("work:docs.pages")}
        data-collapsed="true"
      >
        <button
          type="button"
          className={icono}
          title={t("work:docs.expandTree")}
          aria-label={t("work:docs.expandTree")}
          onClick={() => plegar(false)}
        >
          <PanelLeftOpen className="size-4" />
        </button>
        <button
          type="button"
          className={cn(icono, activePageId === null && "bg-accent text-foreground")}
          title={t("work:docs.home")}
          aria-label={t("work:docs.home")}
          onClick={closePage}
        >
          <Home className="size-4" />
        </button>
        <button
          type="button"
          className={icono}
          title={t("work:docs.newPage")}
          aria-label={t("work:docs.newPage")}
          onClick={() => nueva(null)}
        >
          <Plus className="size-4" />
        </button>
        <button
          type="button"
          className={cn(icono, "mt-auto")}
          title={t("work:docs.trash")}
          aria-label={t("work:docs.trash")}
          onClick={() => setPapelera(true)}
        >
          <Trash2 className="size-3.5" />
        </button>
        {dialogos}
      </aside>
    );
  }

  return (
    <aside
      className="flex w-44 shrink-0 flex-col overflow-y-auto border-r p-2 lg:w-56"
      aria-label={t("work:docs.pages")}
    >
      <div
        className={cn(
          "group flex h-7 items-center gap-1.5 rounded-md px-1.5 text-[13px] font-semibold",
          activePageId === null ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/60",
        )}
      >
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
          onClick={closePage}
          title={t("work:docs.homeHint")}
        >
          <Home className="size-3.5 shrink-0" />
          <span className="truncate">{t("work:docs.home")}</span>
        </button>
        <button
          type="button"
          title={t("work:docs.newPage")}
          aria-label={t("work:docs.newPage")}
          className="grid size-5 shrink-0 place-items-center rounded hover:bg-background"
          onClick={() => nueva(null)}
        >
          <Plus className="size-3" />
        </button>
        <button
          type="button"
          title={t("work:docs.collapseTree")}
          aria-label={t("work:docs.collapseTree")}
          className="grid size-5 shrink-0 place-items-center rounded hover:bg-background"
          onClick={() => plegar(true)}
        >
          <PanelLeftClose className="size-3" />
        </button>
      </div>

      <DndContext
        sensors={sensors}
        collisionDetection={pointerWithin}
        onDragStart={(e) => setDragging(String(e.active.id))}
        onDragCancel={() => setDragging(null)}
        onDragEnd={(e) => {
          setDragging(null);
          if (!e.over) return;
          const [where, targetId] = String(e.over.id).split(":");
          dropPage(owner, String(e.active.id), targetId, where as DropWhere).catch((err) =>
            toast.error(t("work:docs.errMove"), { description: String(err) }),
          );
        }}
      >
        <ul className="mt-1">
          {childrenOf(tree, null).map((p) => (
            <PageRow
              key={p.id}
              page={p}
              depth={0}
              kind={kind}
              ownerId={ownerId}
              bloqueadas={bloqueadas}
              onNew={nueva}
              onMove={setMoviendo}
            />
          ))}
        </ul>
        <DragOverlay dropAnimation={null}>
          {dragging ? (
            <div className="rounded bg-background/95 px-2 py-1 text-[13px] shadow ring-1 ring-border">
              {tree.find((x) => x.id === dragging)?.title || t("work:docs.untitled")}
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>

      {/* Al pie y discreta: se viene a ella poco, pero tiene que estar donde
          están las páginas, no en otra pantalla. */}
      <button
        type="button"
        onClick={() => setPapelera(true)}
        className="mt-auto flex items-center gap-1.5 rounded-md px-1.5 pt-3 text-xs text-muted-foreground hover:text-foreground"
      >
        <Trash2 className="size-3" /> {t("work:docs.trash")}
      </button>

      {dialogos}
    </aside>
  );
}

function PageRow({
  page,
  depth,
  kind,
  ownerId,
  bloqueadas,
  onNew,
  onMove,
}: {
  page: DocPageTreeItem;
  depth: number;
  kind: DocOwnerKind;
  ownerId: string;
  bloqueadas: string[];
  onNew: (parentId: string | null) => void;
  onMove: (p: DocPageTreeItem) => void;
}) {
  const { t } = useT();
  const prompt = usePrompt();
  const tree = useDocPages((s) => s.tree);
  const activePageId = useDocPages((s) => s.activePageId);
  const openPage = useDocPages((s) => s.openPage);
  const savePage = useDocPages((s) => s.savePage);
  const tirar = useTrashPage(kind, ownerId);
  // Todo desplegado de entrada: un árbol que se abre cerrado esconde justo lo
  // que se vino a buscar.
  const [plegada, setPlegada] = useState(false);
  const { setNodeRef, listeners, attributes, isDragging } = useDraggable({ id: page.id });
  const owner = { kind, id: ownerId };
  const hijas = childrenOf(tree, page.id);
  const titulo = page.title || t("work:docs.untitled");
  const bloqueada = bloqueadas.includes(page.id);

  const renombrar = async () => {
    const nuevo = await prompt({
      title: t("work:docs.renameTitle"),
      label: t("work:docs.pageTitle"),
      defaultValue: page.title,
    });
    if (nuevo === null || nuevo.trim() === page.title) return;
    savePage(owner, page.id, { title: nuevo.trim() }).catch((e) => toast.error(String(e)));
  };

  return (
    <li>
      <div ref={setNodeRef} {...listeners} {...attributes} className={cn("relative", isDragging && "opacity-40")}>
        {/* Las tres zonas de Notas: sólo cuenta su geometría, así que no se
            comen el clic de la fila. */}
        <DropZone id={`before:${page.id}`} className="top-0 h-1/4" line="top" blocked={bloqueada} />
        <DropZone id={`inside:${page.id}`} className="inset-y-1/4" nest blocked={bloqueada} />
        <DropZone id={`after:${page.id}`} className="bottom-0 h-1/4" line="bottom" blocked={bloqueada} />
        <div
          className={cn(
            "group flex h-7 items-center gap-1 rounded-md pr-1 text-[13px]",
            page.id === activePageId
              ? "bg-accent font-medium text-foreground"
              : "text-muted-foreground hover:bg-accent/60",
          )}
          style={{ paddingLeft: 4 + depth * 12 }}
        >
          <button
            type="button"
            aria-label={t(plegada ? "work:tree.expand" : "work:tree.collapse", { name: titulo })}
            className={cn("grid size-4 shrink-0 place-items-center", hijas.length === 0 && "invisible")}
            onClick={() => setPlegada((v) => !v)}
          >
            {plegada ? <ChevronRight className="size-3" /> : <ChevronDown className="size-3" />}
          </button>
          <button
            type="button"
            className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
            onClick={() => void openPage(owner, page.id)}
          >
            <FileText className="size-3.5 shrink-0" />
            <span className="truncate">{titulo}</span>
          </button>
          <button
            type="button"
            title={t("work:docs.newSubpage")}
            aria-label={t("work:docs.newSubpage")}
            className="hidden size-5 shrink-0 place-items-center rounded hover:bg-background group-focus-within:grid group-hover:grid"
            onClick={() => onNew(page.id)}
          >
            <Plus className="size-3" />
          </button>
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <button
                  type="button"
                  aria-label={t("work:docs.pageMenu", { title: titulo })}
                  className="hidden size-5 shrink-0 place-items-center rounded hover:bg-background group-focus-within:grid group-hover:grid data-[popup-open]:grid"
                >
                  <MoreHorizontal className="size-3" />
                </button>
              }
            />
            <DropdownMenuContent align="start">
              <DropdownMenuGroup>
                <DropdownMenuItem onClick={() => void renombrar()}>
                  <Pencil className="size-4" /> {t("work:docs.rename")}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => onMove(page)}>
                  <FolderInput className="size-4" /> {t("work:docs.moveTo")}
                </DropdownMenuItem>
                <DropdownMenuItem variant="destructive" onClick={() => void tirar(page.id, page.title)}>
                  <Trash2 className="size-4" /> {t("work:docs.trashPage")}
                </DropdownMenuItem>
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
      {hijas.length > 0 && !plegada && (
        <ul>
          {hijas.map((h) => (
            <PageRow
              key={h.id}
              page={h}
              depth={depth + 1}
              kind={kind}
              ownerId={ownerId}
              bloqueadas={bloqueadas}
              onNew={onNew}
              onMove={onMove}
            />
          ))}
        </ul>
      )}
    </li>
  );
}
