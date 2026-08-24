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
function enZona(instante: Date, timeZone?: string): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    timeZone,
  }).format(instante);
}

/**
 * El nombre corto de la zona, para poder decir «9:00 CST» y no sólo «9:00».
 *
 * Sin él las dos horas se parecen demasiado y no se sabe cuál es cuál.
 */
function nombreDeZona(instante: Date, timeZone?: string): string {
  const partes = new Intl.DateTimeFormat("en", {
    timeZone,
    timeZoneName: "short",
  }).formatToParts(instante);
  return partes.find((p) => p.type === "timeZoneName")?.value ?? "";
}

export interface HoraDual {
  /** La hora en la zona de la reunión, con el nombre de esa zona. */
  alla: string;
  /** La misma hora donde está quien mira. */
  aqui: string;
  /** Si las dos coinciden, no hace falta enseñar las dos. */
  mismaZona: boolean;
}

/**
 * `horaDual("2026-08-25T15:00:00Z", "America/Mexico_City")` para alguien en
 * Madrid da `{ alla: "09:00 CST", aqui: "17:00 CEST", mismaZona: false }`.
 *
 * `mismaZona` compara **el texto formateado**, no las cadenas de zona: quien
 * mira desde Cancún y una reunión de Bogotá ven la misma hora aunque las zonas
 * se llamen distinto, y repetirla dos veces sólo sería ruido.
 */
export function horaDual(instante: string | Date, timeZone: string): HoraDual {
  const cuando = typeof instante === "string" ? new Date(instante) : instante;
  if (Number.isNaN(cuando.getTime())) {
    return { alla: "", aqui: "", mismaZona: true };
  }

  let alla: string;
  try {
    alla = `${enZona(cuando, timeZone)} ${nombreDeZona(cuando, timeZone)}`.trim();
  } catch {
    // Una zona que esta plataforma no conoce: mejor enseñar sólo la hora local
    // que romper la pantalla entera por un nombre mal escrito.
    return { alla: "", aqui: enZona(cuando), mismaZona: true };
  }
  const aqui = `${enZona(cuando)} ${nombreDeZona(cuando)}`.trim();

  return { alla, aqui, mismaZona: alla === aqui };
}

/** «9:00 CST · 17:00 CEST», o sólo la hora cuando las dos coinciden. */
export function horaLegible(instante: string | Date, timeZone: string): string {
  const { alla, aqui, mismaZona } = horaDual(instante, timeZone);
  if (!alla) return aqui;
  return mismaZona ? alla : `${alla} · ${aqui}`;
}

/** Los días de la semana de "1,3,5", dichos como los diría una persona. */
export function diasLegibles(weekdays: string | undefined): string {
  const nombres = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const dias = (weekdays ?? "")
    .split(",")
    .map((d) => d.trim())
    // Descartar el vacío **antes** de convertir: `Number("")` es 0, no `NaN`,
    // así que una regla sin días se leía como «domingo». Lo cazó una prueba.
    .filter((d) => d !== "")
    .map(Number)
    .filter((d) => Number.isInteger(d) && d >= 0 && d <= 6);
  if (dias.length === 0) return "";
  // Ordenados de lunes a domingo, que es como se lee una semana de trabajo —
  // el domingo es el 0 pero nadie empieza la semana nombrándolo.
  dias.sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7));
  return dias.map((d) => nombres[d]).join(", ");
}

/** La regla entera en una línea: «Weekly · Mon, Wed · 09:00 CST». */
export function reglaLegible(m: {
  freq: string;
  interval?: number;
  weekdays?: string;
  monthDay?: number;
}): string {
  const cada = (m.interval ?? 1) > 1 ? `Every ${m.interval} ` : "";
  switch (m.freq) {
    case "daily":
      return cada ? `${cada}days` : "Daily";
    case "weekly": {
      const dias = diasLegibles(m.weekdays);
      const base = cada ? `${cada}weeks` : "Weekly";
      return dias ? `${base} · ${dias}` : base;
    }
    case "monthly": {
      const base = cada ? `${cada}months` : "Monthly";
      return m.monthDay ? `${base} · day ${m.monthDay}` : base;
    }
    default:
      return m.freq;
  }
}
