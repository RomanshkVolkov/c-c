import { useMemo, useState } from "react";
import { AlertCircle, FileText, Plus } from "lucide-react";

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Input } from "@/components/ui/input";
import { fecha } from "@/lib/fechas";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { useTasksStore } from "@/store/tasks.store";
import { docKey, type DocMark, type DocOwnerKind } from "@/types/task";

/**
 * Toda la documentación de la organización, en una tabla.
 *
 * Dos decisiones que la hacen útil y que no son obvias:
 *
 * **La ruta completa, no el nombre.** En esta organización casi todas las listas
 * se llaman igual —«tasks», «bugs»—, así que una columna con el nombre suelto no
 * identifica nada. `Portento › Backend › tasks` sí.
 *
 * **Ordenada por revisión, no alfabéticamente.** Lo que hace falta saber al
 * abrir esto es qué está desactualizado, y una tabla alfabética esconde
 * exactamente eso. Lo más viejo arriba, y lo que nunca se revisó, primero de
 * todo.
 *
 * Se arma con lo que ya está en memoria: el árbol trae nombres, rutas y
 * recuentos, y el índice de documentos trae dueño y frescura. No hace ninguna
 * petición propia.
 */

interface Fila {
  kind: DocOwnerKind;
  id: string;
  name: string;
  path: string;
  tasks?: number;
  mark?: DocMark;
}

/** Lo que nunca se revisó va primero: es lo que menos se sabe. */
function orden(a: Fila, b: Fila): number {
  const ra = a.mark?.reviewedAt;
  const rb = b.mark?.reviewedAt;
  if (!ra && !rb) return a.path.localeCompare(b.path);
  if (!ra) return -1;
  if (!rb) return 1;
  return ra.localeCompare(rb);
}

export default function DocIndex() {
  const { t } = useT();
  const tree = useTasksStore((s) => s.tree);
  const docIndex = useTasksStore((s) => s.docIndex);
  const openDoc = useTasksStore((s) => s.openDoc);
  const [filtro, setFiltro] = useState("");
  const [soloViejos, setSoloViejos] = useState(false);

  const { conDoc, sinDoc } = useMemo(() => {
    const todas: Fila[] = [];
    for (const sp of tree) {
      for (const l of sp.lists) {
        todas.push({
          kind: "list", id: l.id, name: l.name,
          path: sp.name, tasks: l.taskCount,
          mark: docIndex[docKey("list", l.id)],
        });
      }
      for (const f of sp.folders) {
        for (const l of f.lists) {
          todas.push({
            kind: "list", id: l.id, name: l.name,
            path: `${sp.name} › ${f.name}`, tasks: l.taskCount,
            mark: docIndex[docKey("list", l.id)],
          });
        }
      }
      // Espacios y carpetas sólo cuando **tienen** documentación: una carpeta
      // sin documento no es una tarea pendiente, una lista sin documento sí.
      const marcaEspacio = docIndex[docKey("space", sp.id)];
      if (marcaEspacio) {
        todas.push({ kind: "space", id: sp.id, name: sp.name, path: "—", mark: marcaEspacio });
      }
      for (const f of sp.folders) {
        const m = docIndex[docKey("folder", f.id)];
        if (m) todas.push({ kind: "folder", id: f.id, name: f.name, path: sp.name, mark: m });
      }
    }
    const q = filtro.trim().toLowerCase();
    const visible = todas.filter(
      (r) => !q || r.name.toLowerCase().includes(q) || r.path.toLowerCase().includes(q),
    );
    return {
      conDoc: visible
        .filter((r) => r.mark && (!soloViejos || r.mark.stale || !r.mark.maintainerId))
        .sort(orden),
      sinDoc: visible.filter((r) => !r.mark).sort((a, b) => a.path.localeCompare(b.path)),
    };
  }, [tree, docIndex, filtro, soloViejos]);

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
        <FileText className="size-4 shrink-0 text-muted-foreground" />
        <h1 className="text-sm font-medium">{t("work:docIndex.title")}</h1>
        <Input
          value={filtro}
          onChange={(e) => setFiltro(e.target.value)}
          placeholder={t("work:docIndex.filter")}
          className="ml-2 h-7 max-w-56 text-xs"
        />
        <button
          onClick={() => setSoloViejos((v) => !v)}
          className={cn(
            "rounded px-2 py-1 text-xs",
            soloViejos ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground",
          )}
        >
          {t("work:docIndex.needsAttention")}
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-auto p-4">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("work:docIndex.document")}</TableHead>
              <TableHead>{t("work:docIndex.where")}</TableHead>
              <TableHead>{t("work:docIndex.owner")}</TableHead>
              <TableHead>{t("work:docIndex.lastReviewed")}</TableHead>
              <TableHead className="text-right">{t("work:docIndex.tasks")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {conDoc.map((r) => (
              <TableRow
                key={`${r.kind}:${r.id}`}
                className="cursor-pointer"
                onClick={() => void openDoc(r.kind, r.id, r.name).catch(() => {})}
              >
                <TableCell className="font-medium">{r.name}</TableCell>
                <TableCell className="text-muted-foreground">{r.path}</TableCell>
                <TableCell>
                  {r.mark?.maintainerName ? (
                    r.mark.maintainerName
                  ) : (
                    // El único rojo de esta tabla, y sólo aquí: un documento sin
                    // dueño no está mal escrito — es que nadie va a arreglarlo
                    // cuando deje de funcionar, y eso no se ve desde dentro.
                    <span className="flex items-center gap-1 text-destructive">
                      <AlertCircle className="size-3" />
                      {t("work:docs.noOwner")}
                    </span>
                  )}
                </TableCell>
                <TableCell className={cn("tabular-nums", r.mark?.stale && "text-amber-500")}>
                  {r.mark?.reviewedAt ? fecha(r.mark.reviewedAt) : t("work:docs.neverReviewed")}
                </TableCell>
                <TableCell className="text-right tabular-nums text-muted-foreground">
                  {r.tasks ?? ""}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>

        {conDoc.length === 0 && (
          <p className="py-8 text-center text-sm text-muted-foreground">
            {t("work:docIndex.nothing")}
          </p>
        )}

        {/* Al pie y no escondidas: son las que hay que arreglar, y el enlace
            lleva directo a las plantillas en vez de a un cuadro vacío. */}
        {sinDoc.length > 0 && (
          <section className="mt-8">
            <h2 className="mb-2 text-xs font-medium text-muted-foreground">
              {t("work:docIndex.undocumented", { count: sinDoc.length })}
            </h2>
            <div className="flex flex-wrap gap-1.5">
              {sinDoc.map((r) => (
                <button
                  key={r.id}
                  onClick={() => void openDoc("list", r.id, r.name).catch(() => {})}
                  className="flex items-center gap-1 rounded-full border border-dashed px-2 py-0.5 text-xs text-muted-foreground hover:text-foreground"
                >
                  <Plus className="size-3" />
                  {r.path} › {r.name}
                </button>
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
