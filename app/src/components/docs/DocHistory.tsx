import { useMemo, useState } from "react";
import { History, Loader2, RotateCcw } from "lucide-react";
import { toast } from "sonner";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { diffStats, lineDiff } from "@/lib/line-diff";
import { cn } from "@/lib/utils";
import { useConfirm } from "@/components/ConfirmDialog";
import { fechaYHora } from "@/lib/fechas";
import { useT } from "@/lib/i18n";
import { useTasksStore } from "@/store/tasks.store";
import type { DocTabKey } from "@/types/task";

/**
 * De dónde venía esta sección.
 *
 * El historial es lo que hace soportable el autoguardado: escribir sin botón de
 * guardar sólo es cómodo si equivocarse tiene vuelta atrás. Sin esto, un borrado
 * accidental se guarda solo y no hay a dónde volver.
 */
export default function DocHistory({ tab, current }: { tab: DocTabKey; current: string }) {
  const docVersions = useTasksStore((s) => s.docVersions);
  const restoreDoc = useTasksStore((s) => s.restoreDoc);
  return <VersionMenu current={current} load={() => docVersions(tab)} restore={(id) => restoreDoc(id)} />;
}

/** Lo que el menú necesita de una versión, sea de una pestaña o de una página. */
export interface VersionRow {
  id: string;
  createdAt: string;
  authorName?: string;
  /** El texto de esa versión, para enseñar qué cambió desde entonces. */
  body: string;
}

/**
 * El menú del historial, sin saber de qué es: lo usan las pestañas de la
 * portada y las páginas, que guardan sus versiones en sitios distintos pero se
 * restauran igual (restaurar también es un guardado y queda en el historial).
 */
export function VersionMenu({
  current,
  load,
  restore,
}: {
  /** El texto de ahora: contra él se compara cada versión. */
  current: string;
  load: () => Promise<VersionRow[]>;
  restore: (versionId: string) => Promise<void>;
}) {
  const { t } = useT();
  const confirm = useConfirm();
  const [versiones, setVersiones] = useState<VersionRow[] | null>(null);
  const [cargando, setCargando] = useState(false);
  // La versión cuyo cambio se está mirando.
  const [viendo, setViendo] = useState<VersionRow | null>(null);

  // Se pide al abrir, no al pintar la pantalla: casi nadie mira el historial, y
  // pedirlo siempre sería una petición por documento abierto para nada.
  const abrir = async (open: boolean) => {
    if (!open) return;
    setCargando(true);
    try {
      setVersiones(await load());
    } catch {
      setVersiones([]);
    } finally {
      setCargando(false);
    }
  };

  const volver = async (v: VersionRow) => {
    const ok = await confirm({
      title: t("work:docs.restoreTitle"),
      // Se dice qué pasa con lo de ahora, porque es lo que preocupa: restaurar
      // también es un guardado, así que el texto actual entra en el historial.
      description: t("work:docs.restoreWhy", { date: fechaYHora(v.createdAt) }),
      confirmText: t("work:docs.restore"),
    });
    if (!ok) return;
    try {
      await restore(v.id);
      setViendo(null);
      toast.success(t("work:docs.restored"));
    } catch (e) {
      toast.error(t("work:docs.errSave"), { description: String(e) });
    }
  };

  return (
    <>
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
            <div key={v.id} className="flex items-center gap-2 rounded px-2 py-1.5 text-xs hover:bg-accent">
              {/* La fila entera enseña qué cambió; restaurar sin haberlo
                  visto es restaurar a ciegas. */}
              <button
                type="button"
                className="min-w-0 flex-1 text-left"
                title={t("work:docs.seeChanges")}
                onClick={() => setViendo(v)}
              >
                <span className="block tabular-nums">{fechaYHora(v.createdAt)}</span>
                <span className="block truncate text-muted-foreground">{v.authorName}</span>
              </button>
              <Button size="icon-xs" variant="ghost" title={t("work:docs.restore")} onClick={() => void volver(v)}>
                <RotateCcw className="size-3" />
              </Button>
            </div>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      {viendo && (
        <VersionDiff version={viendo} current={current} onClose={() => setViendo(null)} onRestore={() => void volver(viendo)} />
      )}
    </>
  );
}

/**
 * Qué cambió desde una versión hasta ahora, línea a línea: en rojo lo que
 * había y ya no está, en verde lo que se escribió después. Es lo que se
 * pregunta antes de restaurar —«¿qué pierdo?»—, y la fecha sola no lo dice.
 */
function VersionDiff({
  version,
  current,
  onClose,
  onRestore,
}: {
  version: VersionRow;
  current: string;
  onClose: () => void;
  onRestore: () => void;
}) {
  const { t } = useT();
  const rows = useMemo(() => lineDiff(version.body, current), [version.body, current]);
  const { added, removed } = diffStats(rows);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-3xl gap-3">
        <DialogHeader>
          <DialogTitle className="text-sm">
            {t("work:docs.changesSince", { date: fechaYHora(version.createdAt) })}
          </DialogTitle>
        </DialogHeader>
        <p className="text-xs text-muted-foreground">
          {version.authorName && `${version.authorName} · `}
          {added + removed === 0 ? (
            t("work:docs.noChanges")
          ) : (
            <>
              <span className="text-emerald-600 dark:text-emerald-400">+{added}</span>{" "}
              <span className="text-red-600 dark:text-red-400">−{removed}</span>
            </>
          )}
        </p>
        <div className="max-h-[60vh] overflow-auto rounded-md border font-mono text-xs" aria-label={t("work:docs.diff")}>
          {rows.map((r, i) =>
            r.kind === "skip" ? (
              <div key={i} className="bg-muted/40 px-3 py-0.5 text-muted-foreground">
                {t("work:docs.unchangedLines", { count: r.count })}
              </div>
            ) : (
              <div
                key={i}
                data-kind={r.kind}
                className={cn(
                  "whitespace-pre-wrap break-words px-3",
                  r.kind === "add" && "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
                  r.kind === "del" && "bg-red-500/10 text-red-700 line-through decoration-red-500/40 dark:text-red-300",
                )}
              >
                <span className="mr-2 select-none text-muted-foreground">
                  {r.kind === "add" ? "+" : r.kind === "del" ? "−" : " "}
                </span>
                {r.text || " "}
              </div>
            ),
          )}
        </div>
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={onClose}>
            {t("work:docs.close")}
          </Button>
          <Button size="sm" onClick={onRestore} disabled={added + removed === 0}>
            <RotateCcw className="mr-1 size-3" /> {t("work:docs.restoreThis")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
