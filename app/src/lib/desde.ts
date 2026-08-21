/**
 * Cuánto hace, dicho como lo diría alguien.
 *
 * Vive aquí y no en la pantalla que lo estrenó porque la de organización lo usa
 * en dos sitios que no se hablan entre sí —la actividad de un miembro y la edad
 * de una invitación— y dos copias divergen a la primera corrección.
 */
export function desde(iso?: string | null): string {
  if (!iso) return "never";
  const min = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
  if (min < 2) return "now";
  if (min < 60) return `${min} min ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.floor(h / 24);
  if (d === 1) return "yesterday";
  return `${d} d ago`;
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
  if (h < 24) return `${Math.max(h, 1)} h left`;
  return `${Math.floor(h / 24)} d left`;
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
