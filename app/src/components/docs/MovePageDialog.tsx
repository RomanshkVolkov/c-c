import { useState } from "react";
import { FileText, Home } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { childrenOf, descendantsOf, useDocPages } from "@/store/doc-pages.store";
import type { DocOwnerKind, DocPageTreeItem } from "@/types/task";

/**
 * «Mover a…»: elegir la nueva madre de una página en una lista, sin arrastrar.
 *
 * Lo que tiene Confluence en su menú de página, por lo mismo: en un árbol largo
 * arrastrar es fallar a la tercera, y con teclado no se puede. La página va al
 * final de las hijas de la madre elegida.
 *
 * La propia página y lo que cuelga de ella no se ofrecen: no se puede colgar
 * algo de sí mismo. Se enseñan atenuadas en vez de quitarlas para que el árbol
 * se siga leyendo igual que en el lateral.
 */
export default function MovePageDialog({
  kind,
  ownerId,
  page,
  onClose,
}: {
  kind: DocOwnerKind;
  ownerId: string;
  page: DocPageTreeItem | null;
  onClose: () => void;
}) {
  const { t } = useT();
  const tree = useDocPages((s) => s.tree);
  const movePage = useDocPages((s) => s.movePage);
  const [destino, setDestino] = useState<string | null | undefined>(undefined);
  const [moviendo, setMoviendo] = useState(false);

  if (!page) return null;
  const prohibidas = descendantsOf(tree, page.id);
  const actual = page.parentId ?? null;

  const mover = async () => {
    if (destino === undefined || destino === actual) return;
    setMoviendo(true);
    try {
      const hijas = childrenOf(tree, destino).filter((x) => x.id !== page.id);
      const ultima = hijas[hijas.length - 1];
      await movePage({ kind, id: ownerId }, page.id, {
        parentId: destino,
        ...(ultima ? { afterId: ultima.id } : {}),
      });
      cerrar();
    } catch (e) {
      toast.error(t("work:docs.errMove"), { description: String(e) });
    } finally {
      setMoviendo(false);
    }
  };

  const cerrar = () => {
    setDestino(undefined);
    onClose();
  };

  const fila = (p: DocPageTreeItem, depth: number): React.ReactNode => {
    const no = prohibidas.includes(p.id);
    return (
      <div key={p.id}>
        <button
          type="button"
          disabled={no}
          aria-pressed={destino === p.id}
          onClick={() => setDestino(p.id)}
          className={cn(
            "flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-sm",
            destino === p.id ? "bg-accent text-foreground" : "hover:bg-accent/60",
            no && "cursor-not-allowed opacity-40 hover:bg-transparent",
          )}
          style={{ paddingLeft: 8 + depth * 14 }}
        >
          <FileText className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate">{p.title || t("work:docs.untitled")}</span>
          {(actual ?? null) === p.id && (
            <span className="ml-auto shrink-0 text-xs text-muted-foreground">{t("work:docs.currentParent")}</span>
          )}
        </button>
        {/* Dentro de la propia página no se baja: todo lo de ahí está prohibido. */}
        {!no && childrenOf(tree, p.id).map((h) => fila(h, depth + 1))}
      </div>
    );
  };

  return (
    <Dialog open onOpenChange={(o) => !o && cerrar()}>
      <DialogContent className="max-w-md gap-3">
        <DialogHeader>
          <DialogTitle className="text-sm">
            {t("work:docs.moveToTitle", { title: page.title || t("work:docs.untitled") })}
          </DialogTitle>
        </DialogHeader>
        <p className="text-xs text-muted-foreground">{t("work:docs.moveToHint")}</p>
        <div className="max-h-80 overflow-auto rounded-md border p-1">
          <button
            type="button"
            aria-pressed={destino === null}
            onClick={() => setDestino(null)}
            className={cn(
              "flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-sm font-medium",
              destino === null ? "bg-accent text-foreground" : "hover:bg-accent/60",
            )}
          >
            <Home className="size-3.5 shrink-0 text-muted-foreground" />
            {t("work:docs.home")}
            {actual === null && (
              <span className="ml-auto text-xs font-normal text-muted-foreground">{t("work:docs.currentParent")}</span>
            )}
          </button>
          {childrenOf(tree, null).map((p) => fila(p, 1))}
        </div>
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={cerrar}>
            {t("work:docs.cancel")}
          </Button>
          <Button size="sm" disabled={destino === undefined || destino === actual || moviendo} onClick={() => void mover()}>
            {t("work:docs.moveHere")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
