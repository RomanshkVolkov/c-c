import { useEffect, useMemo } from "react";
import { Eye, Hash } from "lucide-react";
import { useTasksStore } from "@/store/tasks.store";
import { useReportsStore } from "@/store/reports.store";
import type { FolderTree } from "@/types/task";

/**
 * The organization's spaces, as a list rather than a tree.
 *
 * The navigator already lets you walk them; what it cannot tell you at a glance
 * is how big each one is and — the part that matters — **which of them a client
 * can see into**. That is a property of the whole place, so it belongs on the
 * organization's screen, next to who its people are.
 */

function contar(fs: FolderTree[]): { folders: number; lists: number } {
  return fs.reduce(
    (n, f) => {
      const dentro = contar(f.folders ?? []);
      return {
        folders: n.folders + 1 + dentro.folders,
        lists: n.lists + f.lists.length + dentro.lists,
      };
    },
    { folders: 0, lists: 0 },
  );
}

export default function OrgSpaces() {
  const tree = useTasksStore((s) => s.tree);
  const fetchTree = useTasksStore((s) => s.fetchTree);
  const projects = useReportsStore((s) => s.projects);
  const fetchProjects = useReportsStore((s) => s.fetchProjects);

  useEffect(() => {
    fetchTree().catch(() => {});
    fetchProjects().catch(() => {});
  }, [fetchTree, fetchProjects]);

  const nombreDe = useMemo(() => {
    const by = new Map(projects.map((p) => [p.id, p.name]));
    return (id?: string) => (id ? (by.get(id) ?? "a client") : "");
  }, [projects]);

  if (tree.length === 0) {
    return <p className="text-xs text-muted-foreground">No spaces yet.</p>;
  }

  return (
    <ul className="divide-y rounded border">
      {tree.map((sp) => {
        const dentro = contar(sp.folders);
        const listas = dentro.lists + sp.lists.length;
        // A list can carry its own binding even when the space has none, so
        // "nobody sees this" has to look at both — saying a space is private
        // when one of its lists is not would be the worst kind of wrong here.
        const listaVisible = [
          ...sp.lists,
          ...sp.folders.flatMap(function bajar(f: FolderTree): typeof sp.lists {
            return [...f.lists, ...(f.folders ?? []).flatMap(bajar)];
          }),
        ].some((l) => l.projectId);
        const visible = !!sp.projectId || listaVisible;

        return (
          <li key={sp.id} className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
            <span
              className="size-2 shrink-0 rounded-sm"
              style={{ backgroundColor: sp.color || "var(--primary)" }}
            />
            <span className="truncate font-medium">{sp.name}</span>
            <span className="shrink-0 text-xs text-muted-foreground">
              {dentro.folders > 0 && `${dentro.folders} folder${dentro.folders === 1 ? "" : "s"} · `}
              {listas} list{listas === 1 ? "" : "s"}
            </span>
            {visible && (
              <span className="ml-auto flex shrink-0 items-center gap-1 rounded bg-primary/10 px-1.5 py-0.5 text-[11px] text-primary">
                <Eye className="size-3" />
                {sp.projectId ? nombreDe(sp.projectId) : "a client sees part of it"}
              </span>
            )}
            {!visible && (
              <span className="ml-auto flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground">
                <Hash className="size-3" /> internal
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}
