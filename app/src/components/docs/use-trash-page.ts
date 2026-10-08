import { toast } from "sonner";

import { useConfirm } from "@/components/ConfirmDialog";
import { useT } from "@/lib/i18n";
import { descendantsOf, useDocPages } from "@/store/doc-pages.store";
import type { DocOwnerKind } from "@/types/task";

/**
 * Mandar una página a la papelera, preguntando antes y diciendo cuántas se van
 * con ella. Lo usan el menú de cada fila del árbol y el pie de la página
 * abierta: dos sitios, una sola pregunta.
 *
 * El número va en la pregunta porque es lo que no se ve: una página plegada en
 * el árbol puede llevar debajo media wiki.
 */
export function useTrashPage(kind: DocOwnerKind, ownerId: string) {
  const { t } = useT();
  const confirm = useConfirm();
  const trashPage = useDocPages((s) => s.trashPage);

  return async (pageId: string, title: string): Promise<boolean> => {
    const debajo = descendantsOf(useDocPages.getState().tree, pageId).length - 1;
    const ok = await confirm({
      title: t("work:docs.trashPageTitle", { title: title || t("work:docs.untitled") }),
      description:
        debajo > 0 ? t("work:docs.trashPageWithSubpages", { count: debajo }) : t("work:docs.trashPageWhy"),
      confirmText: t("work:docs.trashPage"),
      destructive: true,
    });
    if (!ok) return false;
    try {
      const n = await trashPage({ kind, id: ownerId }, pageId);
      // Sin hijas, sin número: con `count: 0` el plural de i18next elige la
      // forma «otras» y decía «con las 0 páginas de dentro».
      toast.success(n > 1 ? t("work:docs.trashedWith", { count: n - 1 }) : t("work:docs.trashed"));
      return true;
    } catch (e) {
      toast.error(String((e as Error)?.message ?? e));
      return false;
    }
  };
}
