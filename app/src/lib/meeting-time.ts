import type { Translate } from "@/lib/i18n";

/**
 * La misma hora, dicha dos veces.
 *
 * Una reunión se crea en la zona de quien la crea —«las 9:00 de CDMX»— y la lee
 * gente que puede estar en otra. Enseñar sólo una de las dos horas obliga a
 * cada quien a hacer la conversión de cabeza, que es exactamente donde se
 * equivoca la gente al quedar.
 *
 * Nunca con aritmética de desfases. Restar horas a mano funciona once meses al
 * año y falla justo en la semana del cambio, que es cuando alguien pierde una
 * reunión — y encima falla distinto según el hemisferio. Se formatea **el mismo
 * instante** dos veces y que la plataforma responda qué hora era ahí.
 */

/** Formatea un instante en una zona concreta, o en la de quien mira. */
function formatInZone(instant: Date, timeZone?: string): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    timeZone,
  }).format(instant);
}

/**
 * El nombre corto de la zona, para poder decir «9:00 CST» y no sólo «9:00».
 *
 * Sin él las dos horas se parecen demasiado y no se sabe cuál es cuál.
 */
function zoneAbbreviation(instant: Date, timeZone?: string): string {
  const parts = new Intl.DateTimeFormat("en", {
    timeZone,
    timeZoneName: "short",
  }).formatToParts(instant);
  return parts.find((p) => p.type === "timeZoneName")?.value ?? "";
}

export interface DualTime {
  /** La hora en la zona de la reunión, con el nombre de esa zona. */
  there: string;
  /** La misma hora donde está quien mira. */
  here: string;
  /** Si las dos coinciden, no hace falta enseñar las dos. */
  sameZone: boolean;
}

/**
 * `dualTime("2026-08-25T15:00:00Z", "America/Mexico_City")` para alguien en
 * Madrid da `{ there: "09:00 CST", here: "17:00 CEST", sameZone: false }`.
 *
 * `sameZone` compara **el texto formateado**, no las cadenas de zona: quien
 * mira desde Cancún y una reunión de Bogotá ven la misma hora aunque las zonas
 * se llamen distinto, y repetirla dos veces sólo sería ruido.
 */
export function dualTime(instant: string | Date, timeZone: string): DualTime {
  const when = typeof instant === "string" ? new Date(instant) : instant;
  if (Number.isNaN(when.getTime())) {
    return { there: "", here: "", sameZone: true };
  }

  let there: string;
  try {
    there = `${formatInZone(when, timeZone)} ${zoneAbbreviation(when, timeZone)}`.trim();
  } catch {
    // Una zona que esta plataforma no conoce: mejor enseñar sólo la hora local
    // que romper la pantalla entera por un nombre mal escrito.
    return { there: "", here: formatInZone(when), sameZone: true };
  }
  const here = `${formatInZone(when)} ${zoneAbbreviation(when)}`.trim();

  return { there, here, sameZone: there === here };
}

/** «9:00 CST · 17:00 CEST», o sólo la hora cuando las dos coinciden. */
export function readableTime(instant: string | Date, timeZone: string): string {
  const { there, here, sameZone } = dualTime(instant, timeZone);
  if (!there) return here;
  return sameZone ? there : `${there} · ${here}`;
}

/**
 * Los nombres cortos de los días, en el idioma que se pida.
 *
 * Salen de `Intl`, no de una tabla: mantener a mano siete nombres por idioma es
 * prometer que alguien se acordará de añadir la fila cuando entre el tercero.
 * Se formatea una semana de referencia —el 7 de enero de 2024 fue domingo— en
 * UTC, para que el desfase de quien mira no corra los días uno.
 */
const weekdayNameCache = new Map<string, string[]>();

function weekdayNames(lng: string): string[] {
  const cached = weekdayNameCache.get(lng);
  if (cached) return cached;
  const fmt = new Intl.DateTimeFormat(lng, { weekday: "short", timeZone: "UTC" });
  const names = Array.from({ length: 7 }, (_, d) =>
    fmt.format(new Date(Date.UTC(2024, 0, 7 + d))),
  );
  weekdayNameCache.set(lng, names);
  return names;
}

/**
 * Los días de la semana de "1,3,5", dichos como los diría una persona.
 *
 * La lista la junta `Intl.ListFormat` en modo `unit`, que es el de una
 * enumeración corta sin conjunción: en inglés y en castellano da «Mon, Wed» y
 * «lun, mié», pero en un idioma que separe distinto lo hará distinto, y pegar
 * comas a mano no.
 */
export function readableWeekdays(weekdays: string | undefined, lng = "en"): string {
  const days = (weekdays ?? "")
    .split(",")
    .map((d) => d.trim())
    // Descartar el vacío **antes** de convertir: `Number("")` es 0, no `NaN`,
    // así que una regla sin días se leía como «domingo». Lo cazó una prueba.
    .filter((d) => d !== "")
    .map(Number)
    .filter((d) => Number.isInteger(d) && d >= 0 && d <= 6);
  if (days.length === 0) return "";
  // Ordenados de lunes a domingo, que es como se lee una semana de trabajo —
  // el domingo es el 0 pero nadie empieza la semana nombrándolo.
  days.sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7));
  const names = weekdayNames(lng);
  return new Intl.ListFormat(lng, { style: "short", type: "unit" }).format(
    days.map((d) => names[d]),
  );
}

/**
 * La regla entera en una línea: «Weekly · Mon, Wed», «Cada 2 semanas · lun».
 *
 * Antes esto concatenaba `"Every " + interval + " " + "weeks"`, y esa forma no
 * sobrevive a un segundo idioma: el número no cae en el mismo sitio, el
 * sustantivo cambia de género, y «cada 1 semana» no se dice. Cada caso es aquí
 * **un mensaje entero** con el número dentro, y el catálogo decide su forma.
 *
 * `t` entra por parámetro para que esto siga siendo una función pura sobre la
 * que se pueda escribir una prueba sin montar media aplicación.
 */
export function readableRule(
  m: { freq: string; interval?: number; weekdays?: string; monthDay?: number },
  t: Translate,
  lng = "en",
): string {
  const every = m.interval ?? 1;
  const parts: string[] = [];
  switch (m.freq) {
    case "daily":
      parts.push(every > 1 ? t("common:recurrence.everyDays", { count: every }) : t("common:recurrence.daily"));
      break;
    case "weekly": {
      parts.push(every > 1 ? t("common:recurrence.everyWeeks", { count: every }) : t("common:recurrence.weekly"));
      const days = readableWeekdays(m.weekdays, lng);
      if (days) parts.push(days);
      break;
    }
    case "monthly": {
      parts.push(every > 1 ? t("common:recurrence.everyMonths", { count: every }) : t("common:recurrence.monthly"));
      if (m.monthDay) parts.push(t("common:recurrence.onDay", { day: m.monthDay }));
      break;
    }
    default:
      // Una frecuencia que esta versión no conoce: enseñar el identificador es
      // feo, pero es información; una cadena vacía sería una regla invisible.
      return m.freq;
  }
  return parts.join(" · ");
}
