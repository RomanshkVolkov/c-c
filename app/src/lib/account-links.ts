import { api } from "@/lib/api";
import { isWebBuild } from "@/lib/platform";
import type { APIResponse, AuthResponse } from "@/types/auth";

/**
 * El alta por correo y «olvidé mi contraseña», del lado de quien todavía no
 * tiene sesión (ver `backend/internal/core/domain/account.go`).
 *
 * El enlace del correo es `/app/welcome#<token>` o `/app/reset-password#<token>`:
 * el token detrás del `#` no llega a ningún servidor ni a sus logs, igual que
 * el de invitado a una llamada. Todo va **sin sesión** (`auth = false`), como
 * `publicCalls`: mandar el token de una visita anterior no tendría sentido.
 */

export interface AccountLinkInfo {
  purpose: "welcome" | "reset";
  name: string;
  email: string;
  orgName?: string;
}

/** Lo que puede elegir alguien como usuario. El servidor lo vuelve a mirar. */
export const USERNAME_PATTERN = /^[a-z0-9][a-z0-9._-]{2,39}$/;

/** Como lo guarda el servidor: sin espacios y en minúsculas. */
export const normalizeUsername = (s: string) => s.trim().toLowerCase();

const client = isWebBuild ? { client: "web" } : {};

function must<T>(r: APIResponse<T>, fallback: string): T {
  if (!r.data) throw new Error(r.error ?? fallback);
  return r.data;
}

export const publicAccount = {
  inspect: async (token: string) =>
    must(await api.post<APIResponse<AccountLinkInfo>>("/api/v1/public/account/inspect", { token }, false), "link-invalid"),

  welcome: async (token: string, username: string, password: string) =>
    must(
      await api.post<APIResponse<AuthResponse>>(
        "/api/v1/public/account/welcome",
        { token, username: normalizeUsername(username), password, ...client },
        false,
      ),
      "link-invalid",
    ),

  forgot: async (login: string) => {
    await api.post<APIResponse<unknown>>("/api/v1/public/account/forgot", { login: login.trim() }, false);
  },

  reset: async (token: string, password: string) =>
    must(
      await api.post<APIResponse<AuthResponse>>("/api/v1/public/account/reset", { token, password, ...client }, false),
      "link-invalid",
    ),
};
