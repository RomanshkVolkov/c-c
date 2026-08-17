import path from "path";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },

  // Keep function and class names through minification.
  //
  // Without this a crash reports its component stack as `swt@…`, `iwt@…` — the
  // minified names — and the card the error boundary files is unreadable: the
  // one time it fired, the component had to be deduced from the route and a
  // stray `aside` in the stack. `keepNames` makes that stack say `DMSwitcher`.
  //
  // It costs a little bundle size, which is the wrong thing to optimise here:
  // this ships as an 86 MB desktop app, and the name is what turns a screenshot
  // into a fix.
  esbuild: { keepNames: true },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
