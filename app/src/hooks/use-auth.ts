import { adoptServerLocale } from "@/lib/locale-sync";
import { api, revokeSession } from "@/lib/api";
import { isWebBuild } from "@/lib/platform";
import { leaveWeb } from "@/lib/leave-web";
import { useAuthStore } from "@/store/auth.store";
import { useOrgsStore } from "@/store/orgs.store";
import { useInvitationsStore } from "@/store/invitations.store";
import type { APIResponse, AuthResponse } from "@/types/auth";

/**
 * Abre la sesión con lo que devolvió el servidor: el login, y también el
 * enlace del correo (terminar el registro, restablecer la contraseña).
 */
export function startSession(data: AuthResponse): AuthResponse {
  const { session, accessToken, refreshToken } = data;
  useAuthStore.getState().setAuth(session, accessToken, refreshToken);
  // Entrar en la aplicación es enterarse de en qué idioma la lees.
  adoptServerLocale(session);
  return data;
}

export function useAuth() {
  const { session, clearAuth, isAuthenticated } = useAuthStore();

  const login = async (username: string, password: string) => {
    const res = await api.post<APIResponse<AuthResponse>>("/api/v1/auth/login", {
      username,
      password,
      // La sesión web va marcada en el token: el servidor le cierra lo que es
      // sólo del escritorio (servidores, tokens personales).
      ...(isWebBuild ? { client: "web" } : {}),
    });

    if (!res.success || !res.data) {
      throw new Error(res.error ?? "Login failed");
    }
    return startSession(res.data);
  };

  const logout = () => {
    // En la web, salir es también olvidar este navegador. Ver leaveWeb.
    if (isWebBuild) {
      void leaveWeb(useAuthStore.getState().refreshToken);
      return;
    }
    // Se avisa al servidor sin esperar: la pantalla sale ya, y el refresh se
    // revoca por detrás. Se lee antes de `clearAuth`, que lo borra.
    void revokeSession(useAuthStore.getState().refreshToken);
    clearAuth();
    useOrgsStore.getState().reset();
    useInvitationsStore.getState().reset();
  };

  return { session, login, logout, isAuthenticated };
}
