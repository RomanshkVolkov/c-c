import PriorityChip from "@/components/tasks/PriorityChip";
import { diaYMes } from "@/lib/fechas";
import i18next from "@/lib/i18n";
import { dueDay } from "@/lib/month";
import type { OpenTask } from "@/types/task";
import { cn } from "@/lib/utils";
import Initials from "@/components/ui/initials";

/**
 * One card, as it appears on a board that crosses lists.
 *
 * It carries the path because a board of "my work" mixes six lists, and a
 * title on its own does not say whose problem it is. And it carries the due
 * date in words: `2026-08-16` needs arithmetic to read, while "today" and
 * "yesterday" are the two answers that change what you do next.
 */

/**
 * Today, yesterday, or a short date. Overdue is the caller's to colour —
 * `dueClass` does it the same way everywhere.
 *
 * `pronto` es mañana: todavía no vence, pero es lo siguiente que va a vencer,
 * y en ámbar se ve antes de que sea rojo.
 */
export function cuando(iso?: string | null): { texto: string; vencida: boolean; pronto: boolean } {
  const d = dueDay(iso);
  if (!d) return { texto: "", vencida: false, pronto: false };
  const hoy = new Date();
  const dia = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const dias = Math.round((dia(d) - dia(hoy)) / 86_400_000);
  if (dias === 0) return { texto: i18next.t("work:due.today"), vencida: true, pronto: false };
  if (dias === -1) return { texto: i18next.t("work:due.yesterday"), vencida: true, pronto: false };
  if (dias < -1) return { texto: diaYMes(d), vencida: true, pronto: false };
  if (dias === 1) return { texto: i18next.t("work:due.tomorrow"), vencida: false, pronto: true };
  return { texto: diaYMes(d), vencida: false, pronto: false };
}

/** El color de un vencimiento: rojo si ya toca, ámbar si es mañana. */
export function dueClass(v: { vencida: boolean; pronto: boolean }): string {
  return v.vencida ? "font-medium text-error" : v.pronto ? "text-warning" : "text-muted-foreground";
}

export default function TaskCardMini({ task, onOpen }: { task: OpenTask; onOpen: () => void }) {
  const vence = cuando(task.dueAt);
  return (
    <button
      onClick={onOpen}
      className="w-full rounded-lg border bg-raised px-2.5 py-2 text-left hover:border-primary/40"
    >
      <div className="flex items-baseline gap-1.5 text-[11px] text-muted-foreground">
        <span className="font-mono shrink-0">#{task.seq}</span>
        <span className="truncate">
          {task.spaceName} / {task.listName}
        </span>
      </div>
      <p className="mt-0.5 line-clamp-2 text-sm">{task.title}</p>
      <div className="mt-1.5 flex items-center gap-2 text-[11px]">
        <PriorityChip priority={task.priority} />
        {task.subtasksTotal > 0 && (
          <span className="shrink-0 font-mono text-muted-foreground">
            {task.subtasksDone}/{task.subtasksTotal}
          </span>
        )}
        <span className={cn("shrink-0", dueClass(vence))}>
          {vence.texto || "—"}
        </span>
        {task.assignee && (
          <Initials
            colorKey={task.assignee}
            title={task.assignee}
            text={task.assignee.slice(0, 2)}
            className="ml-auto size-5 text-[9px]"
          />
        )}
      </div>
    </button>
  );
}
