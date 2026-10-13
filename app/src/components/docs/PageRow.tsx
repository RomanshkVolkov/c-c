import { useDraggable } from "@dnd-kit/core";
import { ChevronDown, ChevronRight, FileText, FolderInput, MoreHorizontal, Pencil, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";

import DropZone from "@/components/dnd/DropZone";
import { useBranch } from "@/components/docs/docs-tree-view";
import { useTrashPage } from "@/components/docs/use-trash-page";
import { usePrompt } from "@/components/PromptDialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { pageKey } from "@/lib/docs-panel";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { childrenOf, useDocPages } from "@/store/doc-pages.store";
import type { DocOwnerKind, DocPageTreeItem } from "@/types/task";

/**
 * Una página en el árbol de Documentación, con las que cuelgan de ella.
 *
 * Las del documento abierto se arrastran (con las tres zonas de Notas:
 * encima, dentro, debajo), se crean dentro con «+» y llevan su menú. Las de
 * otro documento son **de sólo lectura** (`readOnly`): se ven y se abren, y
 * nada más, porque las mutaciones del store son del documento abierto (ver
 * `doc-pages.store.ts`). Un «+» ahí crearía la página en el que no es.
 *
 * Las acciones salen al pasar el ratón **y al enfocar**, nunca con
 * `opacity-0`: eso deja un botón invisible en el orden de tabulación.
 */
export default function PageRow({
  page,
  pages,
  depth,
  kind,
  ownerId,
  activePageId,
  readOnly = false,
  blocked = [],
  onOpen,
  onNew,
  onMove,
}: {
  page: DocPageTreeItem;
  /** Todas las páginas de su documento, para encontrar sus hijas. */
  pages: DocPageTreeItem[];
  depth: number;
  kind: DocOwnerKind;
  ownerId: string;
  activePageId: string | null;
  readOnly?: boolean;
  /** Mientras se arrastra: dónde no se puede soltar (ella y su subárbol). */
  blocked?: string[];
  onOpen: (page: DocPageTreeItem) => void;
  onNew?: (parentId: string | null) => void;
  onMove?: (page: DocPageTreeItem) => void;
}) {
  const { t } = useT();
  const prompt = usePrompt();
  const savePage = useDocPages((s) => s.savePage);
  const trash = useTrashPage(kind, ownerId);
  const branch = useBranch(pageKey(page.id));
  const { setNodeRef, listeners, attributes, isDragging } = useDraggable({ id: page.id, disabled: readOnly });
  const children = childrenOf(pages, page.id).filter((c) => branch.shows(pageKey(c.id)));
  const title = page.title || t("work:docs.untitled");
  const isBlocked = blocked.includes(page.id);

  const rename = async () => {
    const next = await prompt({
      title: t("work:docs.renameTitle"),
      label: t("work:docs.pageTitle"),
      defaultValue: page.title,
    });
    if (next === null || next.trim() === page.title) return;
    savePage({ kind, id: ownerId }, page.id, { title: next.trim() }).catch((e) => toast.error(String(e)));
  };

  const row = (
    <div
      className={cn(
        "group flex h-7 items-center gap-1 rounded-md pr-1 text-[13px]",
        page.id === activePageId
          ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
          : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground",
      )}
      style={{ paddingLeft: 4 + depth * 12 }}
    >
      <button
        type="button"
        aria-expanded={children.length > 0 ? branch.open : undefined}
        aria-label={t(branch.open ? "work:tree.collapse" : "work:tree.expand", { name: title })}
        className={cn("grid size-4 shrink-0 place-items-center", children.length === 0 && "invisible")}
        onClick={branch.toggle}
      >
        {branch.open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
      </button>
      <button
        type="button"
        aria-current={page.id === activePageId ? "page" : undefined}
        className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
        onClick={() => onOpen(page)}
      >
        <FileText className="size-3.5 shrink-0" />
        <span className="truncate">{title}</span>
      </button>
      {!readOnly && onNew && (
        <button
          type="button"
          title={t("work:docs.newSubpage")}
          aria-label={t("work:docs.newSubpage")}
          className="hidden size-5 shrink-0 place-items-center rounded hover:bg-background group-focus-within:grid group-hover:grid"
          onClick={() => onNew(page.id)}
        >
          <Plus className="size-3" />
        </button>
      )}
      {!readOnly && (
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <button
                type="button"
                aria-label={t("work:docs.pageMenu", { title })}
                className="hidden size-5 shrink-0 place-items-center rounded hover:bg-background group-focus-within:grid group-hover:grid data-[popup-open]:grid"
              >
                <MoreHorizontal className="size-3" />
              </button>
            }
          />
          <DropdownMenuContent align="start">
            <DropdownMenuGroup>
              <DropdownMenuItem onClick={() => void rename()}>
                <Pencil className="size-4" /> {t("work:docs.rename")}
              </DropdownMenuItem>
              {onMove && (
                <DropdownMenuItem onClick={() => onMove(page)}>
                  <FolderInput className="size-4" /> {t("work:docs.moveTo")}
                </DropdownMenuItem>
              )}
              <DropdownMenuItem variant="destructive" onClick={() => void trash(page.id, page.title)}>
                <Trash2 className="size-4" /> {t("work:docs.trashPage")}
              </DropdownMenuItem>
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );

  return (
    <li>
      {readOnly ? (
        row
      ) : (
        <div ref={setNodeRef} {...listeners} {...attributes} className={cn("relative", isDragging && "opacity-40")}>
          {/* Las tres zonas de Notas: sólo cuenta su geometría, así que no se
              comen el clic de la fila. */}
          <DropZone id={`before:${page.id}`} className="top-0 h-1/4" line="top" blocked={isBlocked} />
          <DropZone id={`inside:${page.id}`} className="inset-y-1/4" nest blocked={isBlocked} />
          <DropZone id={`after:${page.id}`} className="bottom-0 h-1/4" line="bottom" blocked={isBlocked} />
          {row}
        </div>
      )}
      {children.length > 0 && branch.open && (
        <ul>
          {children.map((c) => (
            <PageRow
              key={c.id}
              page={c}
              pages={pages}
              depth={depth + 1}
              kind={kind}
              ownerId={ownerId}
              activePageId={activePageId}
              readOnly={readOnly}
              blocked={blocked}
              onOpen={onOpen}
              onNew={onNew}
              onMove={onMove}
            />
          ))}
        </ul>
      )}
    </li>
  );
}
