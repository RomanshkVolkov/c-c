import { api } from "@/lib/api";
import { useAuthStore } from "@/store/auth.store";
import type { APIResponse, AuthResponse } from "@/types/auth";

export function useAuth() {
  const { session, setAuth, clearAuth, isAuthenticated } = useAuthStore();

  const login = async (username: string, password: string) => {
    const res = await api.post<APIResponse<AuthResponse>>("/api/v1/auth/login", {
      username,
      password,
    });

    if (!res.success || !res.data) {
      throw new Error(res.error ?? "Login failed");
    }

    const { session, accessToken, refreshToken } = res.data;
    setAuth(session, accessToken, refreshToken);
    return res.data;
  };

  const logout = () => {
    clearAuth();
  };

  return { session, login, logout, isAuthenticated };
}
