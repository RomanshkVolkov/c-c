import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { AlertCircle, CalendarDays, Eye, EyeOff, KanbanSquare, List, Loader2, X } from "lucide-react";
import ItemCalendar from "@/components/ItemCalendar";
import NewTaskRow from "@/components/tasks/NewTaskRow";
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

/**
 * The three ways to look at the same answer.
 *
 * All three read the rows already fetched — none of them asks the server
 * again. A board across many lists groups by state and not by column, because
 * the columns are a rendering of one shared state machine, so "in progress"
 * means the same thing in every list; grouping by column would invent as many
 * boards as there are lists.
 */
const VISTAS = [
  { key: "list", label: "List", icon: List },
  { key: "board", label: "Board", icon: KanbanSquare },
  { key: "calendar", label: "Calendar", icon: CalendarDays },
] as const;

type Vista = (typeof VISTAS)[number]["key"];

const ESTADOS: { kind: string; label: string }[] = [
  { kind: "open", label: "To do" },
  { kind: "active", label: "In progress" },
  { kind: "done", label: "Done" },
];

export default function MyWork() {
  const [vista, setVista] = useState<Vista>("list");
  const [creando, setCreando] = useState(false);
  const [params, setParams] = useSearchParams();
  useEffect(() => {
    if (params.get("new") !== "1") return;
    setCreando(true);
    const resto = new URLSearchParams(params);
    resto.delete("new");
    setParams(resto, { replace: true });
  }, [params, setParams]);
  const { lens, includeClosed, tasks, loading, error, scope } = useMyWorkStore();
  const setScope = useMyWorkStore((s) => s.setScope);
  const setLens = useMyWorkStore((s) => s.setLens);
  const setIncludeClosed = useMyWorkStore((s) => s.setIncludeClosed);
  const load = useMyWorkStore((s) => s.load);
  const orgId = useOrgsStore((s) => s.currentOrgId);
  const openTask = useTasksStore((s) => s.openTask);

  useEffect(() => {
    load(orgId).catch(() => {});
  }, [load, orgId, lens, includeClosed]);

  // Narrowed in the client rather than re-asked: every row already says which
  // space and list it is in, so pointing the same answer at a smaller part of
  // it costs nothing and keeps the tree instant.
  const visibles = useMemo(() => {
    if (!scope) return tasks;
    return tasks.filter((t) =>
      scope.kind === "list" ? t.listId === scope.id : t.spaceId === scope.id,
    );
  }, [tasks, scope]);

  // Grouped in the order the tree shows spaces, so the two read the same way.
  //
  // The tree itself is selected, and the order derived out here. A selector
  // must return the same reference when nothing changed, and `.map()` never
  // does: zustand compares with Object.is, sees a new array every render, and
  // renders again — which is the infinite loop, not a slow one.
  const tree = useTasksStore((s) => s.tree);
  const orden = useMemo(() => tree.map((t) => t.id), [tree]);
  const grupos = useMemo(() => {
    const by = new Map<string, { name: string; items: OpenTask[] }>();
    for (const t of visibles) {
      const g = by.get(t.spaceId) ?? { name: t.spaceName, items: [] };
      g.items.push(t);
      by.set(t.spaceId, g);
    }
    return [...by.entries()].sort(
      (a, b) => (orden.indexOf(a[0]) + 1 || 99) - (orden.indexOf(b[0]) + 1 || 99),
    );
  }, [visibles, orden]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="shrink-0 border-b px-4 pt-3">
        <div className="flex items-baseline gap-2">
          <h1 className="text-lg font-semibold">My work</h1>
          <span className="text-xs text-muted-foreground">
            {loading ? "…" : `${visibles.length} visible`}
          </span>
          <button
            onClick={() => setCreando(true)}
            className="ml-auto rounded bg-primary px-2 py-1 text-xs font-medium text-primary-foreground"
          >
            New task
          </button>
          <button
            onClick={() => setIncludeClosed(!includeClosed)}
            className="flex items-center gap-1.5 rounded border px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
            title={includeClosed ? "Hide finished work" : "Show finished work too"}
          >
            {includeClosed ? <Eye className="size-3" /> : <EyeOff className="size-3" />}
            {includeClosed ? "All states" : "Open only"}
          </button>
        </div>
        {scope && (
          <button
            onClick={() => setScope(null)}
            className="mt-1 flex items-center gap-1 self-start rounded-full border bg-accent/40 px-2 py-0.5 text-xs hover:bg-accent"
            title="Show everything again"
          >
            {/* Says out loud that you are seeing part of it. A filtered list with
                nothing announcing the filter reads as "there is nothing here". */}
            {scope.kind === "list" ? "List" : "Space"}: {scope.name}
            <X className="size-3" />
          </button>
        )}
        <nav className="-mb-px flex items-center gap-4 pt-2 text-sm">
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
          <span className="ml-auto flex gap-0.5 pb-1.5">
            {VISTAS.map((v) => (
              <button
                key={v.key}
                onClick={() => setVista(v.key)}
                title={v.label}
                aria-pressed={v.key === vista}
                className={cn(
                  "rounded px-1.5 py-1",
                  v.key === vista
                    ? "bg-accent text-accent-foreground"
                    : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                )}
              >
                <v.icon className="size-3.5" />
              </button>
            ))}
          </span>
        </nav>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {creando && (
          <NewTaskRow
            onClose={() => {
              setCreando(false);
              // Re-ask: what you just raised may or may not belong in the lens
              // you are looking at, and guessing which would be a list that
              // disagrees with the server.
              load(orgId).catch(() => {});
            }}
          />
        )}
        {error && (
          <p className="flex items-center gap-1.5 text-xs text-destructive">
            <AlertCircle className="size-3" /> {error}
          </p>
        )}
        {loading && visibles.length === 0 ? (
          <Loader2 className="size-4 animate-spin text-muted-foreground" />
        ) : visibles.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {lens === "watching"
              ? "You are not following anything. Open a task and follow it to keep an eye on it without taking it."
              : "Nothing here."}
          </p>
        ) : (
          vista === "calendar" ? (
            <ItemCalendar
              // Placed by when it is due, not by when it was raised: this
              // screen answers "what is coming", and a month view of creation
              // dates answers nothing anybody asked.
              items={visibles
                .filter((t) => t.dueAt)
                .map((t) => ({
                  id: t.id,
                  title: t.title,
                  at: t.dueAt as string,
                  dotClass: priorityMeta(t.priority).className,
                  label: `#${t.seq}`,
                }))}
              onOpen={(id) => openTask(id).catch(() => {})}
              noun="task"
            />
          ) : vista === "board" ? (
            <div className="flex gap-3 overflow-x-auto">
              {ESTADOS.map((col) => {
                const suyas = visibles.filter((t) => t.statusKind === col.kind);
                return (
                  <section key={col.kind} className="w-72 shrink-0">
                    <h2 className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                      {col.label} · {suyas.length}
                    </h2>
                    <ul className="space-y-1">
                      {suyas.map((t) => (
                        <li key={t.id}>
                          <button
                            onClick={() => openTask(t.id).catch(() => {})}
                            className="w-full rounded border px-2 py-1.5 text-left hover:bg-accent/40"
                          >
                            <span className="block truncate text-sm">{t.title}</span>
                            <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">
                              {t.spaceName} · {t.listName}
                            </span>
                          </button>
                        </li>
                      ))}
                      {suyas.length === 0 && (
                        <li className="rounded border border-dashed px-2 py-3 text-center text-xs text-muted-foreground">
                          Nothing
                        </li>
                      )}
                    </ul>
                  </section>
                );
              })}
            </div>
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
          )
        )}
      </div>
    </div>
  );
}
