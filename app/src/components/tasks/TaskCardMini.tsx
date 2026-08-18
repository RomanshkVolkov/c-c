import type { OpenTask } from "@/types/task";
import { priorityMeta } from "@/types/task";
import { cn } from "@/lib/utils";

/**
 * One card, as it appears on a board that crosses lists.
 *
 * It carries the path because a board of "my work" mixes six lists, and a
 * title on its own does not say whose problem it is. And it carries the due
 * date in words: `2026-08-16` needs arithmetic to read, while "today" and
 * "yesterday" are the two answers that change what you do next.
 */

/** Today, yesterday, or a short date. Overdue is the caller's to colour. */
export function cuando(iso?: string | null): { texto: string; vencida: boolean } {
  if (!iso) return { texto: "", vencida: false };
  const d = new Date(iso);
  const hoy = new Date();
  const dia = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const dias = Math.round((dia(d) - dia(hoy)) / 86_400_000);
  if (dias === 0) return { texto: "today", vencida: true };
  if (dias === -1) return { texto: "yesterday", vencida: true };
  if (dias < -1) return { texto: d.toLocaleDateString(undefined, { day: "numeric", month: "short" }), vencida: true };
  if (dias === 1) return { texto: "tomorrow", vencida: false };
  return { texto: d.toLocaleDateString(undefined, { day: "numeric", month: "short" }), vencida: false };
}

export default function TaskCardMini({ task, onOpen }: { task: OpenTask; onOpen: () => void }) {
  const vence = cuando(task.dueAt);
  return (
    <button
      onClick={onOpen}
      className="w-full rounded-lg border bg-card px-2.5 py-2 text-left hover:border-primary/40"
    >
      <div className="flex items-baseline gap-1.5 text-[11px] text-muted-foreground">
        <span className="font-mono shrink-0">#{task.seq}</span>
        <span className="truncate">
          {task.spaceName} / {task.listName}
        </span>
      </div>
      <p className="mt-0.5 line-clamp-2 text-sm">{task.title}</p>
      <div className="mt-1.5 flex items-center gap-2 text-[11px]">
        <span className={cn("shrink-0", priorityMeta(task.priority).className)}>
          {priorityMeta(task.priority).label}
        </span>
        {task.subtasksTotal > 0 && (
          <span className="shrink-0 font-mono text-muted-foreground">
            {task.subtasksDone}/{task.subtasksTotal}
          </span>
        )}
        <span className={cn("shrink-0", vence.vencida ? "text-destructive" : "text-muted-foreground")}>
          {vence.texto || "—"}
        </span>
        {task.assignee && (
          <span
            title={task.assignee}
            className="ml-auto flex size-5 shrink-0 items-center justify-center rounded-full bg-primary/15 text-[9px] font-semibold uppercase text-primary"
          >
            {task.assignee.slice(0, 2)}
          </span>
        )}
      </div>
    </button>
  );
}
