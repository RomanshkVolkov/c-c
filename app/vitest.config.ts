import path from "path";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

/**
 * Kept apart from vite.config.ts on purpose: that one is async and carries the
 * Tauri dev-server settings (fixed port, strictPort, HMR host), none of which
 * mean anything under a test runner and one of which — strictPort — would make
 * a test run fail while the app is open.
 */
export default defineConfig({
  plugins: [react()],
  resolve: { alias: { "@": path.resolve(__dirname, "./src") } },
  test: {
    environment: "jsdom",
    // jsdom no trae `matchMedia`; ver src/test-setup.ts.
    setupFiles: ["./src/test-setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
    restoreMocks: true,
    /**
     * Cuatro procesos, no doce.
     *
     * Por defecto vitest abre un worker por núcleo y cada uno monta su propio
     * jsdom. En esta máquina —12 núcleos, 16 GiB compartidos con el editor, los
     * servidores de lenguaje y un navegador— eso llevó la memoria al límite y el
     * kernel se puso a matar procesos: se llevó el navegador, la barra y
     * **1Password**, con lo que dejó de poder firmarse un commit. El síntoma no
     * se parecía en nada a la causa.
     *
     * Cuatro tarda algo más y deja la máquina usable mientras corre. Un runner
     * que para de trabajar a quien lo lanzó no está haciendo su trabajo.
     */
    maxWorkers: 4,
    minWorkers: 1,
  },
});
