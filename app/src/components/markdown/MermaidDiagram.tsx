import { useEffect, useId, useState } from "react";
import { AlertTriangle } from "lucide-react";

import { useT } from "@/lib/i18n";
import { useThemeStore } from "@/store/theme.store";

/**
 * Un bloque ```mermaid dibujado como diagrama.
 *
 * Hasta el 9-oct-2026 no había soporte: un diagrama escrito en la
 * documentación —flujos, secuencias, arquitecturas, lo que más se escribe en
 * Mermaid— se veía como el código que lo describe.
 *
 * - **La biblioteca se carga al aparecer el primer diagrama** (`import()`), no
 *   con la app: pesa varios cientos de KB y la inmensa mayoría de las pantallas
 *   no tiene ninguno.
 * - **`securityLevel: "strict"`**: el texto lo escribió cualquiera, y Mermaid
 *   en modo estricto limpia las etiquetas (DOMPurify) y no deja enlaces con
 *   `javascript:` ni clics que ejecuten código. Lo que devuelve es un SVG ya
 *   saneado, y sólo eso se mete en la página.
 * - **Si el diagrama tiene un error**, se enseña el código con lo que falló, en
 *   vez de un hueco: quien lo escribió necesita ver dónde se equivocó.
 * - Sigue el tema de la app (claro u oscuro) al dibujarse.
 *
 * La CSP del escritorio y la de la web ya permiten lo que hace falta (estilos
 * en línea, sin `eval`): ver `desktop-csp.test.ts`.
 */
export default function MermaidDiagram({ source }: { source: string }) {
  const { t } = useT();
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const tema = useThemeStore((s) => s.resolved);
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let vivo = true;
    setError(null);
    (async () => {
      try {
        const mermaid = (await import("mermaid")).default;
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          theme: tema === "dark" ? "dark" : "default",
          fontFamily: "inherit",
        });
        const { svg } = await mermaid.render(`mermaid-${id}-${tema}`, source);
        if (vivo) setSvg(svg);
      } catch (e) {
        if (vivo) {
          setSvg(null);
          setError(String((e as Error)?.message ?? e));
        }
      }
    })();
    return () => {
      vivo = false;
    };
  }, [source, tema, id]);

  if (error) {
    return (
      <div className="my-3 rounded-md border border-amber-500/40" data-mermaid="error">
        <p className="flex items-center gap-1.5 border-b border-amber-500/40 bg-amber-500/10 px-3 py-1.5 text-xs text-amber-700 dark:text-amber-300">
          <AlertTriangle className="size-3.5 shrink-0" />
          {t("common:last.mermaidError")}
          <span className="truncate font-mono text-[11px] opacity-80">{error.split("\n")[0]}</span>
        </p>
        <pre className="m-0 overflow-x-auto p-3 text-xs">
          <code>{source}</code>
        </pre>
      </div>
    );
  }

  if (!svg) {
    // Mientras se dibuja, el código atenuado: ocupa su sitio y no salta.
    return (
      <pre className="my-3 overflow-x-auto rounded-md p-3 text-xs opacity-50" data-mermaid="loading">
        <code>{source}</code>
      </pre>
    );
  }

  return (
    <div
      className="my-3 overflow-x-auto rounded-md border bg-background p-3 [&_svg]:mx-auto [&_svg]:h-auto [&_svg]:max-w-none"
      data-mermaid="diagram"
      role="img"
      aria-label={t("common:last.mermaidDiagram")}
      // El SVG ya viene saneado por Mermaid en modo estricto (ver arriba).
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
