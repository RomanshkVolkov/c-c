import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Abrir un enlace fuera de la app: `open_url` de Rust en escritorio, una
 * pestaña nueva en el navegador.
 *
 * Roturas que detecta:
 * - usar siempre lo de escritorio (en el navegador, cinco botones no hacían
 *   nada);
 * - abrir sin `noopener`;
 * - volver al plugin de Tauri, que lanza `xdg-open` con el entorno de la
 *   AppImage y no abre nada tras actualizar el sistema (21-oct-2026);
 * - fallar callado.
 */
const { invoke, toastError } = vi.hoisted(() => ({ invoke: vi.fn(), toastError: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("sonner", () => ({ toast: { error: toastError } }));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
  invoke.mockReset();
  toastError.mockReset();
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});

describe("abrir fuera", () => {
  it("en el navegador abre una pestaña sin acceso a la nuestra", async () => {
    const open = vi.fn();
    vi.stubGlobal("open", open);
    const { openExternal, isWeb } = await import("./platform");
    expect(isWeb).toBe(true);
    await openExternal("https://github.com/dwit/api");
    expect(open).toHaveBeenCalledWith("https://github.com/dwit/api", "_blank", "noopener,noreferrer");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("en el escritorio lo abre Rust, con el entorno limpio", async () => {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    const open = vi.fn();
    vi.stubGlobal("open", open);
    invoke.mockResolvedValue(undefined);
    const { openExternal, isTauri } = await import("./platform");
    expect(isTauri).toBe(true);
    await openExternal("https://github.com/dwit/api");
    expect(invoke).toHaveBeenCalledWith("open_url", { url: "https://github.com/dwit/api" });
    expect(open).not.toHaveBeenCalled();
  });

  it("si no se puede abrir, lo dice", async () => {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    invoke.mockRejectedValue("xdg-open failed (exit status: 127)");
    const { openExternal } = await import("./platform");
    await expect(openExternal("https://github.com/x")).rejects.toBe("xdg-open failed (exit status: 127)");
    expect(toastError).toHaveBeenCalledWith(expect.any(String), { description: "xdg-open failed (exit status: 127)" });
  });
});
