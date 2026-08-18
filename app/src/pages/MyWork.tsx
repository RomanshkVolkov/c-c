import { useEffect, useMemo } from "react";
import { AlertCircle, Eye, EyeOff, Loader2 } from "lucide-react";
import { useMyWorkStore, type WorkLens } from "@/store/mywork.store";
import { useOrgsStore } from "@/store/orgs.store";
import { useTasksStore } from "@/store/tasks.store";
import { priorityMeta } from "@/types/task";
import type { OpenTask } from "@/types/task";
import { cn } from "@/lib/utils";

/**
 * Everything open, across every space, one question at a time.
 *
 * The tabs are lenses and not filters over a downloaded list: each one is a
 * different question asked of the server. That matters beyond tidiness — "all
 * the open work in this organization" is not something worth shipping to a
 * client so it can throw most of it away.
 *
 * Grouped by space because that is how people hold their work in their head:
 * not "forty tasks" but "three for this client, two for that one".
 */

const LENSES: { key: WorkLens; label: string }[] = [
  { key: "assigned", label: "Assigned to me" },
  { key: "created", label: "Created by me" },
  { key: "watching", label: "Following" },
  { key: "clients", label: "From clients" },
  { key: "all", label: "All" },
];

export default function MyWork() {
  const { lens, includeClosed, tasks, loading, error } = useMyWorkStore();
  const setLens = useMyWorkStore((s) => s.setLens);
  const setIncludeClosed = useMyWorkStore((s) => s.setIncludeClosed);
  const load = useMyWorkStore((s) => s.load);
  const orgId = useOrgsStore((s) => s.currentOrgId);
  const openTask = useTasksStore((s) => s.openTask);

  useEffect(() => {
    load(orgId).catch(() => {});
  }, [load, orgId, lens, includeClosed]);

  // Grouped in the order the tree shows spaces, so the two read the same way.
  const orden = useTasksStore((s) => s.tree.map((t) => t.id));
  const grupos = useMemo(() => {
    const by = new Map<string, { name: string; items: OpenTask[] }>();
    for (const t of tasks) {
      const g = by.get(t.spaceId) ?? { name: t.spaceName, items: [] };
      g.items.push(t);
      by.set(t.spaceId, g);
    }
    return [...by.entries()].sort(
      (a, b) => (orden.indexOf(a[0]) + 1 || 99) - (orden.indexOf(b[0]) + 1 || 99),
    );
  }, [tasks, orden]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="shrink-0 border-b px-4 pt-3">
        <div className="flex items-baseline gap-2">
          <h1 className="text-lg font-semibold">My work</h1>
          <span className="text-xs text-muted-foreground">
            {loading ? "…" : `${tasks.length} visible`}
          </span>
          <button
            onClick={() => setIncludeClosed(!includeClosed)}
            className="ml-auto flex items-center gap-1.5 rounded border px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
            title={includeClosed ? "Hide finished work" : "Show finished work too"}
          >
            {includeClosed ? <Eye className="size-3" /> : <EyeOff className="size-3" />}
            {includeClosed ? "All states" : "Open only"}
          </button>
        </div>
        <nav className="-mb-px flex gap-4 pt-2 text-sm">
          {LENSES.map((l) => (
            <button
              key={l.key}
              onClick={() => setLens(l.key)}
              className={cn(
                "border-b-2 pb-2",
                l.key === lens
                  ? "border-primary font-medium text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              {l.label}
            </button>
          ))}
        </nav>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {error && (
          <p className="flex items-center gap-1.5 text-xs text-destructive">
            <AlertCircle className="size-3" /> {error}
          </p>
        )}
        {loading && tasks.length === 0 ? (
          <Loader2 className="size-4 animate-spin text-muted-foreground" />
        ) : tasks.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {lens === "watching"
              ? "You are not following anything. Open a task and follow it to keep an eye on it without taking it."
              : "Nothing here."}
          </p>
        ) : (
          <div className="space-y-5">
            {grupos.map(([spaceId, g]) => (
              <section key={spaceId}>
                <h2 className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  {g.name} · {g.items.length}
                </h2>
                <ul className="divide-y rounded border">
                  {g.items.map((t) => (
                    <li key={t.id}>
                      <button
                        onClick={() => openTask(t.id).catch(() => {})}
                        className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-accent/40"
                      >
                        <span className="w-10 shrink-0 font-mono text-xs text-muted-foreground">
                          #{t.seq}
                        </span>
                        <span className="min-w-0 flex-1 truncate text-sm">{t.title}</span>
                        {/* Through the helper, never indexed: the table has
                            been missing a value the server grew before, and
                            reading a field off the resulting undefined took a
                            whole screen down. */}
                        <span className={cn("shrink-0 text-xs", priorityMeta(t.priority).className)}>
                          {priorityMeta(t.priority).label}
                        </span>
                        <span className="w-28 shrink-0 truncate text-right text-xs text-muted-foreground">
                          {t.listName}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
