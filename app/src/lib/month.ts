import { paraFormatear } from "@/lib/fechas";

/**
 * La rejilla de un mes, sin nada de pantalla.
 *
 * Estaba dentro del calendario de tareas, y hace falta en dos sitios desde que
 * el selector de fecha dejó de ser el nativo. Aquí porque es aritmética pura y
 * llena de bordes —el mes que empieza en domingo, febrero, el cambio de hora— y
 * eso se comprueba mejor con una tabla de casos que arrastrando el ratón.
 */

/**
 * Identifica el día **local** de una `Date`, sin la hora.
 *
 * Sin la hora, pero **con** la zona: lee captadores locales, así que sólo es
 * segura sobre una fecha que ya es local. Sobre un vencimiento crudo
 * (medianoche UTC) devuelve el día anterior al oeste de Greenwich — que es como
 * el calendario de «Mi trabajo» pintó en el 29 lo que se soltó en el 30. Para
 * un vencimiento, pasa antes por `dueDay`.
 */
export const dayKey = (d: Date) =>
  `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;

/**
 * Seis semanas empezando en lunes, siempre.
 *
 * Siempre seis y no las que haga falta: con un número variable, la rejilla
 * cambia de alto al pasar de mes y el botón que ibas a pulsar se mueve debajo
 * del cursor. Un mes cabe en cinco o en seis según en qué día caiga el 1.
 */
export function monthGrid(cursor: Date): Date[] {
  const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
  // Lunes = 0. `getDay()` cuenta desde domingo, y aquí la semana empieza en
  // lunes: sin el desplazamiento, cada mes que cae en domingo sale corrido.
  const offset = (first.getDay() + 6) % 7;
  const start = new Date(first);
  start.setDate(first.getDate() - offset);
  return Array.from({ length: 42 }, (_, i) => {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    return d;
  });
}

/**
 * Las iniciales de los días, en el idioma elegido.
 *
 * Del sistema y no de una lista escrita a mano: estaban en inglés fijo dentro
 * del calendario, así que la app entera hablaba castellano menos esa fila.
 */
export function weekdayInitials(): string[] {
  const fmt = new Intl.DateTimeFormat(paraFormatear(), { weekday: "short" });
  // 2024-01-01 fue lunes, que es donde empieza la rejilla.
  return Array.from({ length: 7 }, (_, i) => fmt.format(new Date(2024, 0, 1 + i)));
}

/** El mismo día, comparando sin hora. */
export const isSameDay = (a: Date, b: Date) => dayKey(a) === dayKey(b);

/** `YYYY-MM-DD` en hora local, que es lo que espera un `<input type="date">`. */
export function toISODate(d: Date): string {
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

/**
 * Un `YYYY-MM-DD` de vuelta a una fecha **local**.
 *
 * `new Date("2026-09-07")` lo interpreta como UTC, así que al oeste de Greenwich
 * sale el día anterior. Es el fallo clásico de los selectores de fecha: eliges
 * un día y se guarda el de antes.
 */
export function fromISODate(s: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

/**
 * El día que alguien eligió como vencimiento, leído tal cual.
 *
 * `dueAt` es **una fecha, no un instante**, pero se guarda como uno: el día a
 * medianoche UTC. Leerlo con los captadores locales corre el día entero en
 * cualquier zona al oeste de Greenwich — eliges el 7 y en México se ve el 6.
 * Comprobado, no supuesto.
 *
 * Se resuelve al leer y no al guardar a propósito: cambiar la escritura arregla
 * lo que se guarde a partir de mañana y deja mal todo lo que ya hay, sin una
 * migración. Así valen los dos.
 *
 * Devuelve una fecha **local** con ese día a medianoche, que es lo que esperan
 * `Intl` y cualquier resta de días.
 */
export function dueDay(iso?: string | null): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/**
 * Qué mandar al elegir —o vaciar— un vencimiento en el selector.
 *
 * Vaciar no es mandar `dueAt: null`: el servidor lee un `null` como «no tocar»,
 * así que la fecha se quedaba y volvía a salir al recargar, sin error (#95).
 * Quitarla es `clearDueAt`. Aparte, y no en línea en el detalle, para poder
 * probarla: es la mitad del arreglo que vive en la app.
 */
export function dueDatePatch(value: string): { dueAt: string } | { clearDueAt: true } {
  return value ? { dueAt: new Date(value).toISOString() } : { clearDueAt: true };
}
