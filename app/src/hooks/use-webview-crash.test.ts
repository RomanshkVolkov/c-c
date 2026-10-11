import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";

/**
 * Lo que la página hace al volver de que su proceso se muriera (10-oct-2026:
 * un vídeo tumbó WebKitWebProcess y quedó una pantalla en negro sin rastro).
 * Mutantes: no fichar; fichar sin sesión; la clave con los ids dentro
 * (duplicados); no avisar.
 */
const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock("@/lib/platform", () => ({ isTauri: true }));
const fileCrash = vi.fn(async () => "done");
vi.mock("@/lib/file-crash", async (orig) => ({
  ...(await orig<typeof import("@/lib/file-crash")>()),
  fileCrash: (...a: unknown[]) => fileCrash(...(a as [])),
}));
const warning = vi.fn();
vi.mock("sonner", () => ({ toast: { warning: (...a: unknown[]) => warning(...a) } }));

const { useWebviewCrash, rutaSinIds } = await import("./use-webview-crash");

const caida = (url: string) => ({ reason: "crashed", url, atMs: 0, count: 1 });

describe("al volver de que se muriera la página", () => {
  beforeEach(() => {
    invoke.mockReset();
    fileCrash.mockClear();
    warning.mockClear();
  });

  it("lo ficha en cac y lo dice", async () => {
    invoke.mockResolvedValue(caida("tauri://localhost/#/channels/0d8f3a9e-1111-4222-8333-444455556666"));
    renderHook(() => useWebviewCrash(true));
    await waitFor(() => expect(fileCrash).toHaveBeenCalledTimes(1));
    expect(invoke).toHaveBeenCalledWith("take_webview_crash");
    expect(warning).toHaveBeenCalledTimes(1);
    const arg = (fileCrash.mock.calls[0] as unknown as [{ title: string; key: string }])[0];
    expect(arg.title).toContain("crashed");
    expect(arg.title).toContain("#/channels/:id");
  });

  it("la misma caída en otro canal es la misma tarjeta", async () => {
    invoke.mockResolvedValueOnce(caida("tauri://localhost/#/channels/0d8f3a9e-1111-4222-8333-444455556666"));
    renderHook(() => useWebviewCrash(true));
    await waitFor(() => expect(fileCrash).toHaveBeenCalledTimes(1));
    invoke.mockResolvedValueOnce(caida("tauri://localhost/#/channels/aaaaaaaa-bbbb-4ccc-8ddd-eeeeffff0000?x=1"));
    renderHook(() => useWebviewCrash(true));
    await waitFor(() => expect(fileCrash).toHaveBeenCalledTimes(2));
    const [a, b] = fileCrash.mock.calls.map((c) => (c as unknown as [{ key: string }])[0].key);
    expect(a).toBe(b);
  });

  it("sin caída no hace nada", async () => {
    invoke.mockResolvedValue(null);
    renderHook(() => useWebviewCrash(true));
    await waitFor(() => expect(invoke).toHaveBeenCalled());
    await Promise.resolve();
    expect(fileCrash).not.toHaveBeenCalled();
    expect(warning).not.toHaveBeenCalled();
  });

  it("sin sesión no pregunta: lo deja para cuando la haya", () => {
    renderHook(() => useWebviewCrash(false));
    expect(invoke).not.toHaveBeenCalled();
  });

  it("la ruta pierde los ids y la consulta", () => {
    expect(rutaSinIds("tauri://localhost/#/tasks/0d8f3a9e-1111-4222-8333-444455556666/x?y=1")).toBe(
      "#/tasks/:id/x",
    );
    expect(rutaSinIds("http://tauri.localhost/servers/42/stats")).toBe("/servers/:n/stats");
  });
});
