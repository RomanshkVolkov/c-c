import { useEffect, useState } from "react";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  pointerWithin,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { sortableKeyboardCoordinates } from "@dnd-kit/sortable";
import { Home, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";

import DocPageTrash from "@/components/docs/DocPageTrash";
import { useDocsFilter } from "@/components/docs/docs-tree-view";
import MovePageDialog from "@/components/docs/MovePageDialog";
import PageRow from "@/components/docs/PageRow";
import { pageKey } from "@/lib/docs-panel";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { childrenOf, descendantsOf, useDocPages } from "@/store/doc-pages.store";
import type { DropWhere } from "@/store/tasks.store";
import { docKey, type DocOwnerKind, type DocPageTreeItem } from "@/types/task";

const NO_PAGES: DocPageTreeItem[] = [];

/**
 * Las páginas de un documento, colgando de su nodo en el árbol de
 * Documentación — como el árbol de contenido de Confluence, pero en el mismo
 * sidebar y no en una columna aparte.
 *
 * **La del documento abierto (`active`)** es la de trabajo: arriba la
 * portada (las cuatro pestañas de siempre) con «+» y la papelera, y debajo las
 * páginas, que se arrastran, se crean dentro de cualquier fila y llevan su
 * menú. Lee y escribe `tree`.
 *
 * **La de otro documento** sólo se lee, de `pagesByOwner`: la pide una vez al
 * montarse —que es al desplegar su nodo, no antes— y pulsar una página abre
 * ese documento en ella. Con el filtro puesto no pide nada (`peek={false}`):
 * filtrar no puede ser una petición por cada documento del árbol.
 */
export default function DocPagesBranch({
  kind,
  ownerId,
  depth,
  active,
  peek = true,
  onOpenOther,
  onPicked,
}: {
  kind: DocOwnerKind;
  ownerId: string;
  depth: number;
  active: boolean;
  /** Si una rama que no es la abierta puede pedir sus páginas al montarse. */
  peek?: boolean;
  /** Abrir una página de otro documento: lo decide quien sabe navegar. */
  onOpenOther?: (page: DocPageTreeItem) => void;
  /** Tras abrir algo (la portada, una página): la hoja del teléfono se cierra. */
  onPicked?: () => void;
}) {
  const key = docKey(kind, ownerId);
  const tree = useDocPages((s) => s.tree);
  const cached = useDocPages((s) => s.pagesByOwner[key]) ?? NO_PAGES;
  const peekPages = useDocPages((s) => s.peekPages);
  const pages = active ? tree : cached;
  const has = useDocPages((s) => key in s.pagesByOwner);

  useEffect(() => {
    if (active || !peek || has) return;
    peekPages({ kind, id: ownerId }).catch(() => {});
    // Una vez por rama montada: lo cacheado no se vuelve a pedir al repintar.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, peek, kind, ownerId]);

  if (active) return <ActiveBranch kind={kind} ownerId={ownerId} depth={depth} onPicked={onPicked} />;
  return (
    <PagesList
      pages={pages}
      depth={depth}
      kind={kind}
      ownerId={ownerId}
      activePageId={null}
      readOnly
      onOpen={(p) => onOpenOther?.(p)}
    />
  );
}

function PagesList(props: Omit<React.ComponentProps<typeof PageRow>, "page">) {
  const { shows } = useDocsFilter();
  const top = childrenOf(props.pages, null).filter((p) => shows(pageKey(p.id)));
  if (top.length === 0) return null;
  return (
    <ul>
      {top.map((p) => (
        <PageRow key={p.id} {...props} page={p} />
      ))}
    </ul>
  );
}

function ActiveBranch({
  kind,
  ownerId,
  depth,
  onPicked,
}: {
  kind: DocOwnerKind;
  ownerId: string;
  depth: number;
  onPicked?: () => void;
}) {
  const { t } = useT();
  const tree = useDocPages((s) => s.tree);
  const activePageId = useDocPages((s) => s.activePageId);
  const closePage = useDocPages((s) => s.closePage);
  const openPage = useDocPages((s) => s.openPage);
  const createPage = useDocPages((s) => s.createPage);
  const dropPage = useDocPages((s) => s.dropPage);
  const { filtering } = useDocsFilter();
  const [dragging, setDragging] = useState<string | null>(null);
  const [moving, setMoving] = useState<DocPageTreeItem | null>(null);
  const [trashOpen, setTrashOpen] = useState(false);
  const owner = { kind, id: ownerId };

  const sensors = useSensors(
    // Como en Notas y en el tablero: por debajo de 4px es un clic que abre la
    // página, no el principio de un arrastre.
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  // Lo que no se puede soltar —la página en sí misma o dentro de su propio
  // subárbol— se pinta en rojo mientras se arrastra, en vez de no reaccionar.
  const blocked = dragging ? descendantsOf(tree, dragging) : [];

  const newPage = (parentId: string | null) => {
    createPage(owner, parentId, t("work:docs.untitled"))
      .then(() => onPicked?.())
      .catch((e) => toast.error(String(e)));
  };

  const icon = "grid size-5 shrink-0 place-items-center rounded hover:bg-background";

  return (
    <div>
      {/* La portada. Con el filtro puesto no: no es un título que buscar. */}
      {!filtering && (
        <div
          className={cn(
            "group flex h-7 items-center gap-1 rounded-md pr-1 text-[13px]",
            activePageId === null
              ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
              : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground",
          )}
          style={{ paddingLeft: 4 + depth * 12 + 20 }}
        >
          <button
            type="button"
            aria-current={activePageId === null ? "page" : undefined}
            className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
            onClick={() => {
              closePage();
              onPicked?.();
            }}
            title={t("work:docs.homeHint")}
          >
            <Home className="size-3.5 shrink-0" />
            <span className="truncate">{t("work:docs.home")}</span>
          </button>
          <button
            type="button"
            title={t("work:docs.newPage")}
            aria-label={t("work:docs.newPage")}
            className={icon}
            onClick={() => newPage(null)}
          >
            <Plus className="size-3" />
          </button>
          {/* La papelera, junto a la portada: se viene a ella poco, pero tiene
              que estar donde están las páginas, no en otra pantalla. */}
          <button
            type="button"
            title={t("work:docs.trash")}
            aria-label={t("work:docs.trash")}
            className={icon}
            onClick={() => setTrashOpen(true)}
          >
            <Trash2 className="size-3" />
          </button>
        </div>
      )}

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
        <PagesList
          pages={tree}
          depth={depth}
          kind={kind}
          ownerId={ownerId}
          activePageId={activePageId}
          blocked={blocked}
          onOpen={(p) => {
            void openPage(owner, p.id);
            onPicked?.();
          }}
          onNew={newPage}
          onMove={setMoving}
        />
        <DragOverlay dropAnimation={null}>
          {dragging ? (
            <div className="rounded bg-background/95 px-2 py-1 text-[13px] shadow ring-1 ring-border">
              {tree.find((x) => x.id === dragging)?.title || t("work:docs.untitled")}
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>

      <MovePageDialog kind={kind} ownerId={ownerId} page={moving} onClose={() => setMoving(null)} />
      <DocPageTrash kind={kind} ownerId={ownerId} open={trashOpen} onOpenChange={setTrashOpen} />
    </div>
  );
}
