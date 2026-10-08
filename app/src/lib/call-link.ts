import { apiUrl } from "@/lib/api";

/**
 * El enlace que se le manda a alguien de fuera.
 *
 * Va a la versión web (`/app/join`), que es lo único que tiene quien no tiene
 * la app, y el token **detrás de `#`**: lo que va después del `#` no sale del
 * navegador, así que no acaba en los logs de nginx ni del Gateway. Ver
 * `docs/voz.md` §9.
 *
 * En el escritorio la base es la de la API —la web vive en el mismo dominio—;
 * en la web, la API es relativa y la base es la propia página.
 */
export function guestLinkFor(token: string): string {
  const base = apiUrl("") || window.location.origin;
  return `${base}/app/join#${token}`;
}

/** El token de un enlace de invitado, leído del `#` de la página. */
export function tokenFromHash(hash: string): string {
  return decodeURIComponent(hash.replace(/^#/, "")).trim();
}
