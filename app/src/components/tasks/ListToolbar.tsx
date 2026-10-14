import type { ReactNode } from "react";

/**
 * La fila de debajo del nombre de una lista: sus cuatro vistas a la izquierda
 * y, a la derecha, lo que filtra la vista que se está mirando.
 *
 * La comparten el tablero y la documentación de una lista, para que pasar de
 * una vista a otra no mueva las pestañas de sitio. Se desliza antes que
 * recortarse: en una ventana estrecha lo que se perdería son los filtros, sin
 * ninguna señal de que estuvieran ahí.
 */
export default function ListToolbar({ views, children }: { views: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex h-9 shrink-0 items-stretch gap-4 overflow-x-auto overflow-y-hidden border-b px-4">
      {views}
      {children && <div className="ml-auto flex shrink-0 items-center gap-2">{children}</div>}
    </div>
  );
}
