import { useState } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Un JSON como árbol de clave y valor, plegable.
 *
 * Es cómo se lee la ficha de un dispositivo sin saber qué app la manda: antes
 * era un `<pre>` con el JSON crudo, y encontrar «la batería» era leerlo entero.
 * `highlight` son rutas con puntos que hay que marcar —las de las reglas que se
 * incumplen—, y sus ramas salen abiertas para que se vean sin buscarlas.
 */
export default function KeyValueTree({
  value,
  highlight = {},
  depthOpen = 1,
}: {
  value: unknown;
  /** ruta → gravedad, para pintar la fila. */
  highlight?: Record<string, "warn" | "error">;
  /** Hasta qué profundidad sale abierto. */
  depthOpen?: number;
}) {
  if (!isObject(value)) return <Leaf value={value} />;
  return (
    <ul className="space-y-px font-mono text-xs">
      {Object.entries(value).map(([k, v]) => (
        <Node key={k} name={k} value={v} path={k} depth={0} highlight={highlight} depthOpen={depthOpen} />
      ))}
    </ul>
  );
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function Node({
  name,
  value,
  path,
  depth,
  highlight,
  depthOpen,
}: {
  name: string;
  value: unknown;
  path: string;
  depth: number;
  highlight: Record<string, "warn" | "error">;
  depthOpen: number;
}) {
  const marked = highlight[path];
  const holdsMark = Object.keys(highlight).some((p) => p.startsWith(path + "."));
  const [open, setOpen] = useState(depth < depthOpen || holdsMark);
  const tone = marked === "error" ? "bg-error/10 text-error" : marked === "warn" ? "bg-warning/10 text-warning" : "";

  if (!isObject(value)) {
    return (
      <li className={cn("flex gap-2 rounded px-1", tone)} style={{ paddingLeft: depth * 12 + 16 }} data-path={path}>
        <span className="shrink-0 text-muted-foreground">{name}</span>
        <span className="min-w-0 break-all">
          <Leaf value={value} />
        </span>
      </li>
    );
  }
  const entries = Object.entries(value);
  return (
    <li data-path={path}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className={cn("flex w-full items-center gap-1 rounded px-1 text-left hover:bg-accent/50", tone)}
        style={{ paddingLeft: depth * 12 }}
      >
        <ChevronRight className={cn("size-3 shrink-0 transition-transform", open && "rotate-90")} />
        <span className="text-muted-foreground">{name}</span>
        {!open && (
          <span className="text-muted-foreground/60">
            {Array.isArray(value) ? `[${entries.length}]` : `{${entries.length}}`}
          </span>
        )}
      </button>
      {open && (
        <ul className="space-y-px">
          {entries.map(([k, v]) => (
            <Node key={k} name={k} value={v} path={`${path}.${k}`} depth={depth + 1} highlight={highlight} depthOpen={depthOpen} />
          ))}
        </ul>
      )}
    </li>
  );
}

function Leaf({ value }: { value: unknown }) {
  if (value === null || value === undefined) return <span className="text-muted-foreground/60">null</span>;
  if (typeof value === "boolean") return <span className={value ? "text-success" : "text-muted-foreground"}>{String(value)}</span>;
  if (typeof value === "number") return <span className="text-info">{value}</span>;
  return <span>{String(value)}</span>;
}
