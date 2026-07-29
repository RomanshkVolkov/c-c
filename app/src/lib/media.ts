import { apiUrl } from "@/lib/api";
import { useAuthStore } from "@/store/auth.store";

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
  const token = useAuthStore.getState().accessToken;
  if (!token) return apiUrl(path);
  const sep = path.includes("?") ? "&" : "?";
  return apiUrl(path) + `${sep}token=${encodeURIComponent(token)}`;
}
