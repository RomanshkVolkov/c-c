import { adoptServerLocale } from "@/lib/locale-sync";
import { api, revokeSession } from "@/lib/api";
import { isWebBuild } from "@/lib/platform";
import { leaveWeb } from "@/lib/leave-web";
import { useAuthStore } from "@/store/auth.store";
import { useOrgsStore } from "@/store/orgs.store";
import { useInvitationsStore } from "@/store/invitations.store";
import type { APIResponse, AuthResponse } from "@/types/auth";

export function useAuth() {
  const { session, setAuth, clearAuth, isAuthenticated } = useAuthStore();

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

    const { session, accessToken, refreshToken } = res.data;
    setAuth(session, accessToken, refreshToken);
    // Entrar en la aplicación es enterarse de en qué idioma la lees.
    adoptServerLocale(session);
    return res.data;
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
