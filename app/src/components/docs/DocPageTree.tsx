import { useState } from "react";
import { ChevronDown, ChevronRight, FileText, Home, Plus } from "lucide-react";

import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { childrenOf, useDocPages } from "@/store/doc-pages.store";
import type { DocOwnerKind, DocPageTreeItem } from "@/types/task";

/**
 * El árbol de páginas de un documento, en el lateral, como el de Confluence.
 *
 * Arriba, la **portada** (las cuatro pestañas de siempre); debajo, las páginas
 * que cuelgan de ella, anidadas sin límite. El «+» de cada fila crea una página
 * dentro de esa fila —lo que hace Confluence: la página nueva es hija de la que
 * estás mirando—, y la página se abre ya, con el título para escribir.
 */
export default function DocPageTree({ kind, ownerId }: { kind: DocOwnerKind; ownerId: string }) {
  const { t } = useT();
  const tree = useDocPages((s) => s.tree);
  const activePageId = useDocPages((s) => s.activePageId);
  const openPage = useDocPages((s) => s.openPage);
  const closePage = useDocPages((s) => s.closePage);
  const createPage = useDocPages((s) => s.createPage);
  // Plegadas, por id. Todo desplegado de entrada: un árbol que se abre cerrado
  // esconde justo lo que se vino a buscar.
  const [plegadas, setPlegadas] = useState<Record<string, boolean>>({});
  const owner = { kind, id: ownerId };

  const nueva = (parentId: string | null) => {
    void createPage(owner, parentId, t("work:docs.untitled"));
  };

  const fila = (p: DocPageTreeItem, depth: number) => {
    const hijas = childrenOf(tree, p.id);
    const plegada = plegadas[p.id];
    return (
      <li key={p.id}>
        <div
          className={cn(
            "group flex h-7 items-center gap-1 rounded-md pr-1 text-[13px]",
            p.id === activePageId ? "bg-accent font-medium text-foreground" : "text-muted-foreground hover:bg-accent/60",
          )}
          style={{ paddingLeft: 4 + depth * 12 }}
        >
          <button
            type="button"
            aria-label={t(plegada ? "work:tree.expand" : "work:tree.collapse", { name: p.title || t("work:docs.untitled") })}
            className={cn("grid size-4 shrink-0 place-items-center", hijas.length === 0 && "invisible")}
            onClick={() => setPlegadas((s) => ({ ...s, [p.id]: !s[p.id] }))}
          >
            {plegada ? <ChevronRight className="size-3" /> : <ChevronDown className="size-3" />}
          </button>
          <button
            type="button"
            className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
            onClick={() => void openPage(owner, p.id)}
          >
            <FileText className="size-3.5 shrink-0" />
            <span className="truncate">{p.title || t("work:docs.untitled")}</span>
          </button>
          <button
            type="button"
            title={t("work:docs.newSubpage")}
            aria-label={t("work:docs.newSubpage")}
            className="hidden size-5 shrink-0 place-items-center rounded hover:bg-background group-focus-within:grid group-hover:grid"
            onClick={() => nueva(p.id)}
          >
            <Plus className="size-3" />
          </button>
        </div>
        {hijas.length > 0 && !plegada && <ul>{hijas.map((h) => fila(h, depth + 1))}</ul>}
      </li>
    );
  };

  return (
    // Siempre a la vista, también en una ventana estrecha: escondido, las páginas
    // de un documento no tendrían otra puerta que un enlace.
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
        <button type="button" className="flex min-w-0 flex-1 items-center gap-1.5 text-left" onClick={closePage} title={t("work:docs.homeHint")}>
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
      </div>
      <ul className="mt-1">{childrenOf(tree, null).map((p) => fila(p, 0))}</ul>
    </aside>
  );
}
