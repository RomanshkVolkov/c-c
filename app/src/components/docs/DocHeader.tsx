import { useEffect, useState } from "react";
import { CheckCircle2, Clock, Pin, UserRound } from "lucide-react";
import { toast } from "sonner";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { usePrompt } from "@/components/PromptDialog";
import { fecha } from "@/lib/fechas";
import { useT } from "@/lib/i18n";
import { nombreDe } from "@/lib/nombres";
import { cn } from "@/lib/utils";
import { usePeopleStore } from "@/store/people.store";
import { useTasksStore } from "@/store/tasks.store";
import type { Doc } from "@/types/task";

/**
 * Quién responde de un documento y cuándo se confirmó por última vez.
 *
 * Las dos preguntas que un markdown suelto no sabe contestar, y las que deciden
 * si alguien se fía de lo que lee. Un runbook sin dueño no está mal escrito: es
 * que nadie va a arreglarlo cuando deje de funcionar.
 *
 * «Owner» en pantalla, `maintainer` en el modelo — ver el comentario de `Doc`.
 */

/** Días desde una fecha, para el texto del aviso. */
function diasDesde(iso: string | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return Math.floor((Date.now() - t) / 86_400_000);
}

/**
 * El desplegable de responsable, en dos sitios.
 *
 * Extraído porque el aviso de frescura también lo lleva: cuando algo lleva
 * meses sin revisar, la razón más común es que quien lo escribió ya no está, y
 * mandar a la persona a buscar la píldora de arriba es pedirle un paso de más
 * justo en el momento en que se le está pidiendo un favor.
 */
function OwnerPicker({
  doc,
  gente,
  disabled,
  onPick,
  render,
}: {
  doc: Doc;
  gente: { id: string; username: string; name?: string }[];
  disabled: boolean;
  onPick: (id: string) => void;
  render: React.ReactElement;
}) {
  const { t } = useT();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger disabled={disabled} render={render} />
      <DropdownMenuContent align="start" className="max-h-72 overflow-auto">
        {doc.maintainerId && (
          <DropdownMenuItem onClick={() => onPick("")}>
            {t("work:docs.clearOwner")}
          </DropdownMenuItem>
        )}
        {gente.map((p) => (
          <DropdownMenuItem key={p.id} onClick={() => onPick(p.id)}>
            {nombreDe(p)}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export default function DocHeader({ doc }: { doc: Doc }) {
  const { t } = useT();
  const patchDoc = useTasksStore((s) => s.patchDoc);
  const fetchPeople = usePeopleStore((s) => s.fetchPeople);
  const byOrg = usePeopleStore((s) => s.byOrg);
  const gente = byOrg[doc.orgId] ?? [];
  const [guardando, setGuardando] = useState(false);
  const prompt = usePrompt();

  useEffect(() => {
    fetchPeople(doc.orgId).catch(() => {});
  }, [doc.orgId, fetchPeople]);

  const aplicar = async (campos: Parameters<typeof patchDoc>[0]) => {
    setGuardando(true);
    try {
      await patchDoc(campos);
    } catch (e) {
      toast.error(t("work:docs.errSave"), { description: String(e) });
    } finally {
      setGuardando(false);
    }
  };

  // El aviso cuenta desde la última revisión y, si nunca la hubo, desde que se
  // escribió — igual que la regla del servidor, para que el número que se lee y
  // el color que se ve digan lo mismo.
  const dias = diasDesde(doc.reviewedAt ?? doc.updatedAt);
  const elegir = (id: string) => void aplicar({ maintainerId: id });

  const fijarLinea = async () => {
    const linea = await prompt({
      title: t("work:docs.pinTitle"),
      description: t("work:docs.pinWhy"),
      label: t("work:docs.pinLabel"),
      defaultValue: doc.pinnedLine ?? "",
      // Vaciar el campo es cómo se quita el banner. Sin esto, una vez puesto no
      // habría forma de retirarlo.
      allowEmpty: true,
    });
    if (linea === null) return;
    await aplicar({ pinnedLine: linea });
  };

  return (
    <div className="shrink-0 border-b px-4 py-2">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <OwnerPicker
          doc={doc}
          gente={gente}
          disabled={guardando}
          onPick={elegir}
          render={
            <button
              className={cn(
                "flex items-center gap-1.5 rounded-full border px-2 py-0.5",
                doc.maintainerId ? "text-foreground" : "border-dashed text-muted-foreground",
              )}
            >
              <UserRound className="size-3" />
              {doc.maintainerName || t("work:docs.noOwner")}
            </button>
          }
        />

        {/* El chip dice la fecha, no «hace X»: «revisado el 3 de junio» se puede
            comprobar contra lo que uno recuerda; «hace 91 días» no. */}
        <span
          className={cn(
            "flex items-center gap-1.5 rounded-full px-2 py-0.5",
            doc.stale
              ? "bg-amber-500/10 text-amber-500"
              : "bg-emerald-500/10 text-emerald-500",
          )}
        >
          {doc.stale ? <Clock className="size-3" /> : <CheckCircle2 className="size-3" />}
          {doc.reviewedAt
            ? t("work:docs.reviewedOn", { date: fecha(doc.reviewedAt) })
            : t("work:docs.neverReviewed")}
        </span>

        {/* La línea fijada se edita desde aquí y se ve sobre el tablero: es lo
            que hay que saber **antes** de coger una tarjeta, así que vive donde
            se cogen las tarjetas y se escribe donde se documenta el proyecto. */}
        <button
          disabled={guardando}
          onClick={() => void fijarLinea()}
          className="ml-auto flex min-w-0 items-center gap-1.5 text-muted-foreground hover:text-foreground"
        >
          <Pin className="size-3 shrink-0" />
          <span className="truncate">
            {doc.pinnedLine || t("work:docs.pinEmpty")}
          </span>
        </button>
      </div>

      {/* El aviso dice **por qué** está sin revisar, no sólo cuántos días lleva:
          un número no le pide nada a nadie, y «nadie lo ha confirmado desde que
          se escribió» sí. */}
      {doc.stale && (
        <div className="mt-2 rounded-md border border-amber-500/30 bg-amber-500/[.07] px-3 py-2 text-xs">
          <p className="text-foreground">
            {doc.reviewedAt
              ? t("work:docs.staleSinceReview", { days: dias ?? 0 })
              : t("work:docs.staleNeverReviewed", { days: dias ?? 0 })}
          </p>
          <div className="mt-2 flex gap-2">
            <Button
              size="sm"
              variant="outline"
              className="h-6 text-xs"
              disabled={guardando}
              onClick={() => void aplicar({ reviewed: true })}
            >
              {t("work:docs.markReviewed")}
            </Button>
            <OwnerPicker
              doc={doc}
              gente={gente}
              disabled={guardando}
              onPick={elegir}
              render={
                <Button size="sm" variant="ghost" className="h-6 text-xs">
                  {t("work:docs.reassignOwner")}
                </Button>
              }
            />
          </div>
        </div>
      )}
    </div>
  );
}
