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


/**
 * Mirrors the session into the Rust core.
 *
 * The media protocol handler serves attachment bytes outside any call the UI
 * made, so it can't be handed credentials per request — it reads them from
 * here. Fire-and-forget: a failure only means an image won't load, and the next
 * sign-in sets it again.
 */
function mirrorToCore(token: string | null) {
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) return;
  void import("@tauri-apps/api/core")
    .then(({ invoke }) =>
      invoke("set_session", {
        token,
        baseUrl: import.meta.env.VITE_API_URL ?? "https://cac.guz-studio.dev",
      }),
    )
    .catch(() => {});
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
        mirrorToCore(accessToken);
        set({ session, accessToken, refreshToken, guest: false });
      },

      setSession: (session) => set({ session }),

      clearAuth: () => {
        localStorage.removeItem("access_token");
        mirrorToCore(null);
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
      // On a cold start the token comes back from storage without going through
      // setAuth, so the core would never learn it and every attachment would
      // 401 until the next sign-in.
      onRehydrateStorage: () => (state) => mirrorToCore(state?.accessToken ?? null),
    }
  )
);
