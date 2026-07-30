import { apiUrl } from "@/lib/api";
import { useAuthStore } from "@/store/auth.store";

const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** Must match media::SCHEME in the Rust core. */
const MEDIA_SCHEME = "cacmedia";

/**
 * Tauri's own helper, imported lazily-ish: it builds the platform-correct URL
 * (`cacmedia://localhost/…` on Linux and macOS, `http://cacmedia.localhost/…`
 * on Windows), which is not something to hand-roll.
 */
function convertFileSrc(path: string, scheme: string): string {
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

  // Browser (development): no custom scheme, so fall back to the query string.
  const token = useAuthStore.getState().accessToken;
  if (!token) return apiUrl(path);
  const sep = path.includes("?") ? "&" : "?";
  return apiUrl(path) + `${sep}token=${encodeURIComponent(token)}`;
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
