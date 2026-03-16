import type { APIResponse, AuthRefreshResponse } from "@/types/auth";
import { useAuthStore } from "@/store/auth.store";

const BASE_URL = "http://localhost:8080";

type RequestOptions = RequestInit & { auth?: boolean };

let refreshPromise: Promise<string | null> | null = null;

async function tryRefresh(): Promise<string | null> {
  if (refreshPromise) return refreshPromise;

  refreshPromise = (async () => {
    const { refreshToken, session, setAuth, clearAuth } = useAuthStore.getState();
    if (!refreshToken) { clearAuth(); return null; }

    try {
      const res = await fetch(`${BASE_URL}/api/v1/auth/refresh`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${refreshToken}`,
        },
      });
      const json: APIResponse<AuthRefreshResponse> = await res.json();
      if (!res.ok || !json.success || !json.data) { clearAuth(); return null; }

      setAuth(session!, json.data.accessToken, json.data.refreshToken);
      return json.data.accessToken;
    } catch {
      clearAuth();
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

  const res = await fetch(`${BASE_URL}${path}`, { ...init, headers });
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

export const api = {
  get: <T>(path: string, auth = true) =>
    request<T>(path, { method: "GET", auth }),

  post: <T>(path: string, body: unknown, auth = false) =>
    request<T>(path, { method: "POST", body: JSON.stringify(body), auth }),

  delete: <T>(path: string, auth = true) =>
    request<T>(path, { method: "DELETE", auth }),
};
