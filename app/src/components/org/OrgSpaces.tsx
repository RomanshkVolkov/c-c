import { useT } from "@/lib/i18n";
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Plus } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useTasksStore } from "@/store/tasks.store";
import { useReportsStore } from "@/store/reports.store";
import { useOrgsStore } from "@/store/orgs.store";
import { usePrompt } from "@/components/PromptDialog";
import type { FolderTree, ListSummary, SpaceTree } from "@/types/task";
import { iniciales } from "@/lib/desde";

/**
 * Los espacios de la organización, como fichas y no como árbol.
 *
 * El navegador ya deja recorrerlos; lo que no puede decir de un vistazo es cuán
 * grande es cada uno y —lo que de verdad importa— **en cuál puede ver un
 * cliente**. Eso es una propiedad del sitio entero, así que va en la pantalla
 * de la organización, al lado de quiénes son sus personas.
 *
 * Las caras de cada ficha son quien **carga trabajo abierto** ahí. No hay
 * miembros por espacio —quien está en la organización llega a todos, salvo el
 * cliente atado a su canal— así que repetir la misma plantilla en cada ficha
 * sería ruido con aspecto de información; lo que cada sitio tiene de suyo es
 * quién lo sostiene.
 */

/** Todo lo que cuelga de un espacio, aplanado: las carpetas anidan. */
function aplanar(fs: FolderTree[]): { folders: number; lists: ListSummary[] } {
  return fs.reduce(
    (n, f) => {
      const dentro = aplanar(f.folders ?? []);
      return {
        folders: n.folders + 1 + dentro.folders,
        lists: [...n.lists, ...f.lists, ...dentro.lists],
      };
    },
    { folders: 0, lists: [] as ListSummary[] },
  );
}

export default function OrgSpaces({ canManage = false }: { canManage?: boolean }) {
  const { t } = useT();
  const navigate = useNavigate();
  const prompt = usePrompt();
  const tree = useTasksStore((s) => s.tree);
  const fetchTree = useTasksStore((s) => s.fetchTree);
  const createSpace = useTasksStore((s) => s.createSpace);
  const projects = useReportsStore((s) => s.projects);
  const fetchProjects = useReportsStore((s) => s.fetchProjects);
  const orgId = useOrgsStore((s) => s.currentOrgId);
  const [creando, setCreando] = useState(false);

  useEffect(() => {
    fetchTree().catch(() => {});
    fetchProjects().catch(() => {});
  }, [fetchTree, fetchProjects]);

  const nombreDe = useMemo(() => {
    const by = new Map(projects.map((p) => [p.id, p.name]));
    return (id?: string) => (id ? (by.get(id) ?? "a client") : "");
  }, [projects]);

  const nuevo = async () => {
    if (!orgId) return;
    // Y no `window.prompt`: en la webview de Tauri sale un cuadro nativo sin
    // tema y titulado «tauri://localhost».
    const nombre = await prompt({ title: t("common:misc.newSpace"), label: t("common:misc.name") });
    if (!nombre?.trim()) return;
    setCreando(true);
    try {
      await createSpace(orgId, nombre.trim());
    } catch (e) {
      toast.error(t("common:misc.errCreateSpace"), {
        description: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setCreando(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-sm text-muted-foreground">
          {t("common:misc.spacesLead")}
        </p>
        {canManage && (
          <Button size="sm" variant="outline" className="ml-auto" onClick={nuevo} disabled={creando}>
            <Plus className="mr-1 size-4" /> New space
          </Button>
        )}
      </div>

      {tree.length === 0 ? (
        <p className="rounded-xl border border-dashed px-3 py-8 text-center text-sm text-muted-foreground">
          {t("common:misc.noSpaces")}
        </p>
      ) : (
        <ul className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(290px,1fr))]">
          {tree.map((sp: SpaceTree) => {
            const dentro = aplanar(sp.folders);
            const listas = [...sp.lists, ...dentro.lists];
            const todas = listas.reduce((n, l) => n + (l.taskCount ?? 0), 0);
            const abiertas = listas.reduce((n, l) => n + (l.openCount ?? 0), 0);
            // Una lista puede traer su propia atadura aunque el espacio no
            // tenga ninguna, así que «esto no lo ve nadie» tiene que mirar las
            // dos: decir que un espacio es interno cuando una de sus listas no
            // lo es sería el peor error posible en esta pantalla.
            const listaVisible = listas.some((l) => l.projectId);
            const visible = !!sp.projectId || listaVisible;
            const gente = sp.people ?? [];

            return (
              <li
                key={sp.id}
                className="flex flex-col gap-2.5 rounded-xl border bg-card px-3.5 py-3"
              >
                <div className="flex items-center gap-2">
                  <span
                    className="size-2.5 shrink-0 rounded-full"
                    style={{ backgroundColor: sp.color || "var(--primary)" }}
                  />
                  <span className="min-w-0 flex-1 truncate font-semibold">{sp.name}</span>
                </div>

                {/* Dos columnas fijas y no filas sueltas: con el ancho de la
                    etiqueta suelto, los valores de cada ficha caen en un sitio
                    distinto y la rejilla deja de leerse en vertical. */}
                <dl className="grid grid-cols-[78px_1fr] gap-x-2.5 gap-y-1.5 text-xs">
                  <dt className="text-muted-foreground">{t("common:misc.channel")}</dt>
                  <dd className="min-w-0 truncate">#{sp.name}</dd>

                  <dt className="text-muted-foreground">{t("common:misc.tasks")}</dt>
                  <dd className="min-w-0 truncate text-muted-foreground">
                    {todas} · {abiertas} open
                  </dd>

                  <dt className="text-muted-foreground">{t("common:misc.access")}</dt>
                  <dd className="min-w-0 truncate text-muted-foreground">
                    {visible
                      ? sp.projectId
                        ? nombreDe(sp.projectId)
                        : "a client sees part of it"
                      : "the whole organization"}
                  </dd>
                </dl>

                <div className="flex items-center gap-1.5">
                  {gente.slice(0, 4).map((p) => (
                    <span
                      key={p.userId}
                      title={`@${p.username}`}
                      className="flex size-6 items-center justify-center rounded-full bg-muted text-[10px] font-medium"
                    >
                      {iniciales(p.username)}
                    </span>
                  ))}
                  {gente.length > 4 && (
                    <span className="text-[11px] text-muted-foreground">+{gente.length - 4}</span>
                  )}
                  {gente.length === 0 && (
                    <span className="text-[11px] text-muted-foreground">nobody is on it</span>
                  )}
                  <button
                    className="ml-auto shrink-0 text-[11.5px] text-primary hover:underline"
                    onClick={() => navigate(`/tasks?space=${sp.id}`)}
                  >
                    {t("common:misc.manage")}
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
