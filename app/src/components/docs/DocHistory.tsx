import { useState } from "react";
import { History, Loader2, RotateCcw } from "lucide-react";
import { toast } from "sonner";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ConfirmDialog";
import { fechaYHora } from "@/lib/fechas";
import { useT } from "@/lib/i18n";
import { useTasksStore } from "@/store/tasks.store";
import type { DocTabKey, DocVersion } from "@/types/task";

/**
 * De dónde venía esta sección.
 *
 * El historial es lo que hace soportable el autoguardado: escribir sin botón de
 * guardar sólo es cómodo si equivocarse tiene vuelta atrás. Sin esto, un borrado
 * accidental se guarda solo y no hay a dónde volver.
 */
export default function DocHistory({ tab }: { tab: DocTabKey }) {
  const { t } = useT();
  const confirm = useConfirm();
  const docVersions = useTasksStore((s) => s.docVersions);
  const restoreDoc = useTasksStore((s) => s.restoreDoc);
  const [versiones, setVersiones] = useState<DocVersion[] | null>(null);
  const [cargando, setCargando] = useState(false);

  // Se pide al abrir, no al pintar la pantalla: casi nadie mira el historial, y
  // pedirlo siempre sería una petición por documento abierto para nada.
  const abrir = async (open: boolean) => {
    if (!open) return;
    setCargando(true);
    try {
      setVersiones(await docVersions(tab));
    } catch {
      setVersiones([]);
    } finally {
      setCargando(false);
    }
  };

  const volver = async (v: DocVersion) => {
    const ok = await confirm({
      title: t("work:docs.restoreTitle"),
      // Se dice qué pasa con lo de ahora, porque es lo que preocupa: restaurar
      // también es un guardado, así que el texto actual entra en el historial.
      description: t("work:docs.restoreWhy", { date: fechaYHora(v.createdAt) }),
      confirmText: t("work:docs.restore"),
    });
    if (!ok) return;
    try {
      await restoreDoc(v.id);
      toast.success(t("work:docs.restored"));
    } catch (e) {
      toast.error(t("work:docs.errSave"), { description: String(e) });
    }
  };

  return (
    <DropdownMenu onOpenChange={(o) => void abrir(o)}>
      <DropdownMenuTrigger
        render={
          <Button size="sm" variant="ghost" className="h-6 gap-1.5 text-xs">
            <History className="size-3" />
            {t("work:docs.history")}
          </Button>
        }
      />
      <DropdownMenuContent align="end" className="max-h-80 w-72 overflow-auto p-1">
        {cargando && (
          <p className="flex items-center gap-2 px-2 py-3 text-xs text-muted-foreground">
            <Loader2 className="size-3 animate-spin" /> {t("common:servers.loading")}
          </p>
        )}
        {!cargando && versiones?.length === 0 && (
          <p className="px-2 py-3 text-xs text-muted-foreground">{t("work:docs.noHistory")}</p>
        )}
        {versiones?.map((v) => (
          <div
            key={v.id}
            className="flex items-center gap-2 rounded px-2 py-1.5 text-xs hover:bg-accent"
          >
            <span className="min-w-0 flex-1">
              <span className="block tabular-nums">{fechaYHora(v.createdAt)}</span>
              <span className="block truncate text-muted-foreground">{v.authorName}</span>
            </span>
            <Button
              size="icon-xs"
              variant="ghost"
              title={t("work:docs.restore")}
              onClick={() => void volver(v)}
            >
              <RotateCcw className="size-3" />
            </Button>
          </div>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
