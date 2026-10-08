import type { ReactNode } from "react";

/**
 * Un fragmento de la búsqueda, con lo encontrado resaltado.
 *
 * El servidor marca las coincidencias con `**` (`ts_headline`, ver
 * `repository/search.go`) y no con HTML a propósito: el texto sale de un
 * documento que escribió cualquiera, y pintarlo como HTML sería dejar que un
 * documento meta marcado en la paleta. Aquí se parte por la marca y cada trozo
 * va como texto; los impares son lo encontrado.
 */
export function highlightSnippet(snippet: string): ReactNode[] {
  return snippet.split("**").map((part, i) =>
    i % 2 === 1 ? (
      <mark key={i} className="rounded-sm bg-yellow-200/70 px-0.5 text-foreground dark:bg-yellow-500/30">
        {part}
      </mark>
    ) : (
      part
    ),
  );
}
