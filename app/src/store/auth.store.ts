import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { Session } from "@/types/auth";

interface AuthState {
  session: Session | null;
  accessToken: string | null;
  refreshToken: string | null;
  setAuth: (session: Session, accessToken: string, refreshToken: string) => void;
  clearAuth: () => void;
  isAuthenticated: () => boolean;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      session: null,
      accessToken: null,
      refreshToken: null,

      setAuth: (session, accessToken, refreshToken) => {
        localStorage.setItem("access_token", accessToken);
        set({ session, accessToken, refreshToken });
      },

      clearAuth: () => {
        localStorage.removeItem("access_token");
        set({ session: null, accessToken: null, refreshToken: null });
      },

      isAuthenticated: () => !!get().accessToken,
    }),
    {
      name: "cac-auth",
      partialize: (state) => ({
        session: state.session,
        accessToken: state.accessToken,
        refreshToken: state.refreshToken,
      }),
    }
  )
);
