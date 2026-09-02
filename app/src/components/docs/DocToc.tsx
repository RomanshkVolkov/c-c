import { useEffect, useMemo, useState } from "react";

import { headingsOf } from "@/lib/headings";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n";

/**
 * El índice de una sección, sacado de sus encabezados.
 *
 * Del markdown y no del DOM: leerlo del texto funciona antes de que se pinte,
 * no depende de cómo el renderizador ponga los `id`, y sobre todo **no obliga a
 * tocar `Markdown`**, que sirve también a tareas y notas.
 *
 * Sólo en Overview y Runbook. En Decisiones —una lista de entradas— y en
 * Enlaces —cuatro grupos cortos— un índice repetiría lo que ya se ve entero.
 */
export default function DocToc({ markdown }: { markdown: string }) {
  const { t } = useT();
  const headings = useMemo(() => headingsOf(markdown), [markdown]);
  const [activo, setActivo] = useState<string | null>(null);

  // El primero visible manda. Sin esto habría que decidir entre varios a la vez
  // cuando la pantalla abarca dos secciones cortas.
  useEffect(() => {
    if (headings.length === 0) return;
    const obs = new IntersectionObserver(
      (entradas) => {
        const visible = entradas.find((e) => e.isIntersecting);
        if (visible) setActivo(visible.target.id);
      },
      { rootMargin: "-10% 0px -80% 0px" },
    );
    for (const h of headings) {
      const el = document.getElementById(h.id);
      if (el) obs.observe(el);
    }
    return () => obs.disconnect();
  }, [headings]);

  if (headings.length < 2) return null;

  return (
    <nav className="hidden w-54 shrink-0 self-start lg:block">
      <p className="mb-2 text-[11px] uppercase tracking-wide text-muted-foreground">
        {t("work:docs.onThisPage")}
      </p>
      <ul className="space-y-0.5 border-l">
        {headings.map((h) => (
          <li key={h.id}>
            <a
              href={`#${h.id}`}
              className={cn(
                "-ml-px block border-l-2 py-1 pr-2 text-xs hover:text-foreground",
                h.level === 3 ? "pl-5" : "pl-3",
                activo === h.id
                  ? "border-primary font-medium text-foreground"
                  : "border-transparent text-muted-foreground",
              )}
            >
              {h.text}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
