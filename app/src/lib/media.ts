import { isTauri } from "@/lib/platform";
import { apiUrl } from "@/lib/api";
import { currentMediaTicket } from "@/lib/url-ticket";

const inTauri = isTauri;

/** Must match media::SCHEME in the Rust core. */
const MEDIA_SCHEME = "cacmedia";

/**
 * Tauri's own helper, imported lazily-ish: it builds the platform-correct URL
 * (`cacmedia://localhost/…` on Linux and macOS, `http://cacmedia.localhost/…`
 * on Windows), which is not something to hand-roll.
 */
export function convertFileSrc(path: string, scheme: string): string {
  const w = window as unknown as { __TAURI_INTERNALS__?: { convertFileSrc?: (p: string, s: string) => string } };
  const convert = w.__TAURI_INTERNALS__?.convertFileSrc;
  return convert ? convert(path, scheme) : path;
}

/**
 * Canonical form of an attachment reference: the backend path, no origin and no
 * credentials. This is what gets stored in markdown, so a description written
 * against production still resolves in a local build — and so a token can never
 * end up persisted in the database.
 *
 * Returns null for anything that isn't one of our attachment references.
 */
export function attachmentPath(src: string | undefined): string | null {
  if (!src) return null;

  let path = src;
  // The editor renders images through mediaSrc(), and a DOM round-trip (paste,
  // undo, re-parse) can feed that rendered value back into the node's own attrs.
  // Absolute forms therefore have to be accepted and normalized, not ignored.
  const base = apiUrl("");
  if (path.startsWith(base)) path = path.slice(base.length);
  else if (/^https?:\/\//.test(path)) {
    try {
      const u = new URL(path);
      path = u.pathname + u.search;
    } catch {
      return null;
    }
  }
  if (!path.startsWith("/api/")) return null;

  // Drop any credential that rode along; it's re-added at render time.
  const [p, query = ""] = path.split("?");
  const params = new URLSearchParams(query);
  params.delete("token");
  const rest = params.toString();
  return rest ? `${p}?${rest}` : p;
}

/**
 * Resolves a stored media reference into something the webview can actually
 * load.
 *
 * Attachments live in a private bucket, so they are served by our own proxy.
 * Two things are missing from the stored path at render time: the backend
 * origin, and credentials — an `<img>`/`<a>` cannot set an Authorization
 * header, so the token rides the query string (the proxy accepts it there, same
 * as the report image proxy and the SSE stream).
 *
 * Anything that isn't ours (an external URL someone pasted) is returned as-is.
 */
export function mediaSrc(src: string | undefined): string | undefined {
  const path = attachmentPath(src);
  if (!path) return src;

  // In the app the bytes come through our own URI scheme, whose handler adds the
  // Authorization header in Rust — an <img> can't, which is why the token used
  // to ride the query string and end up in the server's access log.
  if (inTauri) return convertFileSrc(path, MEDIA_SCHEME);

  // En el navegador no hay esquema propio: la credencial va en la URL, y por eso
  // es un pase de adjuntos y no el token de acceso (ver lib/url-ticket.ts). Un
  // pase que acabe en un log sólo abre adjuntos, y media hora.
  const ticket = currentMediaTicket();
  if (!ticket) return apiUrl(path);
  const sep = path.includes("?") ? "&" : "?";
  return apiUrl(path) + `${sep}token=${encodeURIComponent(ticket)}`;
}

/**
 * Opens a non-image attachment.
 *
 * A `cacmedia://` URL only means something inside this webview, so a download
 * can't just be handed to the OS browser: Rust fetches it with the header,
 * writes a temp file and lets the system open it with the right app.
 */
export async function openAttachment(url: string, fileName: string): Promise<void> {
  const path = attachmentPath(url);
  if (!path) {
    // An external link someone pasted: hand it to the browser as-is.
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(url);
    return;
  }
  if (!inTauri) {
    window.open(mediaSrc(url), "_blank");
    return;
  }
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("open_attachment", { path, fileName });
}

/**
 * Si un enlace es un PDF adjunto, que se enseña en el visor de la app y no se
 * manda fuera. La URL de un adjunto acaba en `/raw` y no dice su tipo, así que
 * también cuenta el texto del enlace, que es el nombre del fichero.
 */
export function isPdfAttachment(href: string | undefined, label: string): boolean {
  if (!href || !attachmentPath(href)) return false;
  const pdf = /\.pdf(\?|#|$)/i;
  return pdf.test(label.trim()) || pdf.test(href);
}

export type LinkClick = "preview-pdf" | "open-file" | "follow" | "edit";

/**
 * Qué hace un clic en un enlace dentro del editor.
 *
 * - Un **adjunto** se abre con un clic normal (su texto es el nombre del
 *   fichero y casi nunca se edita): un PDF en el visor de la app, lo demás con
 *   el programa del sistema.
 * - Cualquier otro enlace, sólo con Ctrl/⌘: un clic normal pone el cursor, que
 *   es lo que se hace mil veces al editar el texto de un enlace (como Notion y
 *   Obsidian).
 *
 * Y en ningún caso navega la ventana: eso lo hace quien llama, siempre.
 */
export function linkClickAction(href: string, label: string, modifier: boolean): LinkClick {
  if (attachmentPath(href)) return isPdfAttachment(href, label) ? "preview-pdf" : "open-file";
  return modifier ? "follow" : "edit";
}

