import { useMemo, useState } from "react";
import { ListTree } from "lucide-react";

import DocPagesBranch from "@/components/docs/DocPagesBranch";
import { DocsTreeView } from "@/components/docs/docs-tree-view";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { useIsMobile } from "@/hooks/use-mobile";
import { pageKey } from "@/lib/docs-panel";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n";
import { useDocPages } from "@/store/doc-pages.store";
import type { DocOwnerKind } from "@/types/task";

/**
 * Las páginas del documento abierto, donde el panel no las enseña.
 *
 * En `/docs` del escritorio viven en el panel de Documentación. Fuera de ahí no
 * hay quien las enseñe: en el teléfono no hay panel —el sidebar es un cajón
 * cerrado—, y leyendo la documentación de una lista en `/tasks` el panel es el
 * de Trabajo (ver `AppSidebar`). Sin esto un documento con páginas no tendría
 * forma de llegar a ellas salvo por enlaces. Un botón en la cabecera abre una
 * hoja —desde abajo en el teléfono, a la derecha en el escritorio— con la
 * misma rama que el panel: la portada, las páginas, «+» y la papelera. Elegir
 * algo la cierra.
 */
export default function DocPagesSheet({
  kind,
  ownerId,
  inDocsPanel,
}: {
  kind: DocOwnerKind;
  ownerId: string;
  /** Si la pantalla lleva el panel de Documentación al lado (`/docs`). */
  inDocsPanel: boolean;
}) {
  const { t } = useT();
  const mobile = useIsMobile();
  const [open, setOpen] = useState(false);
  const breadcrumb = useDocPages((s) => s.view?.breadcrumb);
  // Abiertas las madres de la página que se lee, como en el panel.
  const view = useMemo(
    () => ({ defaults: new Set((breadcrumb ?? []).map((b) => pageKey(b.id))), visible: null }),
    [breadcrumb],
  );
  if (!mobile && inDocsPanel) return null;

  return (
    <>
      <Button
        size="icon-xs"
        variant="ghost"
        title={t("work:docs.pages")}
        aria-label={t("work:docs.pages")}
        onClick={() => setOpen(true)}
      >
        <ListTree className="size-3.5" />
      </Button>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent
          side={mobile ? "bottom" : "right"}
          className={cn(
            "gap-0 overflow-y-auto bg-sidebar p-2 text-sidebar-foreground",
            mobile ? "max-h-[85dvh] rounded-t-xl pb-[env(safe-area-inset-bottom)]" : "w-80 sm:max-w-80",
          )}
        >
          <SheetHeader className="px-1 pb-1">
            <SheetTitle>{t("work:docs.pages")}</SheetTitle>
          </SheetHeader>
          <DocsTreeView.Provider value={view}>
            <DocPagesBranch kind={kind} ownerId={ownerId} depth={0} active onPicked={() => setOpen(false)} />
          </DocsTreeView.Provider>
        </SheetContent>
      </Sheet>
    </>
  );
}
