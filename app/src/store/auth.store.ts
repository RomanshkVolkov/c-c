import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { Session } from "@/types/auth";

interface AuthState {
  session: Session | null;
  accessToken: string | null;
  refreshToken: string | null;
  // guest: the user chose "continue as guest" from the login screen. Grants
  // access to the on-device tools (Image Tool, Crypto Tools) without signing in.
  guest: boolean;
  setAuth: (session: Session, accessToken: string, refreshToken: string) => void;
  setSession: (session: Session) => void;
  clearAuth: () => void;
  continueAsGuest: () => void;
  isAuthenticated: () => boolean;
  isGuest: () => boolean;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      session: null,
      accessToken: null,
      refreshToken: null,
      guest: false,

      setAuth: (session, accessToken, refreshToken) => {
        localStorage.setItem("access_token", accessToken);
        set({ session, accessToken, refreshToken, guest: false });
      },

      setSession: (session) => set({ session }),

      clearAuth: () => {
        localStorage.removeItem("access_token");
        set({ session: null, accessToken: null, refreshToken: null });
      },

      continueAsGuest: () => set({ guest: true }),

      isAuthenticated: () => !!get().accessToken,

      // A guest is someone in guest mode who is NOT actually signed in.
      isGuest: () => get().guest && !get().accessToken,
    }),
    {
      name: "cac-auth",
      partialize: (state) => ({
        session: state.session,
        accessToken: state.accessToken,
        refreshToken: state.refreshToken,
        guest: state.guest,
      }),
    }
  )
);
