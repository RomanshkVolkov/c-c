import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Abrir un enlace fuera de la app: el plugin de Tauri en escritorio, una
 * pestaña nueva en el navegador. Sin esto, cinco botones no hacían nada al
 * correr la interfaz en un navegador (el plugin rechaza sin Tauri). Mutantes:
 * usar siempre el plugin; abrir sin `noopener`.
 */
const { openUrl } = vi.hoisted(() => ({ openUrl: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl }));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
  openUrl.mockReset();
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
    expect(openUrl).not.toHaveBeenCalled();
  });

  it("en el escritorio usa el navegador del sistema", async () => {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    const open = vi.fn();
    vi.stubGlobal("open", open);
    const { openExternal, isTauri } = await import("./platform");
    expect(isTauri).toBe(true);
    await openExternal("https://github.com/dwit/api");
    expect(openUrl).toHaveBeenCalledWith("https://github.com/dwit/api");
    expect(open).not.toHaveBeenCalled();
  });
});
