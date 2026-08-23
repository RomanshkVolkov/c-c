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
  },
});
