import { phraseFor } from "@/lib/server-errors";

import type { APIResponse, AuthRefreshResponse } from "@/types/auth";
import { useAuthStore } from "@/store/auth.store";
import { useConnectionStore } from "@/store/connection.store";

const BASE_URL = import.meta.env.VITE_API_URL ?? "https://cac.guz-studio.dev";

const REQUEST_TIMEOUT_MS = 12_000;

type RequestOptions = RequestInit & { auth?: boolean };

let refreshPromise: Promise<string | null> | null = null;

/** What every transport returns: status plus the raw body, nothing else. */
interface Reply {
  status: number;
  body: string;
}

/**
 * Requests go through the Rust core, not the webview.
 *
 * The webview's connection pool is the reason the app could look frozen: a call
 * over a socket the server had already closed never settled, and nothing in JS
 * can inspect or evict that pool. Rust owns this one — idle sockets are retired
 * on our schedule and every request has a hard deadline.
 *
 * The `fetch` path below is the fallback for running the UI outside Tauri (a
 * plain browser during development), where `invoke` doesn't exist.
 */
const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

async function send(
  url: string,
  method: string,
  headers: Record<string, string>,
  body?: string,
): Promise<Reply> {
  if (inTauri) {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<Reply>("api_request", {
      req: {
        method,
        url,
        headers: Object.entries(headers),
        body: body ?? null,
        timeoutMs: REQUEST_TIMEOUT_MS,
      },
    });
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, { method, headers, body, signal: ctrl.signal });
    return { status: res.status, body: await res.text() };
  } finally {
    clearTimeout(timer);
  }
}

/** Body parsing is the caller's job everywhere; empty bodies are normal. */
function parse(reply: Reply): any {
  if (!reply.body) return {};
  try {
    return JSON.parse(reply.body);
  } catch {
    return { error: reply.body.slice(0, 200) };
  }
}

async function tryRefresh(): Promise<string | null> {
  if (refreshPromise) return refreshPromise;

  refreshPromise = (async () => {
    const { refreshToken, session, setAuth, clearAuth } = useAuthStore.getState();
    if (!refreshToken) { clearAuth(); return null; }

    try {
      const reply = await send(`${BASE_URL}/api/v1/auth/refresh`, "POST", {
        "Content-Type": "application/json",
        Authorization: `Bearer ${refreshToken}`,
      });
      const json = parse(reply) as APIResponse<AuthRefreshResponse>;
      // Only a real auth failure (bad/expired refresh token) clears the session.
      if (reply.status >= 400 || !json.success || !json.data) { clearAuth(); return null; }

      setAuth(session!, json.data.accessToken, json.data.refreshToken);
      return json.data.accessToken;
    } catch {
      // Network/timeout (e.g. stale socket after idle) is transient — keep the
      // session so a later action can retry instead of logging the user out.
      return null;
    } finally {
      refreshPromise = null;
    }
  })();

  return refreshPromise;
}


async function request<T>(path: string, options: RequestOptions = {}, retry = true): Promise<T> {
  const { auth = false, ...init } = options;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(init.headers as Record<string, string>),
  };

  if (auth) {
    const token = useAuthStore.getState().accessToken;
    if (token) headers["Authorization"] = `Bearer ${token}`;
  }

  let reply: Reply;
  try {
    reply = await send(
      `${BASE_URL}${path}`,
      (init.method as string) ?? "GET",
      headers,
      typeof init.body === "string" ? init.body : undefined,
    );
  } catch {
    // Transport failure. Retry once on a fresh connection before surfacing it,
    // so a single dead socket heals itself instead of reaching the user.
    if (retry) return request<T>(path, options, false);
    useConnectionStore.getState().markFail("Can't reach the server");
    throw new Error("network-error");
  }
  // A 5xx is a degraded backend, not a successful round trip — a reachable
  // gateway in front of a dead API would otherwise read as healthy.
  if (reply.status >= 500) useConnectionStore.getState().markFail(`Server error (${reply.status})`);
  else useConnectionStore.getState().markOk();

  const json = parse(reply);

  if (reply.status >= 400) {
    /**
     * Dos campos con dos oficios, y hay que no confundirlos.
     *
     * `message` es la frase para leer —«That list belongs to another
     * organization»— y `error` la etiqueta para el código —`inbox-other-org`—.
     * Lo que se enseñaba era la etiqueta, así que un 409 perfectamente
     * explicado llegaba a la pantalla como «Error: inbox-other-org».
     *
     * Y el `detalle` se lee **aparte**, no del texto que se enseña. Con un solo
     * valor para las dos cosas, empezar a mostrar la frase habría dejado de
     * reconocer `expired-token` —que viaja con `message: "Unauthorized"`— y
     * nadie habría vuelto a renovar sesión: se cerraría sola en silencio.
     */
    const detalle: string = json?.error ?? "";
    const errorMsg: string = json?.message ?? json?.error ?? "Request failed";

    if (detalle === "expired-token" && auth && retry) {
      const newToken = await tryRefresh();
      if (newToken) return request<T>(path, options, false);
      throw new Error("session-expired");
    }

    throw new Error(phraseFor(detalle, errorMsg));
  }

  return json as T;
}

// postForm sends multipart/form-data (attachments). Stays on `fetch`: uploads are
// user-initiated and short-lived, so they don't hit the stale-socket problem the
// Rust transport exists to solve, and pushing 30 MB through the IPC bridge would
// cost more than it buys. Does NOT set Content-Type so the browser adds the
// boundary.
async function postForm<T>(path: string, form: FormData, retry = true): Promise<T> {
  return sendForm<T>("POST", path, form, retry);
}

/** Same transport, for endpoints that edit rather than create. */
async function patchForm<T>(path: string, form: FormData, retry = true): Promise<T> {
  return sendForm<T>("PATCH", path, form, retry);
}

async function sendForm<T>(
  method: "POST" | "PATCH",
  path: string,
  form: FormData,
  retry: boolean
): Promise<T> {
  const token = useAuthStore.getState().accessToken;
  const headers: Record<string, string> = {};
  if (token) headers["Authorization"] = `Bearer ${token}`;

  let res: Response;
  try {
    res = await fetch(`${BASE_URL}${path}`, { method, body: form, headers });
  } catch {
    if (retry) return sendForm<T>(method, path, form, false);
    useConnectionStore.getState().markFail("Can't reach the server");
    throw new Error("network-error");
  }
  if (res.status >= 500) useConnectionStore.getState().markFail(`Server error (${res.status})`);
  else useConnectionStore.getState().markOk();

  const json = await res.json();
  if (!res.ok) {
    /**
     * Dos campos con dos oficios, y hay que no confundirlos.
     *
     * `message` es la frase para leer —«That list belongs to another
     * organization»— y `error` la etiqueta para el código —`inbox-other-org`—.
     * Lo que se enseñaba era la etiqueta, así que un 409 perfectamente
     * explicado llegaba a la pantalla como «Error: inbox-other-org».
     *
     * Y el `detalle` se lee **aparte**, no del texto que se enseña. Con un solo
     * valor para las dos cosas, empezar a mostrar la frase habría dejado de
     * reconocer `expired-token` —que viaja con `message: "Unauthorized"`— y
     * nadie habría vuelto a renovar sesión: se cerraría sola en silencio.
     */
    const detalle: string = json?.error ?? "";
    const errorMsg: string = json?.message ?? json?.error ?? "Request failed";
    if (detalle === "expired-token" && retry) {
      const newToken = await tryRefresh();
      if (newToken) return sendForm<T>(method, path, form, false);
      throw new Error("session-expired");
    }
    throw new Error(phraseFor(detalle, errorMsg));
  }
  return json as T;
}

/** Absolute URL for a backend path (e.g. signed image proxy URLs in a webview). */
export const apiUrl = (path: string) => `${BASE_URL}${path}`;

/**
 * If the persisted access token predates the `orgs` claim (minted before the
 * backend added organizations), force one refresh so org-scoped lists aren't
 * silently empty until the token expires. No-op for new-format tokens.
 */
export async function ensureOrgClaim(): Promise<void> {
  const token = useAuthStore.getState().accessToken;
  if (!token) return;
  try {
    const payload = JSON.parse(atob(token.split(".")[1] ?? ""));
    if (payload && "orgs" in payload) return; // already new-format
  } catch {
    return;
  }
  await tryRefresh();
}

/**
 * Force a new access token from the refresh token. Exported for the event
 * stream: when the stream is rejected as unauthorized there may be no API call
 * pending to trigger the usual refresh, and without one the app would sit with
 * live updates off until the user did something.
 */
export function refreshAccessToken(): Promise<string | null> {
  return tryRefresh();
}

/**
 * Refresh the persisted session from /auth/me so late-added fields (e.g. the
 * `superadmin` flag) populate for sessions minted before they existed — without
 * forcing a re-login. Best-effort; silent on failure.
 */
export async function refreshSession(): Promise<void> {
  const token = useAuthStore.getState().accessToken;
  if (!token) return;
  try {
    const reply = await send(`${BASE_URL}/api/v1/auth/me`, "GET", {
      Authorization: `Bearer ${token}`,
    });
    const json = parse(reply);
    if (reply.status < 400 && json?.success && json?.data) {
      useAuthStore.getState().setSession(json.data);
      // El idioma que trae la sesión manda sobre el guardado aquí: ver
      // `locale-sync.ts`. Importado en caliente porque este módulo es el que
      // aquél importa, y al revés sería un ciclo.
      void import("@/lib/locale-sync").then((m) => m.adoptServerLocale(json.data));
    }
  } catch {
    // best-effort
  }
}

export const api = {
  get: <T>(path: string, auth = true) =>
    request<T>(path, { method: "GET", auth }),

  postForm,
  patchForm,

  post: <T>(path: string, body: unknown, auth = false) =>
    request<T>(path, { method: "POST", body: JSON.stringify(body), auth }),

  put: <T>(path: string, body: unknown, auth = true) =>
    request<T>(path, { method: "PUT", body: JSON.stringify(body), auth }),

  patch: <T>(path: string, body: unknown, auth = true) =>
    request<T>(path, { method: "PATCH", body: JSON.stringify(body), auth }),

  delete: <T>(path: string, auth = true) =>
    request<T>(path, { method: "DELETE", auth }),
};
