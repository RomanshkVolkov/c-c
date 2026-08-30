import i18next from "i18next";

/**
 * Cuánto hace, dicho como lo diría alguien.
 *
 * Vive aquí y no en la pantalla que lo estrenó porque la de organización lo usa
 * en dos sitios que no se hablan entre sí —la actividad de un miembro y la edad
 * de una invitación— y dos copias divergen a la primera corrección.
 *
 * Lo dice **`Intl`**, no el catálogo. Un tiempo relativo lleva dentro un plural
 * y una preposición que cambian con el número y con el idioma —«hace 1 minuto»,
 * «hace 2 minutos», «1 minute ago»— y ponerlo a mano era escribir una tabla de
 * formas que la plataforma ya trae para todos los idiomas. Lo que sí queda en el
 * catálogo son las dos palabras que no son tiempo: «nunca» y «ahora».
 */
export function desde(iso?: string | null): string {
  if (!iso) return i18next.t("common:time.never");
  const min = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
  // «Ahora» y no «hace 0 minutos»: por debajo de dos minutos la cifra no aporta
  // nada y la frase se lee peor.
  if (min < 2) return i18next.t("common:time.now");
  if (min < 60) return relativo(-min, "minute");
  const h = Math.floor(min / 60);
  if (h < 24) return relativo(-h, "hour");
  return relativo(-Math.floor(h / 24), "day");
}

/**
 * El formateador, uno por idioma y reutilizado.
 *
 * Construir un `Intl.RelativeTimeFormat` cuesta lo suyo, y esto se llama una vez
 * por fila de una lista que se repinta al llegar cada evento.
 *
 * `numeric: "auto"` es lo que convierte «hace 1 día» en «ayer» — y en «yesterday»
 * cuando toca. Era una rama escrita a mano; ahora la pone quien sabe hacerlo en
 * los dos idiomas.
 */
const formateadores = new Map<string, Intl.RelativeTimeFormat>();

function relativo(valor: number, unidad: Intl.RelativeTimeFormatUnit): string {
  const lng = i18next.language || "en";
  let f = formateadores.get(lng);
  if (!f) {
    f = new Intl.RelativeTimeFormat(lng, { numeric: "auto", style: "short" });
    formateadores.set(lng, f);
  }
  return f.format(valor, unidad);
}

/**
 * Cuánta ausencia se tolera antes de apagar el punto.
 *
 * Diez minutos, y no menos, por dos razones que se suman: la marca se escribe
 * como mucho una vez cada cinco (`TouchLastSeen`), y el stream late cada 25
 * segundos. Con una ventana más corta el punto parpadearía por el propio tope,
 * no por la persona.
 */
const VENTANA_MIN = 10;

/**
 * Si esta persona ha dado señales hace poco.
 *
 * **No es «en línea ahora»** y no debe llamarse así en pantalla: el dato puede
 * traer hasta cinco minutos de retraso por el tope de escritura. Es «ha estado
 * por aquí hace nada», que es lo que se puede sostener.
 */
export function activo(iso?: string | null): boolean {
  if (!iso) return false;
  return Date.now() - new Date(iso).getTime() < VENTANA_MIN * 60_000;
}

/** Lo mismo mirando al futuro: lo que le queda a un plazo. */
export function faltan(iso?: string | null): string {
  if (!iso) return "";
  const h = Math.floor((new Date(iso).getTime() - Date.now()) / 3_600_000);
  if (h < 0) return "";
  // Al menos una hora: «en 0 horas» para algo que vence en cuarenta minutos
  // suena a que ya venció.
  if (h < 24) return relativo(Math.max(h, 1), "hour");
  return relativo(Math.floor(h / 24), "day");
}

/** Si un plazo ya pasó. Un `expiresAt` ausente nunca vence. */
export function vencio(iso?: string | null): boolean {
  return !!iso && new Date(iso).getTime() <= Date.now();
}

/** Las iniciales con las que se dibuja un avatar sin foto. */
export function iniciales(nombre?: string): string {
  const limpio = (nombre ?? "").replace(/^@/, "").trim();
  if (!limpio) return "?";
  const partes = limpio.split(/[\s._-]+/).filter(Boolean);
  if (partes.length >= 2) return (partes[0][0] + partes[1][0]).toUpperCase();
  return limpio.slice(0, 2).toUpperCase();
}
