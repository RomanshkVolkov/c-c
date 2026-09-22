import type { CalendarItem } from "@/components/ItemCalendar";
import { toISODate, dueDay } from "@/lib/month";
import { priorityMeta, type OpenTask } from "@/types/task";

type Dated = Pick<OpenTask, "id" | "seq" | "title" | "priority" | "dueAt">;

/**
 * Las tareas de «Mi trabajo», colocadas en el día en que vencen.
 *
 * Fuera de la página para poder montarlas en el calendario de verdad desde una
 * prueba: el fallo del 29-por-30 vivía justo en la costura entre las dos, y
 * cada prueba de la página sustituye el calendario por nada.
 *
 * Un vencimiento es un **día**, no un instante: va como `day`, ya resuelto por
 * `dueDay`. Pasarlo como `at` compila —es un `string`— y lo pinta el
 * día anterior en toda zona al oeste de Greenwich.
 */
export function dueCalendarItems(tasks: Dated[]): CalendarItem[] {
  return tasks.flatMap((t) => {
    const due = dueDay(t.dueAt);
    if (!due) return [];
    return [{
      id: t.id,
      title: t.title,
      day: toISODate(due),
      dotClass: priorityMeta(t.priority).className,
      label: `#${t.seq}`,
    }];
  });
}
