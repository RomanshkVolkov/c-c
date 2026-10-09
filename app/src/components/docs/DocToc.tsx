import { useEffect, useMemo, useRef, useState } from "react";
import { ListTree } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
 *
 * **Fijo al hacer scroll** (`sticky`): un índice que se queda arriba deja de
 * servir justo cuando el documento es lo bastante largo para necesitarlo. Lo
 * que hace scroll no es la ventana sino el contenedor del documento (lleva
 * `data-doc-scroll`), y entre los dos nada más tiene `overflow`, así que
 * `sticky top-0` se pega a él.
 *
 * **Al lado sólo en pantallas grandes (xl).** Por debajo se come ~250px que en
 * una tablet son el texto y las tablas; ahí se pliega a un botón que lo abre en
 * un menú, también fijo.
 */
export default function DocToc({ markdown }: { markdown: string }) {
  const { t } = useT();
  const headings = useMemo(() => headingsOf(markdown), [markdown]);
  const [activo, setActivo] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  // El primero visible manda. Sin esto habría que decidir entre varios a la vez
  // cuando la pantalla abarca dos secciones cortas.
  //
  // Contra el contenedor que hace scroll y no contra la ventana: con la
  // ventana, un título ya escondido bajo la cabecera del documento seguía
  // contando como visible.
  useEffect(() => {
    if (headings.length === 0) return;
    const root = ref.current?.closest("[data-doc-scroll]") ?? null;
    const obs = new IntersectionObserver(
      (entradas) => {
        const visible = entradas.find((e) => e.isIntersecting);
        if (visible) setActivo(visible.target.id);
      },
      { root, rootMargin: "-10% 0px -80% 0px" },
    );
    for (const h of headings) {
      const el = document.getElementById(h.id);
      if (el) obs.observe(el);
    }
    return () => obs.disconnect();
  }, [headings]);

  if (headings.length < 2) return null;

  const ir = (id: string) => document.getElementById(id)?.scrollIntoView({ block: "start" });

  return (
    <div ref={ref} className="contents">
      {/* Pantallas grandes: al lado, fijo. */}
      <nav
        aria-label={t("work:docs.onThisPage")}
        data-toc="side"
        className="sticky top-0 hidden max-h-[calc(100dvh-14rem)] w-54 shrink-0 self-start overflow-y-auto xl:block"
      >
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

      {/* Por debajo de xl: un botón fijo arriba a la derecha que no ocupa
          columna (ancho cero, el botón cuelga hacia dentro). */}
      <div data-toc="button" className="sticky top-0 z-10 w-0 shrink-0 self-start xl:hidden">
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                size="icon-sm"
                variant="outline"
                className="absolute right-0 top-0 bg-background/90 backdrop-blur"
                title={t("work:docs.onThisPage")}
                aria-label={t("work:docs.onThisPage")}
              >
                <ListTree className="size-4" />
              </Button>
            }
          />
          <DropdownMenuContent align="end" className="max-h-80 w-64 overflow-auto p-1">
            {headings.map((h) => (
              <DropdownMenuItem
                key={h.id}
                onClick={() => ir(h.id)}
                className={cn(
                  "text-xs",
                  h.level === 3 && "pl-5",
                  activo === h.id && "font-medium text-foreground",
                )}
              >
                {h.text}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}
