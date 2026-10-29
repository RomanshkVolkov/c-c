import { Gavel } from "lucide-react";
import { useNavigate } from "react-router-dom";

import { docHref } from "@/components/markdown/card-menu";
import { fecha } from "@/lib/fechas";
import { useT } from "@/lib/i18n";
import type { DecisionRef } from "@/types/task";

/**
 * Las decisiones que se aplican a una tarea (command-and-control-91): las que
 * salieron de ella y las que se enlazaron después. Una sustituida sigue aquí,
 * tachada: en una tarea, lo que se decidió en su día es parte de su historia.
 * Cada una abre su registro, donde está el porqué.
 */
export default function TaskDecisions({ decisions }: { decisions: DecisionRef[] }) {
  // Sin ninguna no se pinta nada, ni se pide el enrutador.
  return decisions.length === 0 ? null : <DecisionRows decisions={decisions} />;
}

function DecisionRows({ decisions }: { decisions: DecisionRef[] }) {
  const { t } = useT();
  const navigate = useNavigate();
  return (
    <section className="space-y-2" data-testid="task-decisions">
      <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{t("work:decisions.inTask")}</h3>
      <ul className="space-y-1">
        {decisions.map((d) => (
          <li key={d.id}>
            <button
              type="button"
              onClick={() => d.ownerKind && d.ownerId && navigate(docHref(d.ownerKind, d.ownerId, "decisions"))}
              data-superseded={d.supersededById ? "true" : undefined}
              className={"flex w-full items-center gap-2 rounded px-1 py-1 text-left text-sm hover:bg-muted" + (d.supersededById ? " line-through opacity-60" : "")}
            >
              <Gavel className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="truncate">{d.title}</span>
              <time className="ml-auto shrink-0 text-xs text-muted-foreground tabular-nums">{fecha(d.decidedAt)}</time>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
