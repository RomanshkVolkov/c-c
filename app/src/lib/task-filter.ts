import { PRIORITIES, type TaskCard, type TaskPriority } from "@/types/task";

/**
 * Lo que filtra las tres vistas de una lista (tablero, lista y calendario).
 *
 * Todo en el cliente: el tablero ya trae todas las tarjetas de la lista, así
 * que filtrar es mirar lo que hay en pantalla, sin otra petición. `""` es
 * «cualquiera» en cada campo, como en un `Picker`.
 */
export interface TaskFilter {
  /** Texto del título, o el folio (`12` o `#12`). */
  query: string;
  /** Id de la persona; `NOBODY` para las que no tienen a nadie. */
  assignee: string;
  priority: string;
  /** Id de la etiqueta. */
  tag: string;
  category: string;
  area: string;
}

export const EMPTY_FILTER: TaskFilter = { query: "", assignee: "", priority: "", tag: "", category: "", area: "" };

/** El valor de «sin asignar». No puede chocar con un id: los ids son UUID. */
export const NOBODY = "-";

/** Sin acentos y en minúsculas: «revision» encuentra «Revisión». */
const fold = (s: string) =>
  s
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();

/**
 * La prioridad guardada `medium` es la `normal` de la API de tareas (ver
 * CLAUDE.md, «La prioridad media…»). Se comparan por el mismo nombre, o una
 * tarjeta que llegue con el guardado no saldría al filtrar por «media».
 */
const canonicalPriority = (p: string) => (p === "medium" ? "normal" : p || "none");

export function matchesFilter(card: TaskCard, f: TaskFilter): boolean {
  const q = f.query.trim();
  if (q) {
    // Un número es un folio, y se busca entero: «#1» no es «#12». Pero un
    // número también puede estar en el título («migrar a v2»), así que
    // cualquiera de las dos cosas vale.
    const seq = /^#?(\d+)$/.exec(q);
    const bySeq = seq !== null && card.seq === Number(seq[1]);
    if (!bySeq && !fold(card.title).includes(fold(q))) return false;
  }
  if (f.assignee) {
    if (f.assignee === NOBODY ? card.assignees.length > 0 : !card.assignees.some((a) => a.id === f.assignee)) {
      return false;
    }
  }
  if (f.priority && canonicalPriority(card.priority) !== f.priority) return false;
  if (f.tag && !card.tags.some((t) => t.id === f.tag)) return false;
  if (f.category && card.category !== f.category) return false;
  if (f.area && card.area !== f.area) return false;
  return true;
}

export function isFiltering(f: TaskFilter): boolean {
  return Object.values(f).some((v) => v.trim() !== "");
}

/**
 * Las opciones de cada desplegable, sacadas de las tarjetas que hay.
 *
 * Sólo lo que aparece en la lista: ofrecer una persona o una etiqueta que no
 * tiene ninguna tarjeta es un filtro que siempre deja la vista vacía.
 * Responsable y prioridad necesitan dos valores para separar algo («sin
 * nadie» cuenta como uno); etiqueta, clase y área con uno basta, porque
 * separa las que la llevan de las que no. Lo que está elegido se ofrece
 * siempre: si no, el desplegable desaparecería con el filtro puesto y no
 * habría cómo quitarlo.
 */
export function filterOptions(cards: TaskCard[], f: TaskFilter = EMPTY_FILTER) {
  const people = new Map<string, string>();
  const tags = new Map<string, string>();
  let unassigned = false;
  const priorities = new Set<TaskPriority>();
  const categories = new Set<string>();
  const areas = new Set<string>();
  for (const c of cards) {
    for (const a of c.assignees) people.set(a.id, a.username);
    if (c.assignees.length === 0) unassigned = true;
    for (const t of c.tags) tags.set(t.id, t.name);
    priorities.add(canonicalPriority(c.priority) as TaskPriority);
    if (c.category) categories.add(c.category);
    if (c.area) areas.add(c.area);
  }
  const byName = (a: [string, string], b: [string, string]) => a[1].localeCompare(b[1]);
  const named = (m: Map<string, string>) => [...m].sort(byName).map(([id, name]) => ({ id, name }));
  const offer = (n: number, min: number, chosen: string) => n >= min || chosen !== "";
  return {
    assignees: offer(people.size + (unassigned ? 1 : 0), 2, f.assignee) ? named(people) : [],
    unassigned,
    // En el orden de siempre, de la peor a la mejor (`PRIORITIES`).
    priorities: offer(priorities.size, 2, f.priority) ? PRIORITIES.filter((p) => priorities.has(p)) : [],
    tags: offer(tags.size, 1, f.tag) ? named(tags) : [],
    categories: offer(categories.size, 1, f.category) ? [...categories].sort() : [],
    areas: offer(areas.size, 1, f.area) ? [...areas].sort() : [],
  };
}
