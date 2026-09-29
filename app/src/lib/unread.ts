import type { DMSummary } from "@/store/dm.store";

/**
 * Lo no leído **de la org en pantalla**.
 *
 * Los dos contadores vienen del servidor con todas tus orgs juntas —los
 * directos, porque la lista de conversaciones es una sola; los canales, porque
 * `/chat/unread` no se acota—, y la barra lateral los sumaba enteros: un
 * mensaje de otro cliente encendía el número aquí y, al entrar, no había nada
 * que leer. Se filtra al pintar, en un solo sitio para las dos pantallas que
 * los cuentan.
 */
export function dmUnreadIn(conversations: DMSummary[], orgId: string | null): number {
  return conversations.reduce((n, c) => n + (c.orgId === orgId ? c.unread : 0), 0);
}

/**
 * Los canales cuentan si están en el árbol, que siempre es el de la org en
 * pantalla: un canal es un espacio, y el árbol es la lista de sus espacios.
 */
export function channelUnreadIn(unreadBySpace: Record<string, number>, spaceIds: Set<string>): number {
  let n = 0;
  for (const [id, c] of Object.entries(unreadBySpace)) if (spaceIds.has(id)) n += c;
  return n;
}
