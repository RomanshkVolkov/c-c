import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * `copyText` en el escritorio va por el portapapeles de Tauri, que no pide
 * gesto: el webview de Linux rechaza `navigator.clipboard` en cuanto hubo una
 * espera entre el clic y la copia.
 */

const writeText = vi.fn(async (_t: string) => {});
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({ writeText: (t: string) => writeText(t) }));

const { copyText } = await import("@/lib/clipboard");

afterEach(() => {
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  writeText.mockClear();
  vi.unstubAllGlobals();
});

describe("copiar un texto que todavía no se tiene", () => {
  it("en el escritorio, por Tauri, con el texto ya resuelto", async () => {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    const nav = vi.fn();
    Object.assign(navigator, { clipboard: { writeText: nav, write: nav } });
    await copyText(Promise.resolve("https://cac.example/app/join#x"));
    expect(writeText).toHaveBeenCalledWith("https://cac.example/app/join#x");
    expect(nav).not.toHaveBeenCalled();
  });

  it("sin ClipboardItem, como siempre", async () => {
    vi.stubGlobal("ClipboardItem", undefined);
    const w = vi.fn(async () => {});
    Object.assign(navigator, { clipboard: { writeText: w } });
    await copyText("hola");
    expect(w).toHaveBeenCalledWith("hola");
  });
});
