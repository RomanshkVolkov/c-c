import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Eye, Hash, MessageSquare, Plus } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useTasksStore } from "@/store/tasks.store";
import { useReportsStore } from "@/store/reports.store";
import { useOrgsStore } from "@/store/orgs.store";
import { usePrompt } from "@/components/PromptDialog";
import type { FolderTree, ListSummary, SpaceTree } from "@/types/task";

/**
 * Los espacios de la organización, como fichas y no como árbol.
 *
 * El navegador ya deja recorrerlos; lo que no puede decir de un vistazo es cuán
 * grande es cada uno y —lo que de verdad importa— **en cuál puede ver un
 * cliente**. Eso es una propiedad del sitio entero, así que va en la pantalla
 * de la organización, al lado de quiénes son sus personas.
 *
 * Sin avatares por ficha, a diferencia del prototipo: hoy no hay pertenencia
 * por espacio —quien está en la organización llega a todos, salvo el cliente
 * atado a su canal— así que las mismas caras repetidas en cada ficha serían
 * ruido con aspecto de información.
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
    const nombre = await prompt({ title: "New space", label: "Name" });
    if (!nombre?.trim()) return;
    setCreando(true);
    try {
      await createSpace(orgId, nombre.trim());
    } catch (e) {
      toast.error("Could not create the space", {
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
          Who sees each space, and which channel it answers to.
        </p>
        {canManage && (
          <Button size="sm" variant="outline" className="ml-auto" onClick={nuevo} disabled={creando}>
            <Plus className="mr-1 size-4" /> New space
          </Button>
        )}
      </div>

      {tree.length === 0 ? (
        <p className="rounded-xl border border-dashed px-3 py-8 text-center text-sm text-muted-foreground">
          No spaces in this organization.
        </p>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {tree.map((sp: SpaceTree) => {
            const dentro = aplanar(sp.folders);
            const listas = [...sp.lists, ...dentro.lists];
            const tareas = listas.reduce((n, l) => n + (l.taskCount ?? 0), 0);
            // Una lista puede traer su propia atadura aunque el espacio no
            // tenga ninguna, así que «esto no lo ve nadie» tiene que mirar las
            // dos: decir que un espacio es interno cuando una de sus listas no
            // lo es sería el peor error posible en esta pantalla.
            const listaVisible = listas.some((l) => l.projectId);
            const visible = !!sp.projectId || listaVisible;

            return (
              <li key={sp.id} className="flex flex-col gap-3 rounded-xl border bg-card p-4">
                <div className="flex items-center gap-2">
                  <span
                    className="size-2.5 shrink-0 rounded-sm"
                    style={{ backgroundColor: sp.color || "var(--primary)" }}
                  />
                  <span className="min-w-0 flex-1 truncate font-medium">{sp.name}</span>
                </div>

                <dl className="grid gap-1.5 text-xs">
                  <div className="flex items-center gap-2">
                    <dt className="w-16 shrink-0 text-muted-foreground">Channel</dt>
                    <dd className="flex min-w-0 items-center gap-1 truncate">
                      <MessageSquare className="size-3 shrink-0 text-muted-foreground" />#
                      {sp.name}
                    </dd>
                  </div>
                  <div className="flex items-center gap-2">
                    <dt className="w-16 shrink-0 text-muted-foreground">Tasks</dt>
                    <dd className="truncate">
                      {tareas} open · {listas.length} list{listas.length === 1 ? "" : "s"}
                      {dentro.folders > 0 && ` · ${dentro.folders} folder${dentro.folders === 1 ? "" : "s"}`}
                    </dd>
                  </div>
                  <div className="flex items-center gap-2">
                    <dt className="w-16 shrink-0 text-muted-foreground">Access</dt>
                    <dd className="min-w-0 truncate">
                      {visible ? (
                        <span className="inline-flex items-center gap-1 rounded bg-primary/10 px-1.5 py-0.5 text-primary">
                          <Eye className="size-3" />
                          {sp.projectId ? nombreDe(sp.projectId) : "a client sees part of it"}
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-muted-foreground">
                          <Hash className="size-3" /> internal
                        </span>
                      )}
                    </dd>
                  </div>
                </dl>

                <Button
                  variant="outline"
                  size="sm"
                  className="mt-auto"
                  onClick={() => navigate(`/tasks?space=${sp.id}`)}
                >
                  Manage
                </Button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
