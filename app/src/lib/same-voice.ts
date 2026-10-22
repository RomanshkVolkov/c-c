/**
 * Si un mensaje va pegado al anterior, sin su cabecera (nombre, hora, marca).
 *
 * Sólo si es de la misma persona **y** entró por el mismo sitio. Un agente
 * escribe con el token de su dueño, así que agrupar por autor pegaba un
 * mensaje de agente debajo de uno de la persona y le quitaba la cabecera, que
 * es justo donde va la marca «vía agente» (22-oct-2026).
 */
export function sameVoice(
  prev: { authorUserId: string; via?: string } | undefined,
  m: { authorUserId: string; via?: string },
): boolean {
  if (!prev) return false;
  return prev.authorUserId === m.authorUserId && (prev.via ?? "") === (m.via ?? "");
}
