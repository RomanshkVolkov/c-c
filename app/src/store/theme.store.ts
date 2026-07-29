import { create } from "zustand";
import { persist } from "zustand/middleware";

export type ThemePreference = "system" | "light" | "dark";

interface ThemeState {
  preference: ThemePreference;
  /** What's actually on screen once "system" is resolved. */
  resolved: "light" | "dark";
  setPreference: (p: ThemePreference) => void;
  /** Re-applies the class; call on boot and when the OS preference flips. */
  apply: () => void;
}

const query = () =>
  typeof window !== "undefined" && window.matchMedia
    ? window.matchMedia("(prefers-color-scheme: dark)")
    : null;

function resolve(preference: ThemePreference): "light" | "dark" {
  if (preference !== "system") return preference;
  // A control plane is a dark-first tool; if the OS won't say, assume dark.
  return query()?.matches ?? true ? "dark" : "light";
}

export const useThemeStore = create<ThemeState>()(
  persist(
    (set, get) => ({
      // Dark by default: this is an ops console (logs, stats, timelines).
      preference: "dark",
      resolved: "dark",

      apply: () => {
        const resolved = resolve(get().preference);
        document.documentElement.classList.toggle("dark", resolved === "dark");
        // Keeps native form controls / scrollbars in step with the theme.
        document.documentElement.style.colorScheme = resolved;
        set({ resolved });
      },

      setPreference: (preference) => {
        set({ preference });
        get().apply();
      },
    }),
    {
      name: "cac-theme",
      partialize: (s) => ({ preference: s.preference }),
      onRehydrateStorage: () => (state) => state?.apply(),
    },
  ),
);

/** Follow the OS while the preference is "system". */
export function watchSystemTheme() {
  const mq = query();
  if (!mq) return;
  const onChange = () => {
    if (useThemeStore.getState().preference === "system") {
      useThemeStore.getState().apply();
    }
  };
  mq.addEventListener("change", onChange);
}
