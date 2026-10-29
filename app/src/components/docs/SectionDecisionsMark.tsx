import { Gavel } from "lucide-react";
import { useNavigate } from "react-router-dom";

import { docHref } from "@/components/markdown/card-menu";
import { Popover } from "@/components/ui/popover";
import { useT } from "@/lib/i18n";
import type { DocSection } from "@/types/task";

/**
 * La marca junto al título de una sección que sostiene alguna decisión
 * (command-and-control-91): cuántas, y al abrirla, cuáles. Cada una lleva a su
 * registro, que es donde está el porqué.
 *
 * Sin decisiones no se pinta nada: una marca en cada título sería ruido.
 */
export default function SectionDecisionsMark({ section }: { section: DocSection }) {
  return section.decisions?.length ? <Mark section={section} /> : null;
}

function Mark({ section }: { section: DocSection }) {
  const { t } = useT();
  const navigate = useNavigate();
  const ds = section.decisions ?? [];
  return (
    <Popover
      trigger={
        <button
          type="button"
          data-testid="section-decisions"
          aria-label={t("work:decisions.sectionMark", { count: ds.length })}
          title={t("work:decisions.sectionMark", { count: ds.length })}
          className="motion-press ml-2 inline-flex translate-y-[-2px] items-center gap-0.5 rounded-full border px-1.5 py-0.5 align-middle text-[11px] font-normal text-muted-foreground hover:text-foreground"
        >
          <Gavel className="size-3" />
          {ds.length}
        </button>
      }
      className="w-72"
    >
      <p className="px-2 py-1 text-xs text-muted-foreground">{t("work:decisions.sectionMark", { count: ds.length })}</p>
      {ds.map((d) => (
        <button
          key={d.id}
          type="button"
          onClick={() => d.ownerKind && d.ownerId && navigate(docHref(d.ownerKind, d.ownerId, "decisions"))}
          className="block w-full rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted"
        >
          {d.title}
        </button>
      ))}
    </Popover>
  );
}
