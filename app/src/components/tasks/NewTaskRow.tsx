import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Loader2, X } from "lucide-react";
import { useTasksStore } from "@/store/tasks.store";
import { usePeopleStore } from "@/store/people.store";
import { useOrgsStore } from "@/store/orgs.store";
import { PRIORITIES, priorityMeta, type ItemVisibility, type TaskPriority } from "@/types/task";

/**
 * Raising a task without leaving the screen you are on.
 *
 * A row rather than a dialog, and it stays open after each one: work arrives in
 * runs — a call ends and you have four things to write down — and a modal
 * between each of them is four context switches for four sentences.
 *
 * Everything is decided before it exists. Creating first and editing after
 * would put a task on everyone's board for a moment with nobody on it and no
 * date, which is a thing other people can see and act on while it is wrong.
 */
export default function NewTaskRow({ onClose }: { onClose: () => void }) {
  const tree = useTasksStore((s) => s.tree);
  const createTaskIn = useTasksStore((s) => s.createTaskIn);
  const orgId = useOrgsStore((s) => s.currentOrgId);
  const people = usePeopleStore((s) => (orgId ? s.byOrg[orgId] : undefined)) ?? [];
  const fetchPeople = usePeopleStore((s) => s.fetchPeople);

  const [title, setTitle] = useState("");
  const [listId, setListId] = useState("");
  const [priority, setPriority] = useState<TaskPriority>("normal");
  const [dueAt, setDueAt] = useState("");
  const [assignee, setAssignee] = useState("");
  const [visibility, setVisibility] = useState<ItemVisibility | "">("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetchPeople().catch(() => {});
  }, [fetchPeople]);

  // Every list in the organization, labelled with the path that tells two lists
  // called "tasks" apart — which is most of them.
  const destinos = useMemo(() => {
    const out: { id: string; label: string; channel?: string }[] = [];
    for (const sp of tree) {
      for (const l of sp.lists) {
        out.push({ id: l.id, label: `${sp.name} / ${l.name}`, channel: l.projectId });
      }
      const bajar = (fs: typeof sp.folders, prefijo: string) => {
        for (const f of fs) {
          for (const l of f.lists) {
            out.push({ id: l.id, label: `${prefijo} / ${f.name} / ${l.name}`, channel: l.projectId });
          }
          bajar(f.folders ?? [], `${prefijo} / ${f.name}`);
        }
      };
      bajar(sp.folders, sp.name);
    }
    return out;
  }, [tree]);

  useEffect(() => {
    if (!listId && destinos.length > 0) setListId(destinos[0].id);
  }, [destinos, listId]);

  const destino = destinos.find((d) => d.id === listId);
  // Visibility is only a question in a list a client can see into. Anywhere
  // else the control would be asking about a distinction that does not exist.
  const preguntaVisibilidad = !!destino?.channel;

  const crear = async () => {
    const t = title.trim();
    if (!t || !listId || busy) return;
    setBusy(true);
    try {
      await createTaskIn({
        listId,
        title: t,
        priority,
        dueAt: dueAt ? new Date(dueAt).toISOString() : null,
        assigneeIds: assignee ? [assignee] : [],
        visibility: preguntaVisibilidad && visibility ? visibility : undefined,
      });
      // Only the title clears. The next thing you write down almost always
      // belongs in the same list with the same urgency.
      setTitle("");
    } catch (e) {
      toast.error("Could not create it", { description: String(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mb-3 rounded-md border border-primary/40 bg-card p-2">
      <div className="flex items-center gap-2">
        <input
          autoFocus
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void crear();
            } else if (e.key === "Escape") {
              onClose();
            }
          }}
          placeholder="What needs doing?"
          aria-label="Task title"
          className="h-8 w-full bg-transparent text-sm outline-none"
        />
        {busy && <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" />}
        <button
          onClick={onClose}
          aria-label="Close the composer"
          className="shrink-0 text-muted-foreground hover:text-foreground"
        >
          <X className="size-4" />
        </button>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs">
        <select
          aria-label="Where it goes"
          value={listId}
          onChange={(e) => setListId(e.target.value)}
          className="h-7 max-w-[16rem] rounded border bg-background px-1.5"
        >
          {destinos.map((d) => (
            <option key={d.id} value={d.id}>
              {d.label}
            </option>
          ))}
        </select>

        <select
          aria-label="Priority"
          value={priority}
          onChange={(e) => setPriority(e.target.value as TaskPriority)}
          className="h-7 rounded border bg-background px-1.5"
        >
          {PRIORITIES.map((p) => (
            <option key={p} value={p}>
              {priorityMeta(p).label}
            </option>
          ))}
        </select>

        <input
          type="date"
          aria-label="Due date"
          value={dueAt}
          onChange={(e) => setDueAt(e.target.value)}
          className="h-7 rounded border bg-background px-1.5"
        />

        <select
          aria-label="Assignee"
          value={assignee}
          onChange={(e) => setAssignee(e.target.value)}
          className="h-7 rounded border bg-background px-1.5"
        >
          <option value="">Nobody yet</option>
          {people.map((p) => (
            <option key={p.id} value={p.id}>
              {p.username}
            </option>
          ))}
        </select>

        {preguntaVisibilidad && (
          <select
            aria-label="Visibility"
            value={visibility}
            onChange={(e) => setVisibility(e.target.value as ItemVisibility | "")}
            className="h-7 rounded border bg-background px-1.5"
          >
            {/* The empty option is the server's default and says so out loud:
                in a list bound to a client, work is theirs to see unless
                somebody decides otherwise. */}
            <option value="">The client sees it</option>
            <option value="internal">Internal only</option>
          </select>
        )}

        <span className="ml-auto font-mono text-[10px] text-muted-foreground">
          ↵ creates and stays · esc closes
        </span>
      </div>
    </div>
  );
}
