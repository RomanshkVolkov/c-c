/**
 * Zonas horarias dichas como las dice una persona: una ciudad y cuánto se
 * separa de UTC hoy —«Cancun (UTC−5)»—, no «America/Cancun» ni «GMT-5».
 *
 * Igual que `meeting-time.ts`: nunca aritmética de desfases a mano. El desfase
 * se le pregunta a la plataforma para un instante concreto, porque cambia con
 * el horario de verano.
 */

/** La ciudad de una zona IANA: «America/Argentina/Buenos_Aires» → «Buenos Aires». */
export function zoneCity(zone: string): string {
  const last = zone.split("/").pop() ?? zone;
  return last.replace(/_/g, " ");
}

/** «UTC−5», «UTC+5:30», «UTC» — el desfase de la zona en ese instante. */
export function zoneOffset(zone: string, at: Date = new Date()): string {
  try {
    const raw =
      new Intl.DateTimeFormat("en", { timeZone: zone, timeZoneName: "shortOffset" })
        .formatToParts(at)
        .find((p) => p.type === "timeZoneName")?.value ?? "";
    // «GMT-5», «GMT+5:30», «GMT».
    const m = raw.match(/^GMT([+-])?(\d{1,2})(?::(\d{2}))?$/);
    // «GMT» a secas o «GMT+0»: es UTC.
    if (!m || !m[1] || (Number(m[2]) === 0 && (!m[3] || m[3] === "00"))) return "UTC";
    return `UTC${m[1] === "-" ? "−" : "+"}${Number(m[2])}${m[3] && m[3] !== "00" ? `:${m[3]}` : ""}`;
  } catch {
    return "";
  }
}

/** «Cancun (UTC−5)». */
export function zoneLabel(zone: string, at: Date = new Date()): string {
  const off = zoneOffset(zone, at);
  return off ? `${zoneCity(zone)} (${off})` : zoneCity(zone);
}

/** La zona de quien mira. */
export function myZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/** Si la plataforma conoce la zona. */
export function isZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: zone });
    return !!zone;
  } catch {
    return false;
  }
}

/** Todas las zonas que conoce la plataforma, ordenadas por ciudad. */
export function allZones(): string[] {
  const intl = Intl as unknown as { supportedValuesOf?: (k: string) => string[] };
  const list = intl.supportedValuesOf?.("timeZone") ?? [];
  return [...new Set(list)].sort((a, b) => zoneCity(a).localeCompare(zoneCity(b)));
}

/** Año, mes y día de hoy **en esa zona**. */
function todayIn(zone: string, now: Date): { y: number; m: number; d: number } {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(now)
    .reduce<Record<string, string>>((acc, p) => ({ ...acc, [p.type]: p.value }), {});
  return { y: Number(parts.year), m: Number(parts.month), d: Number(parts.day) };
}

/** El desfase de la zona en minutos en ese instante (CDMX = −360). */
function offsetMinutes(zone: string, at: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  })
    .formatToParts(at)
    .reduce<Record<string, string>>((acc, p) => ({ ...acc, [p.type]: p.value }), {});
  const asUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute));
  return Math.round((asUtc - Math.floor(at.getTime() / 60000) * 60000) / 60000);
}

/**
 * El instante en que hoy son las `wallTime` («09:30») en `zone`. Sirve para
 * enseñar, mientras se escribe la reunión, a qué hora le suena a cada quien.
 *
 * Se ajusta dos veces: el desfase de la zona puede cambiar entre la primera
 * estimación y la hora pedida (un cambio de horario esa misma mañana).
 */
export function wallTimeToday(wallTime: string, zone: string, now: Date = new Date()): Date | null {
  const m = wallTime.match(/^(\d{1,2}):(\d{2})$/);
  if (!m || !isZone(zone)) return null;
  const { y, m: mo, d } = todayIn(zone, now);
  const naive = Date.UTC(y, mo - 1, d, Number(m[1]), Number(m[2]));
  let at = new Date(naive - offsetMinutes(zone, new Date(naive)) * 60000);
  at = new Date(naive - offsetMinutes(zone, at) * 60000);
  return at;
}

/** «09:30» de un instante, en una zona o en la de quien mira. */
export function hourIn(instant: Date, zone?: string): string {
  return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", timeZone: zone }).format(instant);
}
