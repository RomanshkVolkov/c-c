import { Skeleton } from "@/components/ui/skeleton";

/**
 * Lo que se ve mientras carga una pantalla: su forma, con brillo.
 *
 * Un aspa girando no dice nada de lo que viene; el hueco con la forma que va a
 * tener sí, y la pantalla no salta cuando llega. El texto de carga sigue ahí
 * para un lector de pantalla (`label`), sólo que no se pinta.
 */
function Loading({ label, children, className }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <div role="status" className={className}>
      <span className="sr-only">{label}</span>
      <div aria-hidden>{children}</div>
    </div>
  );
}

/** Un tablero: tres columnas con tarjetas fantasma de alturas distintas. */
export function BoardSkeleton({ label }: { label: string }) {
  const cards = [[3, 2, 2], [2, 3], [2, 2, 3, 2]];
  return (
    <Loading label={label} className="flex h-full gap-3 overflow-hidden p-4">
      <div className="flex gap-3">
        {cards.map((col, i) => (
          <div key={i} className="w-72 shrink-0 space-y-2 rounded-lg border bg-sunken p-2">
            <div className="flex items-center gap-2 px-1 py-1">
              <Skeleton className="size-2 rounded-full" />
              <Skeleton className="h-3 w-20" />
              <Skeleton className="h-3 w-5 rounded-full" />
            </div>
            {col.map((lines, j) => (
              <div key={j} className="space-y-2 rounded-md border bg-raised p-2.5">
                {Array.from({ length: lines - 1 }, (_, k) => (
                  <Skeleton key={k} className={k === 0 ? "h-3 w-11/12" : "h-3 w-2/3"} />
                ))}
                <div className="flex items-center gap-2 pt-1">
                  <Skeleton className="h-4 w-14 rounded-full" />
                  <Skeleton className="ml-auto h-3 w-8" />
                </div>
              </div>
            ))}
          </div>
        ))}
      </div>
    </Loading>
  );
}

/** Un documento: un título y párrafos a la medida de lectura. */
export function DocSkeleton({ label }: { label: string }) {
  return (
    <Loading label={label} className="mx-auto max-w-3xl space-y-6 p-6">
      <Skeleton className="h-6 w-1/2" />
      {[4, 3, 5].map((lines, i) => (
        <div key={i} className="space-y-2">
          {Array.from({ length: lines }, (_, k) => (
            <Skeleton key={k} className={k === lines - 1 ? "h-3 w-3/5" : "h-3 w-full"} />
          ))}
        </div>
      ))}
    </Loading>
  );
}

/** Un hilo: mensajes con avatar, de anchos distintos. */
export function MessagesSkeleton({ label }: { label: string }) {
  const widths = ["w-2/3", "w-1/2", "w-3/4", "w-2/5", "w-3/5"];
  return (
    <Loading label={label} className="space-y-4 pt-2">
      {widths.map((w, i) => (
        <div key={i} className="flex items-start gap-2">
          <Skeleton className="size-7 shrink-0 rounded-full" />
          <div className="flex-1 space-y-1.5">
            <Skeleton className="h-3 w-24" />
            <Skeleton className={`h-3 ${w}`} />
          </div>
        </div>
      ))}
    </Loading>
  );
}

/** Filas de una tabla o una lista. */
export function RowsSkeleton({ label, rows = 4, className }: { label: string; rows?: number; className?: string }) {
  return (
    <Loading label={label} className={className ?? "space-y-2 py-2"}>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center gap-3 rounded-md border p-3">
          <Skeleton className="size-6 rounded-full" />
          <Skeleton className="h-3 w-1/3" />
          <Skeleton className="ml-auto h-3 w-16" />
        </div>
      ))}
    </Loading>
  );
}
