import type { APIResponse, AuthRefreshResponse } from "@/types/auth";
import { useAuthStore } from "@/store/auth.store";

const BASE_URL = import.meta.env.VITE_API_URL ?? "https://cac.guz-studio.dev";

const REQUEST_TIMEOUT_MS = 12_000;

type RequestOptions = RequestInit & { auth?: boolean };

let refreshPromise: Promise<string | null> | null = null;

/**
 * fetch with a hard timeout. Without this, a request over a stale/dead pooled
 * keep-alive socket (common after the app sits idle and the server closed the
 * connection) never settles — freezing the UI until an app restart. On timeout
 * we abort so the caller can surface an error / retry on a fresh connection.
 */
async function fetchWithTimeout(input: string, init: RequestInit = {}): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(input, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function tryRefresh(): Promise<string | null> {
  if (refreshPromise) return refreshPromise;

  refreshPromise = (async () => {
    const { refreshToken, session, setAuth, clearAuth } = useAuthStore.getState();
    if (!refreshToken) { clearAuth(); return null; }

    try {
      const res = await fetchWithTimeout(`${BASE_URL}/api/v1/auth/refresh`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${refreshToken}`,
        },
      });
      const json: APIResponse<AuthRefreshResponse> = await res.json();
      // Only a real auth failure (bad/expired refresh token) clears the session.
      if (!res.ok || !json.success || !json.data) { clearAuth(); return null; }

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

  let res: Response;
  try {
    res = await fetchWithTimeout(`${BASE_URL}${path}`, { ...init, headers });
  } catch {
    // Timeout/network (often a stale pooled socket after idle). Retry once on a
    // fresh connection before surfacing an error, so the UI self-heals.
    if (retry) return request<T>(path, options, false);
    throw new Error("network-error");
  }
  const json = await res.json();

  if (!res.ok) {
    const errorMsg: string = json?.error ?? json?.message ?? "Request failed";

    if (errorMsg === "expired-token" && auth && retry) {
      const newToken = await tryRefresh();
      if (newToken) return request<T>(path, options, false);
      throw new Error("session-expired");
    }

    throw new Error(errorMsg);
  }

  return json as T;
}

// postForm sends multipart/form-data (comments/images). Does NOT set
// Content-Type so the browser adds the boundary; reuses the auth+refresh flow.
async function postForm<T>(path: string, form: FormData, retry = true): Promise<T> {
  const token = useAuthStore.getState().accessToken;
  const headers: Record<string, string> = {};
  if (token) headers["Authorization"] = `Bearer ${token}`;

  let res: Response;
  try {
    res = await fetchWithTimeout(`${BASE_URL}${path}`, { method: "POST", body: form, headers });
  } catch {
    if (retry) return postForm<T>(path, form, false);
    throw new Error("network-error");
  }
  const json = await res.json();
  if (!res.ok) {
    const errorMsg: string = json?.error ?? json?.message ?? "Request failed";
    if (errorMsg === "expired-token" && retry) {
      const newToken = await tryRefresh();
      if (newToken) return postForm<T>(path, form, false);
      throw new Error("session-expired");
    }
    throw new Error(errorMsg);
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

export const api = {
  get: <T>(path: string, auth = true) =>
    request<T>(path, { method: "GET", auth }),

  postForm,

  post: <T>(path: string, body: unknown, auth = false) =>
    request<T>(path, { method: "POST", body: JSON.stringify(body), auth }),

  put: <T>(path: string, body: unknown, auth = true) =>
    request<T>(path, { method: "PUT", body: JSON.stringify(body), auth }),

  patch: <T>(path: string, body: unknown, auth = true) =>
    request<T>(path, { method: "PATCH", body: JSON.stringify(body), auth }),

  delete: <T>(path: string, auth = true) =>
    request<T>(path, { method: "DELETE", auth }),
};
