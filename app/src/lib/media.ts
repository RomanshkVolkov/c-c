import { apiUrl } from "@/lib/api";
import { useAuthStore } from "@/store/auth.store";

/**
 * Resolves a stored media reference into something the webview can actually
 * load.
 *
 * Attachments live in a private bucket, so they are served by our own proxy and
 * stored as a relative path (`/api/v1/tasks/…/raw`). Two things are missing at
 * render time: the backend origin, and credentials — an `<img>`/`<a>` cannot set
 * an Authorization header, so the token rides the query string (the proxy
 * accepts it there, same as the report image proxy and the SSE stream).
 *
 * Anything already absolute (an external URL someone pasted) is returned as-is.
 */
export function mediaSrc(src: string | undefined): string | undefined {
  if (!src || !src.startsWith("/api/")) return src;
  const token = useAuthStore.getState().accessToken;
  const sep = src.includes("?") ? "&" : "?";
  return apiUrl(src) + (token ? `${sep}token=${encodeURIComponent(token)}` : "");
}
