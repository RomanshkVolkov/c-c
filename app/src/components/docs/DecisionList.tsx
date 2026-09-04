import { Bot, CheckSquare, Gavel, Hash } from "lucide-react";

import { fecha } from "@/lib/fechas";
import { useT } from "@/lib/i18n";
import { useTasksStore } from "@/store/tasks.store";
import type { Decision } from "@/types/task";

/**
 * El registro de decisiones de un proyecto.
 *
 * No es markdown como las otras tres pestañas, y por eso tiene componente
 * propio: cada entrada lleva fecha, autor y **de dónde salió**, y eso en un
 * markdown suelto se escribe a mano, se escribe mal y se deja de escribir.
 *
 * Lo más reciente arriba: lo que se decidió la semana pasada es lo que
 * contradice lo que uno recuerda, y es lo que hay que ver primero.
 */

/** El enlace de vuelta. Lo que separa un registro de una lista de frases. */
function Procedencia({ d }: { d: Decision }) {
  const { t } = useT();
  const openTask = useTasksStore((s) => s.openTask);

  if (d.origin === "task" && d.originTaskId) {
    return (
      <button
        onClick={() => void openTask(d.originTaskId!).catch(() => {})}
        className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
      >
        <CheckSquare className="size-3" />
        {t("work:decisions.fromTask", { what: d.originTitle || d.originTaskId })}
      </button>
    );
  }
  if (d.origin === "message") {
    return (
      <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Hash className="size-3" />
        {t("work:decisions.fromMessage", { where: d.originTitle || "" })}
      </span>
    );
  }
  // «Se decidió aquí» también es una procedencia, y no la ausencia de una: dice
  // que no salió de ninguna discusión previa, que es un dato.
  return <span className="text-xs text-muted-foreground">{t("work:decisions.writtenHere")}</span>;
}

export default function DecisionList({ decisions }: { decisions: Decision[] }) {
  const { t } = useT();

  if (decisions.length === 0) {
    return (
      <div className="py-12 text-center">
        <Gavel className="mx-auto mb-2 size-5 text-muted-foreground" />
        <p className="text-sm text-muted-foreground">{t("work:decisions.empty")}</p>
        <p className="mx-auto mt-1 max-w-sm text-xs text-muted-foreground">
          {t("work:decisions.emptyWhy")}
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-[68ch] space-y-2">
      {decisions.map((d) => (
        <article key={d.id} className="rounded-[11px] border p-3">
          <header className="flex items-center gap-2 text-xs text-muted-foreground">
            <time className="tabular-nums">{fecha(d.decidedAt)}</time>
            <span>{d.authorName}</span>
            {/* Quién la escribió, cuando no la tecleó una persona.
                El registro no se puede borrar, así que quien lo lea dentro de un
                año tiene que poder distinguir lo que alguien escribió a mano de
                lo que un agente transcribió de un correo. Sin esto, las dos
                cosas se leen igual. */}
            {d.via === "mcp" && (
              <span className="flex items-center gap-1">
                <Bot className="size-3" />
                {t("work:decisions.viaAgent")}
              </span>
            )}
            {d.tag && (
              <span className="ml-auto rounded-full bg-muted px-2 py-0.5">{d.tag}</span>
            )}
          </header>
          <h3 className="mt-1 text-[15px] font-semibold">{d.title}</h3>
          {d.body && <p className="mt-1 whitespace-pre-wrap text-sm text-muted-foreground">{d.body}</p>}
          <footer className="mt-2 border-t pt-2">
            <Procedencia d={d} />
          </footer>
        </article>
      ))}
    </div>
  );
}
