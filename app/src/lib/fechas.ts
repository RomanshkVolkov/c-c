import i18next from "i18next";

/**
 * Fechas y horas, en el idioma que se eligió.
 *
 * Existe porque diecinueve sitios llamaban a `toLocaleDateString()` sin
 * argumento —o con `undefined`, que significa lo mismo—: «usa el idioma del
 * sistema operativo». Y el del sistema no tiene por qué ser el que la persona
 * eligió en la aplicación; de hecho el caso interesante es justo cuando no lo
 * es. Con la interfaz en castellano las fechas salían `10/1/2025, 8:11:38 AM`.
 *
 * Módulo aparte y no un argumento en cada llamada por lo de siempre: con
 * diecinueve sitios que hay que acordarse de tocar, el número veinte se olvida.
 * `lib/desde.ts` hace exactamente esto para el tiempo relativo y es su hermano.
 */

/**
 * Qué locale usar para formatear, que **no es lo mismo** que el idioma de la
 * interfaz.
 *
 * Si alguien en México elige castellano, quiere fechas de México —`es-MX`— y no
 * las genéricas de `es`. Así que cuando el idioma elegido coincide con el
 * prefijo del sistema, se usa la etiqueta **completa** del sistema; sólo cuando
 * no coincide manda el elegido a secas.
 *
 * Antes esto funcionaba por accidente, porque todo seguía al sistema. La
 * diferencia se ve al elegir un idioma distinto al del ordenador: entonces la
 * interfaz cambia y el formato la sigue, que es lo que la gente espera de un
 * ajuste que se llama «idioma».
 */
function paraFormatear(): string {
  const elegido = i18next.language || "en";
  const delSistema =
    typeof navigator !== "undefined" ? (navigator.language ?? "") : "";
  return delSistema.split("-")[0] === elegido.split("-")[0] ? delSistema : elegido;
}

// Construir un `Intl.DateTimeFormat` no es gratis y esto se llama por fila de
// una tabla. Se cachean por locale y forma, igual que en `desde.ts`.
const cache = new Map<string, Intl.DateTimeFormat>();

/**
 * Lo que se enseña cuando no hay fecha que enseñar.
 *
 * `Intl.DateTimeFormat.format()` **lanza** con una fecha inválida, mientras que
 * el `toLocaleString()` al que sustituye devolvía «Invalid Date». Sin esto, un
 * campo nulo o un sello corrupto pasaban de verse feos a **tirar la pantalla**,
 * que es cambiar un problema cosmético por uno grave. Lo cazaron dos pruebas
 * del cajón de tareas al convertir el último sitio.
 */
const SIN_FECHA = "—";

/**
 * Lo que se puede formatear.
 *
 * Incluye `null` y `undefined` a propósito: media docena de sitios los tienen
 * —una tarea sin fecha límite, un token que nunca se usó— y obligarles a
 * defenderse con un `?? ""` en cada llamada es repartir la misma decisión por
 * toda la aplicación.
 */
export type Fecha = string | number | Date | null | undefined;

function formateador(opciones: Intl.DateTimeFormatOptions, sello: string): Intl.DateTimeFormat {
  const locale = paraFormatear();
  const clave = `${locale}|${sello}`;
  let f = cache.get(clave);
  if (!f) {
    f = new Intl.DateTimeFormat(locale, opciones);
    cache.set(clave, f);
  }
  return f;
}

/**
 * Formatea, o se rinde en silencio.
 *
 * Una fecha que no vale es un dato malo, no una razón para dejar a alguien sin
 * pantalla.
 */
function seguro(valor: Fecha, f: () => Intl.DateTimeFormat): string {
  // `null`, `undefined` y `""` **no** son fechas inválidas para JavaScript: se
  // convierten en la época y salen como «31/12/69», que es peor que un error
  // porque parece un dato. Se descartan antes de mirar si la fecha vale.
  if (valor === null || valor === undefined || valor === "") return SIN_FECHA;
  const d = new Date(valor);
  if (Number.isNaN(d.getTime())) return SIN_FECHA;
  return f().format(d);
}

/** Una fecha sin hora: «1/9/2026». */
export function fecha(valor: Fecha): string {
  return seguro(valor, () => formateador({ dateStyle: "short" }, "corta"));
}

/** Fecha y hora: «1/9/2026, 8:11». Para registros y sellos de tiempo. */
export function fechaYHora(valor: Fecha): string {
  return seguro(valor, () => formateador({ dateStyle: "short", timeStyle: "medium" }, "larga"));
}

/** Sólo la hora: «8:11:38». */
export function hora(valor: Fecha): string {
  return seguro(valor, () => formateador({ timeStyle: "medium" }, "hora"));
}

/** Con el día y el mes escritos: «lun, 1 sept». Para agendas y calendarios. */
export function fechaLegible(valor: Fecha): string {
  return seguro(valor, () => formateador({ weekday: "short", day: "numeric", month: "short" }, "legible"));
}

/** Día y mes, sin el día de la semana: «1 sept». */
export function diaYMes(valor: Fecha): string {
  return seguro(valor, () => formateador({ day: "numeric", month: "short" }, "diaymes"));
}

/** Con el año: «1 sept 2026». Para «creada el…», donde el año importa. */
export function fechaConAno(valor: Fecha): string {
  return seguro(valor, () => formateador({ day: "numeric", month: "short", year: "numeric" }, "conano"));
}

/** Larga y con el día de la semana entero: «lunes, 1 de septiembre». */
export function fechaLarga(valor: Fecha): string {
  return seguro(valor, () => formateador({ weekday: "long", day: "numeric", month: "long" }, "larga-dia"));
}

/** El mes y el año, para la cabecera de un calendario: «septiembre 2026». */
export function mesYAno(valor: Fecha): string {
  return seguro(valor, () => formateador({ month: "long", year: "numeric" }, "mesyano"));
}

/** Sólo hora y minuto: «8:11». Para el sello de un mensaje de chat. */
export function horaCorta(valor: Fecha): string {
  return seguro(valor, () => formateador({ hour: "2-digit", minute: "2-digit" }, "horacorta"));
}
