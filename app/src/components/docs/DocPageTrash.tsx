import { useEffect } from "react";
import { Loader2, RotateCcw, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { fechaYHora } from "@/lib/fechas";
import { useT } from "@/lib/i18n";
import { useDocPages } from "@/store/doc-pages.store";
import type { DocOwnerKind } from "@/types/task";

/**
 * La papelera de las páginas de un documento.
 *
 * Restaurar trae la página **y lo que se fue con ella** (lo que se tiró en el
 * mismo instante), así que cada fila dice cuántas son antes de pulsar. No hay
 * «borrar para siempre»: ningún botón ni ningún token destruye documentación;
 * una página en la papelera sigue siendo encontrable por quien la busque aquí.
 */
export default function DocPageTrash({
  kind,
  ownerId,
  open,
  onOpenChange,
}: {
  kind: DocOwnerKind;
  ownerId: string;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const { t } = useT();
  const items = useDocPages((s) => s.trash);
  const loading = useDocPages((s) => s.loadingTrash);
  const fetchTrash = useDocPages((s) => s.fetchTrash);
  const restorePage = useDocPages((s) => s.restorePage);

  useEffect(() => {
    if (open) fetchTrash({ kind, id: ownerId }).catch(() => {});
  }, [open, kind, ownerId, fetchTrash]);

  const restaurar = (id: string, subpages: number) =>
    restorePage({ kind, id: ownerId }, id)
      .then(() =>
        toast.success(
          subpages > 0 ? t("work:docs.restoredWith", { count: subpages }) : t("work:docs.restoredPage"),
        ),
      )
      .catch((e) => toast.error(t("work:docs.errRestore"), { description: String(e) }));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg gap-3">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-sm">
            <Trash2 className="size-4" /> {t("work:docs.trash")}
          </DialogTitle>
        </DialogHeader>
        <div className="max-h-80 space-y-0.5 overflow-auto">
          {loading && items.length === 0 && (
            <p className="flex items-center gap-2 px-1 py-2 text-xs text-muted-foreground">
              <Loader2 className="size-3 animate-spin" /> {t("common:servers.loading")}
            </p>
          )}
          {!loading && items.length === 0 && (
            <p className="px-1 py-2 text-xs text-muted-foreground">{t("work:docs.trashEmpty")}</p>
          )}
          {items.map((it) => (
            <div key={it.id} className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-accent/50">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm">{it.title || t("work:docs.untitled")}</p>
                <p className="text-xs text-muted-foreground">
                  {it.deletedAt && fechaYHora(it.deletedAt)}
                  {(it.subpages ?? 0) > 0 && ` · ${t("work:docs.subpages", { count: it.subpages })}`}
                </p>
              </div>
              <Button size="xs" variant="outline" onClick={() => void restaurar(it.id, it.subpages ?? 0)}>
                <RotateCcw className="size-3" /> {t("work:docs.restore")}
              </Button>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
